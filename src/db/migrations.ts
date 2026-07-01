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

// Creative library — persistent state for sync_creatives / list_creatives
// + operator review workflow (admin dashboard). Status follows AdCP
// /schemas/3.0.12/enums/creative-status.json:
//   processing | pending_review | approved | rejected | archived
// Sandbox principals auto-approve (storyboards expect this); live
// principals submit at pending_review and need an operator approve/reject
// via /api/creatives/:id/{approve,reject}.
const CREATIVES_MIGRATION = `
  CREATE TABLE IF NOT EXISTS creatives (
    creative_id TEXT PRIMARY KEY,
    account_id_hash TEXT,
    format_id JSONB NOT NULL,
    name TEXT,
    assets JSONB,
    status TEXT NOT NULL DEFAULT 'approved',
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    review_note TEXT
  );
  CREATE INDEX IF NOT EXISTS creatives_status_submitted_idx ON creatives (status, submitted_at DESC);
  CREATE INDEX IF NOT EXISTS creatives_account_idx ON creatives (account_id_hash);
  -- Persistent link creative→media_buy set by update_media_buy(
  -- creative_assignments). Impression attribution reads this instead of
  -- the in-memory mockUpstream orders map, so seller restarts don't
  -- silently reset delivery pulls to zero for buys whose creatives are
  -- still approved and being served.
  ALTER TABLE creatives ADD COLUMN IF NOT EXISTS assigned_media_buy_id TEXT;
  CREATE INDEX IF NOT EXISTS creatives_assigned_media_buy_idx ON creatives (assigned_media_buy_id);
`;

// Demo ad-server impression log — Phase A of "revive adserver" thread.
// Every GET /serve/<media_buy_id> writes one row with event_type='impression';
// every GET /click/<media_buy_id> writes one with event_type='click'. The
// admin dashboard reads counts per media_buy here and getMediaBuyDelivery
// prefers these real numbers over the synthetic delivery simulator when
// any rows exist for the requested buy.
const IMPRESSIONS_MIGRATION = `
  CREATE TABLE IF NOT EXISTS impressions (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    media_buy_id TEXT NOT NULL,
    creative_id TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN ('impression','click')),
    account_id_hash TEXT,
    user_agent TEXT,
    referrer TEXT
  );
  CREATE INDEX IF NOT EXISTS impressions_media_buy_ts_idx ON impressions (media_buy_id, ts DESC);
  CREATE INDEX IF NOT EXISTS impressions_event_ts_idx ON impressions (event_type, ts DESC);
`;

// Per-agent_url last-commitment chain head for the Veles audit emitter.
// Replaces the fs-based AUDIT_CHAIN_STATE_PATH which silently failed on
// Fly because seller's machine had no /data volume mount — every restart
// reset the chain to ZERO_PREV and Veles rejected with CHAIN_BROKEN.
const AUDIT_CHAIN_STATE_MIGRATION = `
  CREATE TABLE IF NOT EXISTS audit_chain_state (
    agent_url TEXT PRIMARY KEY,
    last_commitment TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
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
  await pool.query(CREATIVES_MIGRATION);
  await pool.query(IMPRESSIONS_MIGRATION);
  await pool.query(AUDIT_CHAIN_STATE_MIGRATION);
  console.log('[db] Migrations complete.');
}
