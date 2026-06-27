// Per-agent_url last-commitment tracker — persistent across restarts.
//
// The seller emits chained events for one agent_url (its own MCP base),
// so the chain state is a single string. We persist it to a small JSON
// file on disk so the chain link stays correct after process restarts.
//
// File location:
//   - env AUDIT_CHAIN_STATE_PATH if set
//   - otherwise ./.audit-chain-state.json (gitignored)
//
// Production should set AUDIT_CHAIN_STATE_PATH to a path on the Fly
// volume (e.g. /data/audit-chain-state.json) so the chain survives
// container restarts.
//
// Concurrency: AdCP's create/update_media_buy handlers run sequentially
// per-account on the SDK side, but two concurrent buys across different
// accounts can race here. We serialize updates with a per-process
// in-memory Promise queue. Cross-process synchronization is not needed
// in Phase A (single Fly machine).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ZERO_PREV } from './commitment.ts';

const STATE_PATH = process.env.AUDIT_CHAIN_STATE_PATH || './.audit-chain-state.json';

interface State {
  // map agent_url → last commitment hex
  by_agent: Record<string, string>;
}

let memCache: State | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadState(): Promise<State> {
  if (memCache) return memCache;
  try {
    const buf = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(buf) as State;
    if (typeof parsed.by_agent !== 'object' || parsed.by_agent === null) {
      throw new Error('malformed state file');
    }
    memCache = parsed;
  } catch (err: unknown) {
    // ENOENT or parse error → start fresh.
    memCache = { by_agent: {} };
  }
  return memCache;
}

async function persist(state: State): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true }).catch(() => undefined);
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Return the previous commitment to chain from for agent_url, or
 * ZERO_PREV if this is the agent's first event.
 */
export async function getPrevHash(agentUrl: string): Promise<string> {
  const state = await loadState();
  return state.by_agent[agentUrl] ?? ZERO_PREV;
}

/**
 * Advance the chain after a successful submit. Serialized via the
 * writeQueue so concurrent updates serialize and the file is never
 * corrupted by interleaved writes.
 */
export function advanceChain(agentUrl: string, commitment: string): Promise<void> {
  writeQueue = writeQueue
    .then(async () => {
      const state = await loadState();
      state.by_agent[agentUrl] = commitment;
      await persist(state);
    })
    .catch((err) => {
      // Swallow but log; subsequent submits will catch up.
      console.error('[audit/chain] persist failed:', err);
    });
  return writeQueue;
}

/**
 * Test/admin: clear all chain state. Used by tests and the seller's
 * wipePersistentTestState path. Not exposed to the wire.
 */
export async function resetChain(): Promise<void> {
  memCache = { by_agent: {} };
  await persist(memCache);
}
