/*
 * Persistent shadow of mockUpstream.orders. mockUpstream keeps a Map in
 * memory as the sync source of truth (dozens of call sites depend on the
 * synchronous getOrder/listOrders API). This module writes each order
 * through to Postgres and re-hydrates the Map on boot, so media buys +
 * their package assignments survive seller redeploys.
 *
 * All writes are fire-and-forget: the mock API stays synchronous, we log
 * on failure but never block a hot-path handler on the DB round-trip.
 * A brief window of divergence between memory and Postgres is acceptable
 * because the hydration step on boot is the only path that reads from
 * the DB shadow.
 */

import type { MockOrder } from '../upstream/mock.ts';
import { getPool, withRetry } from '../db/pool.ts';

export const ordersStore = {
  /* Fire-and-forget write. Never awaited from the mock API — mock stays
   * synchronous, we swallow errors after logging so a DB blip can't take
   * down the hot path. */
  persist(order: MockOrder | undefined | null): void {
    if (!order) return;
    const pool = getPool();
    if (!pool) return;
    void withRetry(async () => {
      await pool.query(
        `INSERT INTO mock_orders (order_id, network_code, data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (order_id) DO UPDATE SET
           network_code = EXCLUDED.network_code,
           data = EXCLUDED.data,
           updated_at = EXCLUDED.updated_at`,
        [order.order_id, order.network_code, JSON.stringify(order)],
      );
    }).catch((err) => {
      console.log('[orders-store] persist failed:', err instanceof Error ? err.message : String(err));
    });
  },

  /* Delete a snapshot when the caller has just removed the order from
   * memory. Same fire-and-forget semantics. */
  purge(orderId: string): void {
    const pool = getPool();
    if (!pool) return;
    void withRetry(async () => {
      await pool.query(`DELETE FROM mock_orders WHERE order_id = $1`, [orderId]);
    }).catch((err) => {
      console.log('[orders-store] purge failed:', err instanceof Error ? err.message : String(err));
    });
  },

  /* Load every persisted order and push it into the caller's Map. Called
   * once from index.ts before Bun.serve starts, so by the time the first
   * request lands the in-memory registry is populated. */
  async hydrate(target: Map<string, MockOrder>): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const res = await withRetry(async () => pool.query<{ order_id: string; data: MockOrder }>(
      `SELECT order_id, data FROM mock_orders ORDER BY updated_at ASC`,
    ));
    let count = 0;
    for (const row of res.rows) {
      target.set(row.order_id, row.data);
      count += 1;
    }
    return count;
  },
};
