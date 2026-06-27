// Audit-key JWK publication.
//
// Returns the audit Ed25519 public key as a JWK (RFC 7517 / RFC 8037)
// suitable for inclusion in the seller's .well-known/jwks.json. The
// caller (src/signing.ts) merges this into `publicJwks` so the existing
// well-known/proxy.ts publication path picks it up unchanged.

import type { AdcpJsonWebKey } from '@adcp/sdk/signing/server';
import { loadAuditKey } from './keys.ts';

/**
 * Return the audit public key as a JWK, or null if no audit key is
 * configured (env vars unset).
 */
export function auditPublicJwk(): AdcpJsonWebKey | null {
  const key = loadAuditKey();
  if (!key) return null;
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    kid: key.kid,
    // `adcp_use` is the SDK's discriminator for which JWS verifier
    // consumes the key. Audit keys are NOT request-signing keys; we
    // mark them as such so the SDK's request-signing verifier ignores
    // them and only Veles' VerifyJWS picks them up.
    adcp_use: 'audit-attestor',
    key_ops: ['verify'],
    x: key.publicRaw.toString('base64url'),
  } as AdcpJsonWebKey;
}
