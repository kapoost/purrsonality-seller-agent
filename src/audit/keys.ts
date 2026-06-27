// Audit Ed25519 key — loaded from env at startup.
//
// PER HODOR: separate key from the existing JWS request-signing key.
// AUDIT_PRIVATE_KEY_PEM lives in env (Fly secret in prod), never in
// the repo or on-disk config. When unset, the audit emitter is dormant
// (no audit_anchor on responses) — useful for local dev that doesn't
// run a Veles instance.
//
// Format: PEM-encoded PKCS#8 Ed25519 private key. Generate via
// `bun run scripts/gen-audit-key.ts`.

import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';

export interface AuditKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicRaw: Buffer; // 32-byte raw public key (for JWKS x field)
}

let cached: AuditKey | null | undefined; // undefined = not yet checked

/**
 * Load the audit key from env, or return null if unconfigured.
 *
 * Reads AUDIT_PRIVATE_KEY_PEM (the PEM blob) and AUDIT_KEY_ID (the kid
 * to advertise in JWKS and the JWS header). Returns null if either is
 * missing.
 */
export function loadAuditKey(): AuditKey | null {
  if (cached !== undefined) return cached;

  const pem = process.env.AUDIT_PRIVATE_KEY_PEM;
  const kid = process.env.AUDIT_KEY_ID;
  if (!pem || !kid) {
    cached = null;
    return null;
  }

  const privateKey = createPrivateKey({ key: pem, format: 'pem' });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`AUDIT_PRIVATE_KEY_PEM must be Ed25519, got ${privateKey.asymmetricKeyType}`);
  }
  const publicKey = createPublicKey(privateKey);

  // Node's KeyObject.export gives us the SPKI-wrapped public key in DER.
  // Strip the 12-byte SPKI header to get the raw 32-byte Ed25519 pubkey
  // that JWK `x` requires (RFC 8037 §2 — base64url of the raw key).
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  if (spkiDer.length !== 44) {
    throw new Error(`unexpected SPKI length ${spkiDer.length}; Ed25519 SPKI should be 44 bytes`);
  }
  const publicRaw = spkiDer.subarray(spkiDer.length - 32);

  cached = { kid, privateKey, publicKey, publicRaw };
  return cached;
}
