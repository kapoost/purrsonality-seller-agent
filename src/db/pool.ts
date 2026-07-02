import pg from 'pg';
import { loadEnv } from '../env.ts';

let cached: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  const env = loadEnv();
  if (!env.DATABASE_URL) return null;
  if (cached) return cached;
  cached = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Neon closes idle connections after ~5min; Fly's auto_stop=suspend
    // additionally freezes the whole machine, so any cached client can
    // wake up on the wrong side of a TCP RST. keepAlive nudges the OS
    // to send TCP keepalives so half-broken connections surface fast,
    // rather than hanging until pg-pool's connectionTimeoutMillis.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  // If any client in the pool emits `error` (typical after suspend/wake:
  // "Connection terminated due to connection timeout"), reset the cache
  // so the next getPool() rebuilds fresh connections. In-flight queries
  // still fail; `withRetry` below patches over that by re-running once.
  cached.on('error', () => {
    if (cached) {
      cached.end().catch(() => {});
      cached = null;
    }
  });
  return cached;
}

/* Run a pg query, retry ONCE on a connection-terminated error. Covers the
 * fly-suspend / neon-idle race where the first query after wake hits a
 * dead connection. Second attempt uses a freshly rebuilt pool because the
 * error handler above nulls the cache on the first failure. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retriable = /Connection terminated|ECONNRESET|Client has encountered a connection error|write EPIPE/i.test(msg);
    if (!retriable) throw err;
    // Ensure the cached pool is invalidated even if the error handler
    // hasn't fired yet (some pg errors bypass the pool-level listener).
    if (cached) {
      try { await cached.end(); } catch {}
      cached = null;
    }
    return await fn();
  }
}

export async function closePool(): Promise<void> {
  if (cached) {
    await cached.end();
    cached = null;
  }
}
