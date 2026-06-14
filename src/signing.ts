// RFC 9421 request signing for the signed-requests specialism.
//
// Buyers signing mutating AdCP calls (create_media_buy, update_media_buy)
// land at the SDK's auto-wired verifier preTransport — we just supply
// the JWKS / replay / revocation stores and a public capability policy.
//
// JWKS includes the AdCP runner's standard test keypairs so the
// signed_requests storyboard grades against this instance out of the box.
// Production deployments rotate the resolver to a JWKS-over-HTTPS source
// pointed at buyer-counterparty keys.

import {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  PostgresReplayStore,
  StaticJwksResolver,
  type AdcpJsonWebKey,
  type ReplayStore,
  type VerifierCapability,
} from '@adcp/sdk/signing/server';
import { getPool } from './db/pool.ts';

// Public counterpart of the conformance runner's standard test keys
// (`compliance/cache/<v>/test-vectors/request-signing/keys.json`).
// Embedded here, not fetched, so storyboard runs are hermetic — the keys
// are public and rotated yearly by AdCP. Re-pin to the SDK's bundled
// vectors when the calendar suffix advances.
const TEST_KEYS: AdcpJsonWebKey[] = [
  {
    kid: 'test-ed25519-2026',
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    key_ops: ['verify'],
    adcp_use: 'request-signing',
    x: 'gWUqzATUcUco5Q8fZZXn8aWwb7DQbYGBiqUzLiSDDJo',
  },
  {
    kid: 'test-es256-2026',
    kty: 'EC',
    crv: 'P-256',
    alg: 'ES256',
    use: 'sig',
    key_ops: ['verify'],
    adcp_use: 'request-signing',
    x: 'vGSQmjzPN1txgDY-oBb108gMsRETA9J5IPxqlBczQOY',
    y: 'JGIbsHoOnHLL_LFqGYUW43BYDAqGYrNRZUylkE7rqSU',
  },
  // Parseable but revoked — negative vector 017 requires this key be
  // pre-revoked so the verifier rejects at step 9 (revocation check).
  {
    kid: 'test-revoked-2026',
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    key_ops: ['verify'],
    adcp_use: 'request-signing',
    x: 'r8wqMpVCLKzLSRNBtNmI1g71pPzQcwkATJHcyHK1lXg',
  },
];

export const jwksResolver = new StaticJwksResolver(TEST_KEYS);

// Wire-public JWKS exposed at /.well-known/jwks.json. Strips nothing —
// the keys above are already public-only (no `d` field). Used by buyer
// SDKs that prefer JWKS-over-HTTPS discovery over an inline test keypair.
export const publicJwks = { keys: TEST_KEYS } satisfies { keys: AdcpJsonWebKey[] };

// Replay cache: Postgres when DATABASE_URL is set (REPLAY_CACHE_MIGRATION
// is already applied in db/migrations.ts), in-memory otherwise. Both
// stores honor the same `(keyid, scope, nonce)` shape, so the verifier
// pipeline is identical.
function buildReplayStore(): ReplayStore {
  const pool = getPool();
  if (pool) return new PostgresReplayStore(pool);
  return new InMemoryReplayStore();
}

export const replayStore = buildReplayStore();

// Pre-revoke `test-revoked-2026` so the conformance runner's negative
// vector 017 fires at step 9 (revocation check). Production deployments
// switch to `HttpsRevocationStore` pointed at a CRL-style endpoint.
export const revocationStore = new InMemoryRevocationStore({
  issuer: 'https://purrsonality-seller.fly.dev/mcp',
  updated: new Date().toISOString(),
  next_update: new Date(Date.now() + 24 * 3600_000).toISOString(),
  revoked_kids: ['test-revoked-2026'],
  revoked_jtis: [],
});

// Discovery policy advertised in /.well-known/adcp-capabilities.json
// under `capabilities.request_signing`. Buyers cache this for 300s and
// decide whether to sign outbound calls. Keep `required_for` aligned
// with what the SDK actually enforces (defaults to MUTATING_TASKS — we
// don't narrow because every mutating tool here is a real state change).
// `required_for` lists ops that 401 when unsigned. We keep it tight to
// state-mutating buy lifecycle; `sync_creatives` accepts signatures but
// also tolerates bearer-only sandbox flows (the storyboard runner and
// our own e2e specs rely on the unsigned path).
export const requestSigningCapability: VerifierCapability = {
  supported: true,
  required_for: ['create_media_buy', 'update_media_buy'],
  supported_for: ['sync_creatives'],
  covers_content_digest: 'either',
};
