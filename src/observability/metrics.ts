// In-memory counters + duration tracking. Process-local — resets on restart.
// Periodic snapshot exported via logger; SIGUSR1 dumps on demand.
//
// Counter shape: { "tool_calls_total": { "get_products": 142, "create_media_buy": 27 } }
// Duration shape: { "tool_duration_ms": { "get_products": { count, sum, max, p50, p99 } } }

interface DurationBucket {
  count: number;
  sum_ms: number;
  max_ms: number;
  // Reservoir for percentile estimation. Bounded to keep memory predictable.
  samples: number[];
}

const RESERVOIR_CAP = 1000;

const counters = new Map<string, Map<string, number>>();
const durations = new Map<string, Map<string, DurationBucket>>();

function getCounterMap(metric: string): Map<string, number> {
  let m = counters.get(metric);
  if (!m) {
    m = new Map();
    counters.set(metric, m);
  }
  return m;
}

function getDurationMap(metric: string): Map<string, DurationBucket> {
  let m = durations.get(metric);
  if (!m) {
    m = new Map();
    durations.set(metric, m);
  }
  return m;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export const metrics = {
  /** Increment a counter labeled by a single dimension (typically tool name). */
  inc(metric: string, label: string, by = 1): void {
    const m = getCounterMap(metric);
    m.set(label, (m.get(label) ?? 0) + by);
  },

  /** Record a duration sample. */
  observe(metric: string, label: string, value_ms: number): void {
    const m = getDurationMap(metric);
    let bucket = m.get(label);
    if (!bucket) {
      bucket = { count: 0, sum_ms: 0, max_ms: 0, samples: [] };
      m.set(label, bucket);
    }
    bucket.count += 1;
    bucket.sum_ms += value_ms;
    if (value_ms > bucket.max_ms) bucket.max_ms = value_ms;
    if (bucket.samples.length < RESERVOIR_CAP) {
      bucket.samples.push(value_ms);
    } else {
      // Reservoir sampling — replace random slot
      const idx = Math.floor(Math.random() * bucket.count);
      if (idx < RESERVOIR_CAP) bucket.samples[idx] = value_ms;
    }
  },

  /** Serializable snapshot for log emission. */
  snapshot(): {
    counters: Record<string, Record<string, number>>;
    durations: Record<string, Record<string, { count: number; sum_ms: number; max_ms: number; avg_ms: number; p50_ms: number; p95_ms: number; p99_ms: number }>>;
    uptime_s: number;
    memory_mb: { rss: number; heap_used: number; heap_total: number };
  } {
    const c: Record<string, Record<string, number>> = {};
    for (const [metric, byLabel] of counters) {
      c[metric] = Object.fromEntries(byLabel);
    }
    const d: Record<string, Record<string, { count: number; sum_ms: number; max_ms: number; avg_ms: number; p50_ms: number; p95_ms: number; p99_ms: number }>> = {};
    for (const [metric, byLabel] of durations) {
      d[metric] = {};
      for (const [label, bucket] of byLabel) {
        const sorted = [...bucket.samples].sort((a, b) => a - b);
        d[metric][label] = {
          count: bucket.count,
          sum_ms: bucket.sum_ms,
          max_ms: bucket.max_ms,
          avg_ms: bucket.count > 0 ? Math.round(bucket.sum_ms / bucket.count) : 0,
          p50_ms: Math.round(percentile(sorted, 50)),
          p95_ms: Math.round(percentile(sorted, 95)),
          p99_ms: Math.round(percentile(sorted, 99)),
        };
      }
    }
    const mem = process.memoryUsage();
    return {
      counters: c,
      durations: d,
      uptime_s: Math.round(process.uptime()),
      memory_mb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heap_used: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total: Math.round(mem.heapTotal / 1024 / 1024),
      },
    };
  },
};
