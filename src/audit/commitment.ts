// Veles event commitment — TypeScript implementation.
//
// MUST stay byte-identical with the Go canonicalizer at
// veles/internal/audit/commitment.go. The spec authority is
// veles/docs/event-commitment-spec.md; if you change anything here,
// run the parity test in tests/audit-parity.test.ts before committing.
//
// The v1 schema admits only flat objects with strings and non-negative
// integers — so a full RFC 8785 (JCS) implementation degenerates to:
//   1. emit keys in lexicographic order
//   2. no whitespace
//   3. JSON-escape strings per RFC 8785 §3.2.2.2 (NOT HTML-safe)
//   4. plain decimal integers
//   5. UTF-8 bytes
//
// JavaScript's JSON.stringify gives us (1)–(5) for free when we hand
// it an object with keys inserted in sorted order. The only divergence
// risk vs Go is HTML escaping — Go's encoding/json escapes <, >, & by
// default; we disabled that on the Go side with Encoder.SetEscapeHTML(false).
// JSON.stringify does not HTML-escape by default. Match.

import { createHash } from 'node:crypto';

export const SCHEMA_V1 = 1;

const ALLOWED_EVENT_TYPES = new Set<string>(['create_media_buy', 'update_media_buy']);

export const ZERO_PREV = '0x' + '0'.repeat(64);

export interface Event {
  event_type: 'create_media_buy' | 'update_media_buy';
  attestor_schema_ver: number;
  agent_url: string;
  agent_account_hash: string;
  media_buy_id: string;
  committed_budget: number;
  currency: string;
  created_at: string;
  prev_event_hash: string;
}

const HEX32_RE = /^0x[0-9a-f]{64}$/;
const ISO8601_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function validate(e: Event): void {
  if (!ALLOWED_EVENT_TYPES.has(e.event_type)) {
    throw new Error(`event_type "${e.event_type}" is not in v1 schema`);
  }
  if (e.attestor_schema_ver !== SCHEMA_V1) {
    throw new Error(`attestor_schema_ver must be ${SCHEMA_V1}, got ${e.attestor_schema_ver}`);
  }
  if (!e.agent_url) throw new Error('agent_url is required');
  if (!HEX32_RE.test(e.agent_account_hash)) {
    throw new Error('agent_account_hash must be 0x + 64 lowercase hex chars');
  }
  if (!e.media_buy_id) throw new Error('media_buy_id is required');
  if (!Number.isInteger(e.committed_budget) || e.committed_budget < 0) {
    throw new Error('committed_budget must be a non-negative integer (minor units)');
  }
  if (!CURRENCY_RE.test(e.currency)) {
    throw new Error('currency must be ISO 4217 uppercase alpha-3');
  }
  if (!ISO8601_UTC_RE.test(e.created_at)) {
    throw new Error('created_at must be ISO 8601 UTC of form YYYY-MM-DDTHH:MM:SSZ');
  }
  if (!HEX32_RE.test(e.prev_event_hash)) {
    throw new Error('prev_event_hash must be 0x + 64 lowercase hex chars');
  }
}

/**
 * Canonical bytes per the spec — UTF-8 encoded JSON with keys in
 * lex order and no whitespace. Throws if the event fails validation.
 */
export function canonical(e: Event): Uint8Array {
  validate(e);
  // Object literal with keys inserted in lex order — JSON.stringify
  // preserves insertion order, so this gives us sorted keys.
  // DO NOT rearrange these lines.
  const sorted = {
    agent_account_hash: e.agent_account_hash,
    agent_url: e.agent_url,
    attestor_schema_ver: e.attestor_schema_ver,
    committed_budget: e.committed_budget,
    created_at: e.created_at,
    currency: e.currency,
    event_type: e.event_type,
    media_buy_id: e.media_buy_id,
    prev_event_hash: e.prev_event_hash,
  };
  const jsonStr = JSON.stringify(sorted);
  return new TextEncoder().encode(jsonStr);
}

/**
 * Commitment — 0x + lowercase-hex SHA-256 of the canonical bytes.
 */
export function commitment(e: Event): string {
  const bytes = canonical(e);
  const hash = createHash('sha256').update(bytes).digest('hex');
  return '0x' + hash;
}

/**
 * Convenience: SHA-256 hex of a plaintext account_id, formatted as
 * the agent_account_hash field expects. Veles never sees the
 * plaintext — we hash before emission.
 */
export function hashAgentAccount(accountId: string): string {
  const trimmed = accountId.trim();
  const hash = createHash('sha256').update(trimmed, 'utf8').digest('hex');
  return '0x' + hash;
}
