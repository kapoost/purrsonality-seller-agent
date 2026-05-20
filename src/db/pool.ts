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
  });
  return cached;
}

export async function closePool(): Promise<void> {
  if (cached) {
    await cached.end();
    cached = null;
  }
}
