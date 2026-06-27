// Submit-event emitter: builds the v1 event, signs it, posts to Veles
// submit_event, returns the proof_id to embed in the wire response.
//
// Hot-path budget: 200 ms. On timeout we synthesize a `pending` proof_id
// (the wire response still ships an audit_anchor field so buyers can
// detect intent), and a background retry is fire-and-forget. Production
// would persist pending events; Phase A's demo runs entirely on
// loopback so the timeout is essentially never hit.
//
// Errors that should NOT block the buyer (Veles unreachable, JWKS
// stale, anything below SIGNATURE_INVALID): emit a `pending` proof_id
// with the underlying reason logged. Errors that ARE the seller's
// fault (key misconfigured, schema invalid): throw so the handler can
// decide whether to fail the wire response.

import { commitment, hashAgentAccount, type Event } from './commitment.ts';
import { advanceChain, getPrevHash, resetChainHead } from './chain.ts';
import { loadAuditKey } from './keys.ts';
import { signEventJws } from './signing.ts';

// Veles' CHAIN_BROKEN error message format (from internal/mcp/tools.go):
//   `prev_event_hash = 0x… but last known commitment for this agent = 0x…`
// Parse out the "expected" head so the emitter can self-recover after a
// seller restart that wiped the in-memory chain cache.
const CHAIN_BROKEN_HEAD_RE = /last known commitment for this agent = (0x[0-9a-f]{64})/i;
function parseChainBrokenHead(message: string): string | null {
  const m = CHAIN_BROKEN_HEAD_RE.exec(message);
  return m ? m[1]! : null;
}

export interface EmitterConfig {
  velesURL: string; // e.g. https://veles.purrsonality.rocketscience.pl/mcp
  bearer?: string; // submit token, optional
  agentURL: string; // OUR mcp base (the seller's), included in the canonical event
  timeoutMs?: number;
}

export interface EmittedAnchor {
  attestor_url: string;
  event_commitment: string;
  proof_id: string;
  pending?: true;
}

export interface EmitOpts {
  eventType: 'create_media_buy' | 'update_media_buy';
  mediaBuyId: string;
  accountId: string; // plaintext; we hash here, Veles never sees it
  committedBudget: number; // minor units (e.g. cents)
  currency: string;
  createdAt?: string; // ISO 8601 UTC; defaults to now
}

const DEFAULT_TIMEOUT_MS = 200;

/**
 * Synchronously decide whether the seller can emit. Returns false
 * when no audit key is configured (dev / unconfigured deployments).
 * Callers should skip attaching audit_anchor in that case.
 */
export function canEmit(): boolean {
  return loadAuditKey() !== null;
}

/**
 * Build, sign, and submit one event. Returns the EmittedAnchor to
 * embed in the wire response. On hot-path timeout or transport error,
 * the returned anchor carries `pending: true` and a "pending" proof_id.
 */
export async function emitEvent(cfg: EmitterConfig, opts: EmitOpts): Promise<EmittedAnchor> {
  const createdAt = opts.createdAt ?? isoNow();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Try once; on CHAIN_BROKEN parse the expected head out of Veles' error,
  // advance local state to that head, and retry exactly once. Covers the
  // common case where seller's in-memory cache was reset (deploy/restart)
  // but the persistent backend was also empty (or stale) — Veles' head is
  // the authoritative pointer, so trusting it is the cheapest recovery.
  let result = await attempt(cfg, opts, createdAt, timeoutMs);
  if (result.kind === 'chain_broken' && result.expectedHead) {
    await resetChainHead(cfg.agentURL, result.expectedHead);
    result = await attempt(cfg, opts, createdAt, timeoutMs);
  }

  if (result.kind === 'ok') {
    await advanceChain(cfg.agentURL, result.commit);
    return {
      attestor_url: cfg.velesURL,
      event_commitment: result.commit,
      proof_id: `veles:1:${result.commit}`,
    };
  }

  // Pending path — kick off a background submit that may or may not
  // land, then ship the wire response immediately with a pending id.
  // Pending ids are namespaced ("pending:<commit>") so verify_proof
  // distinguishes them from confirmed ones.
  void backgroundSubmit(cfg, {
    agent_url: cfg.agentURL,
    event_commitment: result.commit,
    prev_event_hash: result.prevHash,
    signature: result.jws,
  }, result.commit);

  return {
    attestor_url: cfg.velesURL,
    event_commitment: result.commit,
    proof_id: `veles:1:pending:${result.commit}`,
    pending: true,
  };
}

type AttemptResult =
  | { kind: 'ok'; commit: string; prevHash: string; jws: string }
  | { kind: 'pending'; commit: string; prevHash: string; jws: string; reason: string }
  | { kind: 'chain_broken'; commit: string; prevHash: string; jws: string; expectedHead: string | null };

async function attempt(
  cfg: EmitterConfig,
  opts: EmitOpts,
  createdAt: string,
  timeoutMs: number,
): Promise<AttemptResult> {
  const prevHash = await getPrevHash(cfg.agentURL);
  const event: Event = {
    event_type: opts.eventType,
    attestor_schema_ver: 1,
    agent_url: cfg.agentURL,
    agent_account_hash: hashAgentAccount(opts.accountId),
    media_buy_id: opts.mediaBuyId,
    committed_budget: opts.committedBudget,
    currency: opts.currency.toUpperCase(),
    created_at: createdAt,
    prev_event_hash: prevHash,
  };
  const commit = commitment(event);
  const jws = signEventJws(event);

  const submitted = await submitWithTimeout(cfg, {
    agent_url: cfg.agentURL,
    event_commitment: commit,
    prev_event_hash: prevHash,
    signature: jws,
  }, timeoutMs);

  if (submitted.ok) return { kind: 'ok', commit, prevHash, jws };

  // Recognize Veles' CHAIN_BROKEN tool error: error message is
  // "CHAIN_BROKEN: prev_event_hash = … but last known commitment for this agent = …"
  if (submitted.reason.startsWith('CHAIN_BROKEN')) {
    const expectedHead = parseChainBrokenHead(submitted.reason);
    return { kind: 'chain_broken', commit, prevHash, jws, expectedHead };
  }
  return { kind: 'pending', commit, prevHash, jws, reason: submitted.reason };
}

interface SubmitParams {
  agent_url: string;
  event_commitment: string;
  prev_event_hash: string;
  signature: string;
}

async function submitWithTimeout(
  cfg: EmitterConfig,
  params: SubmitParams,
  timeoutMs: number,
): Promise<{ ok: true; proofId: string } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await postSubmit(cfg, params, controller.signal);
    return { ok: true, proofId: res.proof_id };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : 'unknown';
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function backgroundSubmit(cfg: EmitterConfig, params: SubmitParams, commit: string): Promise<void> {
  // 5s budget on the background path — generous, since no caller is
  // waiting. On success advance the chain so the NEXT emit picks up
  // where this one left off; on failure leave chain alone (the next
  // emit will retry from the prior known-good hash).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await postSubmit(cfg, params, controller.signal);
    await advanceChain(cfg.agentURL, commit);
  } catch (err: unknown) {
    console.error('[audit/emitter] background submit failed:', err);
  } finally {
    clearTimeout(timer);
  }
}

async function postSubmit(
  cfg: EmitterConfig,
  params: SubmitParams,
  signal: AbortSignal,
): Promise<{ proof_id: string; accepted_at?: string }> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'submit_event', arguments: params },
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.bearer) headers['Authorization'] = `Bearer ${cfg.bearer}`;
  const res = await fetch(cfg.velesURL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as {
    result?: { isError?: boolean; structuredContent?: { proof_id?: string; accepted_at?: string; status?: string; errors?: Array<{ code: string; message: string }> } };
    error?: { code: number; message: string };
  };
  if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  const sc = json.result?.structuredContent;
  if (json.result?.isError || sc?.status === 'failed') {
    const code = sc?.errors?.[0]?.code ?? 'UNKNOWN';
    const msg = sc?.errors?.[0]?.message ?? 'tool error';
    throw new Error(`${code}: ${msg}`);
  }
  if (!sc?.proof_id) throw new Error('response missing proof_id');
  return { proof_id: sc.proof_id, accepted_at: sc.accepted_at };
}

function isoNow(): string {
  // Strict YYYY-MM-DDTHH:MM:SSZ — no fractional seconds.
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return [
    d.getUTCFullYear(),
    '-', pad(d.getUTCMonth() + 1),
    '-', pad(d.getUTCDate()),
    'T', pad(d.getUTCHours()),
    ':', pad(d.getUTCMinutes()),
    ':', pad(d.getUTCSeconds()),
    'Z',
  ].join('');
}
