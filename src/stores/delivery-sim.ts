/*
 * Persistent shadow of mockUpstream's deliverySim map — the counters and
 * finality that comply_test_controller's simulate_delivery injects.
 *
 * Same contract as stores/orders.ts: the in-memory Map stays the synchronous
 * source of truth (the mock API is sync and has many call sites), this module
 * writes through to Postgres and re-hydrates on boot.
 *
 * Why it exists: finality used to live only in memory while everything else
 * the read path depends on had a durable shadow. A Fly suspend between the
 * controller's injection and the buyer's read dropped it, and the response
 * silently fell back to the lifecycle rule — reporting a provisional row for
 * a buy the runner had just marked final. Deterministic on two machines,
 * intermittent on one, and invisible either way.
 */

import { getPool, withRetry } from '../db/pool.ts';

export interface DeliverySimRow {
  impressions: number;
  clicks: number;
  spend: number;
  currency: string;
  is_final?: boolean;
  finalized_at?: string;
  measurement_window?: string;
  /* Counters captured at the moment finality was injected. The sandbox read
   * path otherwise recomputes impressions/spend from a pacing curve anchored
   * on now(), so a row stamped is_final: true kept moving between reads. */
  final_impressions?: number;
  final_clicks?: number;
  final_spend?: number;
}

export const deliverySimStore = {
  /* Fire-and-forget write. Never awaited from the mock API. */
  persist(mediaBuyId: string, row: DeliverySimRow): void {
    if (!getPool()) return;
    void withRetry(async () => {
      // Re-resolve inside the closure: withRetry ends the pool on first
      // failure, so a captured reference breaks on retry.
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO mock_delivery_sim (media_buy_id, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (media_buy_id) DO UPDATE SET
           data = EXCLUDED.data,
           updated_at = EXCLUDED.updated_at`,
        [mediaBuyId, JSON.stringify(row)],
      );
    }).catch((err) => {
      console.log('[delivery-sim-store] persist failed:', err instanceof Error ? err.message : String(err));
    });
  },

  purge(mediaBuyId: string): void {
    if (!getPool()) return;
    void withRetry(async () => {
      const pool = getPool();
      if (!pool) return;
      await pool.query(`DELETE FROM mock_delivery_sim WHERE media_buy_id = $1`, [mediaBuyId]);
    }).catch((err) => {
      console.log('[delivery-sim-store] purge failed:', err instanceof Error ? err.message : String(err));
    });
  },

  clearAll(): void {
    if (!getPool()) return;
    void withRetry(async () => {
      const pool = getPool();
      if (!pool) return;
      await pool.query(`DELETE FROM mock_delivery_sim`);
    }).catch((err) => {
      console.log('[delivery-sim-store] clearAll failed:', err instanceof Error ? err.message : String(err));
    });
  },

  async hydrate(target: Map<string, DeliverySimRow>): Promise<number> {
    if (!getPool()) return 0;
    const res = await withRetry(async () => {
      const pool = getPool();
      if (!pool) throw new Error('pool unavailable');
      return pool.query<{ media_buy_id: string; data: DeliverySimRow }>(
        `SELECT media_buy_id, data FROM mock_delivery_sim ORDER BY updated_at ASC`,
      );
    });
    let count = 0;
    for (const row of res.rows) {
      target.set(row.media_buy_id, row.data);
      count += 1;
    }
    return count;
  },
};
