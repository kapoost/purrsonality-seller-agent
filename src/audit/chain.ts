// Per-agent_url last-commitment tracker — persistent across restarts.
//
// Two backends, picked at module load:
//   1. **Postgres** (preferred) when DATABASE_URL is set — survives every
//      restart and every deploy. Uses the `audit_chain_state` migration.
//   2. **File** (fallback) at AUDIT_CHAIN_STATE_PATH or ./.audit-chain-state.json.
//      Used in dev / unit tests where there is no DB. NOTE: silently no-ops
//      when the parent dir is unwritable (e.g. `/data` on a Fly machine
//      without a mounted volume) — that footgun bit us in Phase A and is
//      exactly why the Postgres path exists.
//
// In-memory cache sits in front of both backends so the hot path is a Map
// lookup; writes are serialized per process.
//
// Concurrency: AdCP's create/update_media_buy handlers run sequentially
// per-account on the SDK side, but two concurrent buys across different
// accounts can race. We serialize updates with a per-process in-memory
// Promise queue. Cross-process synchronization isn't needed in Phase A
// (single Fly machine, single Postgres writer).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ZERO_PREV } from './commitment.ts';
import { getPool } from '../db/pool.ts';

const STATE_PATH = process.env.AUDIT_CHAIN_STATE_PATH || './.audit-chain-state.json';

interface FileState {
  // map agent_url → last commitment hex
  by_agent: Record<string, string>;
}

let memCache: Map<string, string> = new Map();
let memCacheLoaded = false;
let writeQueue: Promise<void> = Promise.resolve();

async function loadFileState(): Promise<FileState> {
  try {
    const buf = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(buf) as FileState;
    if (typeof parsed.by_agent !== 'object' || parsed.by_agent === null) {
      throw new Error('malformed state file');
    }
    return parsed;
  } catch {
    return { by_agent: {} };
  }
}

async function persistFile(state: FileState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true }).catch(() => undefined);
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function loadFromPostgres(): Promise<Map<string, string>> {
  const pool = getPool();
  if (!pool) throw new Error('no pool');
  const res = await pool.query<{ agent_url: string; last_commitment: string }>(
    'SELECT agent_url, last_commitment FROM audit_chain_state',
  );
  const m = new Map<string, string>();
  for (const row of res.rows) m.set(row.agent_url, row.last_commitment);
  return m;
}

async function ensureMemCache(): Promise<void> {
  if (memCacheLoaded) return;
  try {
    memCache = await loadFromPostgres();
  } catch {
    // Postgres not available — fall back to file.
    const state = await loadFileState();
    memCache = new Map(Object.entries(state.by_agent));
  }
  memCacheLoaded = true;
}

async function persistEntry(agentUrl: string, commitment: string): Promise<void> {
  const pool = getPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO audit_chain_state (agent_url, last_commitment, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (agent_url) DO UPDATE
           SET last_commitment = EXCLUDED.last_commitment, updated_at = NOW()`,
        [agentUrl, commitment],
      );
      return;
    } catch (err: unknown) {
      console.error('[audit/chain] postgres persist failed; falling back to file:', err);
    }
  }
  // File fallback. Mirrors memCache state to disk; no read-then-write race
  // since the queue serializes us. Failures are logged and swallowed —
  // memCache is still authoritative for the next request in this process.
  const state: FileState = { by_agent: Object.fromEntries(memCache) };
  await persistFile(state).catch((err) =>
    console.error('[audit/chain] file persist failed:', err),
  );
}

/**
 * Return the previous commitment to chain from for agent_url, or
 * ZERO_PREV if this is the agent's first event.
 */
export async function getPrevHash(agentUrl: string): Promise<string> {
  await ensureMemCache();
  return memCache.get(agentUrl) ?? ZERO_PREV;
}

/**
 * Advance the chain after a successful submit. Serialized via the
 * writeQueue so concurrent updates serialize and persistence isn't
 * corrupted by interleaved writes.
 */
export function advanceChain(agentUrl: string, commitment: string): Promise<void> {
  writeQueue = writeQueue
    .then(async () => {
      await ensureMemCache();
      memCache.set(agentUrl, commitment);
      await persistEntry(agentUrl, commitment);
    })
    .catch((err) => {
      console.error('[audit/chain] advance failed:', err);
    });
  return writeQueue;
}

/**
 * Recover from a Veles CHAIN_BROKEN response by setting our local state
 * to the commitment Veles reports as its current head. The emitter then
 * retries the submit with the corrected prev_event_hash. Used after a
 * seller restart that wiped in-memory state and the persistent backend
 * is unavailable (or the row was dropped offline).
 */
export function resetChainHead(agentUrl: string, commitment: string): Promise<void> {
  return advanceChain(agentUrl, commitment);
}

/**
 * Test/admin: clear all chain state. Used by tests and the seller's
 * wipePersistentTestState path. Not exposed to the wire.
 */
export async function resetChain(): Promise<void> {
  memCache = new Map();
  memCacheLoaded = true;
  const pool = getPool();
  if (pool) {
    await pool.query('DELETE FROM audit_chain_state').catch(() => undefined);
  }
  await persistFile({ by_agent: {} }).catch(() => undefined);
}
