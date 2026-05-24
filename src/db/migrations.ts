import {
  getAllAdcpMigrations,
} from '@adcp/sdk/server';
import { ADCP_STATE_MIGRATION } from '@adcp/sdk/server';
import { REPLAY_CACHE_MIGRATION } from '@adcp/sdk/signing/server';
import { getPool } from './pool.ts';

// Persistent metrics events for the admin dashboard. Each tool call writes
// one row asynchronously via metrics-store buffer (flush every 5s/100 events).
// Dashboard aggregates on-demand (no materialized counters — keeps schema
// simple and lets the dashboard pick any time window).
const METRICS_EVENTS_MIGRATION = `
  CREATE TABLE IF NOT EXISTS metrics_events (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tool TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    error_class TEXT,
    account_id_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS metrics_events_ts_idx ON metrics_events (ts DESC);
  CREATE INDEX IF NOT EXISTS metrics_events_tool_ts_idx ON metrics_events (tool, ts DESC);
`;

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
  await pool.query(METRICS_EVENTS_MIGRATION);
  console.log('[db] Migrations complete.');
}
