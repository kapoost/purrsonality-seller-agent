// JWS compact serialization for audit events.
//
// Wire shape: `b64u(header).b64u(payload).b64u(sig)`.
// header = `{"alg":"EdDSA","kid":"<audit-kid>"}`
// payload = canonical event bytes (the bytes whose SHA-256 IS the commitment)
// sig = Ed25519 over the ASCII bytes of `header_b64.payload_b64`
//
// We use node:crypto's standalone `sign()` rather than KeyObject.sign
// because Ed25519's algorithm parameter is `null` per the Node API —
// the form `sign(null, data, privateKey)` is the canonical one.

import { sign } from 'node:crypto';
import { canonical, type Event } from './commitment.ts';
import { loadAuditKey } from './keys.ts';

/**
 * Sign an event and return the JWS compact string. Throws if the
 * audit key is not configured — call only after checking loadAuditKey().
 */
export function signEventJws(event: Event): string {
  const key = loadAuditKey();
  if (!key) throw new Error('AUDIT_PRIVATE_KEY_PEM not configured');

  const payloadBytes = canonical(event);
  const headerJson = JSON.stringify({ alg: 'EdDSA', kid: key.kid });
  const headerB64 = base64url(Buffer.from(headerJson, 'utf8'));
  const payloadB64 = base64url(Buffer.from(payloadBytes));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), key.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function base64url(b: Buffer): string {
  return b.toString('base64url');
}
