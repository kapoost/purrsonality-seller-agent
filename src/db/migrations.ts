import {
  getAllAdcpMigrations,
} from '@adcp/sdk/server';
import { ADCP_STATE_MIGRATION } from '@adcp/sdk/server';
import { REPLAY_CACHE_MIGRATION } from '@adcp/sdk/signing/server';
import { getPool } from './pool.ts';

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  if (!pool) {
    console.log('[db] DATABASE_URL not set — skipping Postgres migrations (in-memory mode)');
    return;
  }
  console.log('[db] Running AdCP SDK migrations...');
  await pool.query(getAllAdcpMigrations());
  await pool.query(ADCP_STATE_MIGRATION);
  await pool.query(REPLAY_CACHE_MIGRATION);
  console.log('[db] Migrations complete.');
}
