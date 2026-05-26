// Demo ad-server impression log — Phase A of the "revive adserver" thread.
//
// Records server-side impressions + clicks issued by /serve/<media_buy_id>
// and /click/<media_buy_id> public routes (see src/well-known/proxy.ts).
// Counts are pulled into:
//   - admin dashboard "Recently approved" panel (per-creative tally)
//   - getMediaBuyDelivery: prefer real numbers over simulator when present
//
// Phase A intentionally does NOT do:
//   - frequency capping (every open counts)
//   - pacing decisions (every open serves)
//   - viewability / fraud detection
// Live integration with purrsonality.pages.dev quiz page is Phase B.

import { getPool } from '../db/pool.ts';

export type ImpressionEventType = 'impression' | 'click';

interface RecordInput {
  media_buy_id: string;
  creative_id: string | null;
  event_type: ImpressionEventType;
  account_id_hash: string | null;
  user_agent?: string | null;
  referrer?: string | null;
}

export interface ImpressionStats {
  impressions: number;
  clicks: number;
  last_at: string | null;
}

const memory: Array<RecordInput & { id: number; ts: string }> = [];

export const impressionsStore = {
  async record(input: RecordInput): Promise<void> {
    const pool = getPool();
    if (!pool) {
      memory.push({ ...input, id: memory.length + 1, ts: new Date().toISOString() });
      return;
    }
    try {
      await pool.query(
        `INSERT INTO impressions (media_buy_id, creative_id, event_type, account_id_hash, user_agent, referrer)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.media_buy_id,
          input.creative_id,
          input.event_type,
          input.account_id_hash,
          input.user_agent ?? null,
          input.referrer ?? null,
        ],
      );
    } catch {
      // Drop on failure — adserver delivery must not block on logging.
    }
  },

  /** Aggregate per-media-buy counts. Cheap with the composite index. */
  async statsForMediaBuy(mediaBuyId: string): Promise<ImpressionStats> {
    const pool = getPool();
    if (!pool) {
      const rows = memory.filter((r) => r.media_buy_id === mediaBuyId);
      const last = rows[rows.length - 1];
      return {
        impressions: rows.filter((r) => r.event_type === 'impression').length,
        clicks: rows.filter((r) => r.event_type === 'click').length,
        last_at: last?.ts ?? null,
      };
    }
    const res = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type='impression')::int AS impressions,
         COUNT(*) FILTER (WHERE event_type='click')::int      AS clicks,
         MAX(ts)                                              AS last_at
       FROM impressions WHERE media_buy_id = $1`,
      [mediaBuyId],
    );
    const r = res.rows[0] ?? {};
    return {
      impressions: Number(r['impressions'] ?? 0),
      clicks: Number(r['clicks'] ?? 0),
      last_at: r['last_at'] instanceof Date ? (r['last_at'] as Date).toISOString() : null,
    };
  },

  /** Stats grouped by creative_id (used by admin "Recently approved" panel). */
  async statsForCreatives(ids: string[]): Promise<Record<string, ImpressionStats>> {
    const out: Record<string, ImpressionStats> = {};
    for (const id of ids) out[id] = { impressions: 0, clicks: 0, last_at: null };
    if (ids.length === 0) return out;
    const pool = getPool();
    if (!pool) {
      for (const row of memory) {
        if (!row.creative_id || !out[row.creative_id]) continue;
        if (row.event_type === 'impression') out[row.creative_id]!.impressions += 1;
        else out[row.creative_id]!.clicks += 1;
        out[row.creative_id]!.last_at = row.ts;
      }
      return out;
    }
    const res = await pool.query(
      `SELECT
         creative_id,
         COUNT(*) FILTER (WHERE event_type='impression')::int AS impressions,
         COUNT(*) FILTER (WHERE event_type='click')::int      AS clicks,
         MAX(ts)                                              AS last_at
       FROM impressions WHERE creative_id = ANY($1)
       GROUP BY creative_id`,
      [ids],
    );
    for (const r of res.rows) {
      out[String(r['creative_id'])] = {
        impressions: Number(r['impressions'] ?? 0),
        clicks: Number(r['clicks'] ?? 0),
        last_at: r['last_at'] instanceof Date ? (r['last_at'] as Date).toISOString() : null,
      };
    }
    return out;
  },

  /** Stats for many media buys at once (used by getMediaBuyDelivery). */
  async statsForMediaBuys(ids: string[]): Promise<Record<string, ImpressionStats>> {
    if (ids.length === 0) return {};
    const pool = getPool();
    if (!pool) {
      const out: Record<string, ImpressionStats> = {};
      for (const id of ids) {
        out[id] = await this.statsForMediaBuy(id);
      }
      return out;
    }
    const res = await pool.query(
      `SELECT
         media_buy_id,
         COUNT(*) FILTER (WHERE event_type='impression')::int AS impressions,
         COUNT(*) FILTER (WHERE event_type='click')::int      AS clicks,
         MAX(ts)                                              AS last_at
       FROM impressions WHERE media_buy_id = ANY($1)
       GROUP BY media_buy_id`,
      [ids],
    );
    const out: Record<string, ImpressionStats> = {};
    for (const id of ids) out[id] = { impressions: 0, clicks: 0, last_at: null };
    for (const r of res.rows) {
      out[String(r['media_buy_id'])] = {
        impressions: Number(r['impressions'] ?? 0),
        clicks: Number(r['clicks'] ?? 0),
        last_at: r['last_at'] instanceof Date ? (r['last_at'] as Date).toISOString() : null,
      };
    }
    return out;
  },
};
