// Persistent metrics store — buffered async writes to Postgres.
//
// Why: in-memory metrics.ts vanishes on Fly auto-stop (scale-to-zero). This
// store survives restarts and lets the admin dashboard query arbitrary time
// windows (1h / 24h / 7d).
//
// Write path:  wrap.ts → recordEvent() → in-memory buffer → flush every 5s
//              or every 100 events, whichever first. Fire-and-forget;
//              failures logged, never thrown into tool call path.
//
// Read path:   queryMetrics(window) returns aggregated rows for dashboard.
//              Uses PERCENTILE_DISC for p50/p95/p99 (exact, no estimation).
//
// Retention:   pruneOld() deletes rows older than RETENTION_DAYS; called
//              from heartbeat (no separate cron).
//
// Degraded mode: if no Postgres (DATABASE_URL unset), record/flush become
//                no-ops. Dashboard /api/metrics/db returns 503.

import { getPool } from '../db/pool.ts';
import { log } from './logger.ts';

interface MetricEvent {
  ts: Date;
  tool: string;
  duration_ms: number;
  error_class: string | null;
  account_id_hash: string | null;
}

interface ToolAggregate {
  tool: string;
  calls: number;
  errors: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}

interface ErrorAggregate {
  tool: string;
  error_class: string;
  count: number;
}

export interface MetricsDbSnapshot {
  window: string;
  window_seconds: number;
  generated_at: string;
  total_calls: number;
  total_errors: number;
  tools: ToolAggregate[];
  errors: ErrorAggregate[];
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_THRESHOLD = 100;
const RETENTION_DAYS = 30;

let buffer: MetricEvent[] = [];
let flusherTimer: ReturnType<typeof setInterval> | null = null;
let inFlightFlush: Promise<void> | null = null;

export function recordEvent(evt: Omit<MetricEvent, 'ts'> & { ts?: Date }): void {
  const pool = getPool();
  if (!pool) return; // no-op in in-memory mode
  buffer.push({ ts: evt.ts ?? new Date(), ...evt });
  if (buffer.length >= FLUSH_BATCH_THRESHOLD) {
    void flush();
  }
}

export function startMetricsFlusher(): void {
  if (flusherTimer) return;
  if (!getPool()) {
    log.info('metrics_store_disabled', { reason: 'no_database_url' });
    return;
  }
  flusherTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
  // Ensure flush on graceful shutdown
  process.on('SIGTERM', () => void flush());
  process.on('SIGINT', () => void flush());
  log.info('metrics_store_started', {
    flush_interval_ms: FLUSH_INTERVAL_MS,
    batch_threshold: FLUSH_BATCH_THRESHOLD,
    retention_days: RETENTION_DAYS,
  });
}

async function flush(): Promise<void> {
  if (inFlightFlush) return inFlightFlush;
  if (buffer.length === 0) return;

  const pool = getPool();
  if (!pool) return;

  const batch = buffer;
  buffer = [];

  inFlightFlush = (async () => {
    try {
      // Build VALUES list: ($1,$2,$3,$4,$5), ($6,$7,...), ...
      const placeholders: string[] = [];
      const params: unknown[] = [];
      batch.forEach((e, i) => {
        const base = i * 5;
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
        params.push(e.ts, e.tool, e.duration_ms, e.error_class, e.account_id_hash);
      });
      const sql = `
        INSERT INTO metrics_events (ts, tool, duration_ms, error_class, account_id_hash)
        VALUES ${placeholders.join(', ')}
      `;
      await pool.query(sql, params);
    } catch (err) {
      log.error('metrics_flush_failed', {
        batch_size: batch.length,
        error: (err as Error).message?.slice(0, 200),
      });
      // Drop the batch — don't requeue indefinitely on persistent failures.
      // Recent in-memory metrics still cover the gap until DB recovers.
    } finally {
      inFlightFlush = null;
    }
  })();

  return inFlightFlush;
}

const WINDOW_INTERVALS: Record<string, { sql: string; seconds: number }> = {
  '1h':  { sql: "INTERVAL '1 hour'",  seconds: 3600 },
  '24h': { sql: "INTERVAL '24 hours'", seconds: 86_400 },
  '7d':  { sql: "INTERVAL '7 days'",  seconds: 604_800 },
};

export async function queryMetrics(windowKey: string): Promise<MetricsDbSnapshot | null> {
  const pool = getPool();
  if (!pool) return null;

  const win = WINDOW_INTERVALS[windowKey] ?? WINDOW_INTERVALS['24h']!;

  const toolSql = `
    SELECT
      tool,
      COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE error_class IS NOT NULL)::int AS errors,
      COALESCE(ROUND(AVG(duration_ms))::int, 0) AS avg_ms,
      COALESCE(PERCENTILE_DISC(0.5)  WITHIN GROUP (ORDER BY duration_ms)::int, 0) AS p50_ms,
      COALESCE(PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY duration_ms)::int, 0) AS p95_ms,
      COALESCE(PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY duration_ms)::int, 0) AS p99_ms,
      COALESCE(MAX(duration_ms), 0) AS max_ms
    FROM metrics_events
    WHERE ts >= NOW() - ${win.sql}
    GROUP BY tool
    ORDER BY calls DESC
  `;

  const errorSql = `
    SELECT tool, error_class, COUNT(*)::int AS count
    FROM metrics_events
    WHERE ts >= NOW() - ${win.sql} AND error_class IS NOT NULL
    GROUP BY tool, error_class
    ORDER BY count DESC
  `;

  const [toolRes, errRes] = await Promise.all([pool.query(toolSql), pool.query(errorSql)]);

  const tools = toolRes.rows as ToolAggregate[];
  const errors = errRes.rows as ErrorAggregate[];

  return {
    window: windowKey,
    window_seconds: win.seconds,
    generated_at: new Date().toISOString(),
    total_calls: tools.reduce((s, t) => s + t.calls, 0),
    total_errors: tools.reduce((s, t) => s + t.errors, 0),
    tools,
    errors,
  };
}

export interface AuditEvent {
  id: number;
  ts: string;
  tool: string;
  duration_ms: number;
  error_class: string | null;
  account_id_hash: string | null;
}

interface AuditQuery {
  windowKey: string;
  tool?: string;
  onlyErrors?: boolean;
  limit?: number;
}

export async function queryAuditEvents(q: AuditQuery): Promise<AuditEvent[] | null> {
  const pool = getPool();
  if (!pool) return null;

  const win = WINDOW_INTERVALS[q.windowKey] ?? WINDOW_INTERVALS['24h']!;
  const limit = Math.min(500, Math.max(1, q.limit ?? 100));

  // Parameterised dynamic filter — tool & errors clauses opt-in.
  const conds: string[] = [`ts >= NOW() - ${win.sql}`];
  const params: unknown[] = [];
  if (q.tool) {
    params.push(q.tool);
    conds.push(`tool = $${params.length}`);
  }
  if (q.onlyErrors) {
    conds.push(`error_class IS NOT NULL`);
  }
  params.push(limit);

  const sql = `
    SELECT id, ts, tool, duration_ms, error_class, account_id_hash
    FROM metrics_events
    WHERE ${conds.join(' AND ')}
    ORDER BY ts DESC
    LIMIT $${params.length}
  `;
  const res = await pool.query(sql, params);
  return res.rows.map((r: Record<string, unknown>) => ({
    id: Number(r['id']),
    ts: r['ts'] instanceof Date ? (r['ts'] as Date).toISOString() : String(r['ts']),
    tool: String(r['tool']),
    duration_ms: Number(r['duration_ms']),
    error_class: r['error_class'] == null ? null : String(r['error_class']),
    account_id_hash: r['account_id_hash'] == null ? null : String(r['account_id_hash']),
  }));
}

export async function pruneOld(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const res = await pool.query(
      `DELETE FROM metrics_events WHERE ts < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
    );
    return res.rowCount ?? 0;
  } catch (err) {
    log.error('metrics_prune_failed', { error: (err as Error).message?.slice(0, 200) });
    return 0;
  }
}

// Test-only — flush buffer synchronously and return.
export async function flushNow(): Promise<void> {
  await flush();
}
