# `src/audit/` — Veles audit emitter

Hooks into the seller's `create_media_buy` / `update_media_buy`
handlers to emit a v1 commitment to a Veles attestor and embed the
resulting `audit_anchor` in the wire response.

Spec: [`veles/docs/event-commitment-spec.md`](../../../veles/docs/event-commitment-spec.md).

## Files

| File             | Role |
|------------------|------|
| `commitment.ts`  | Canonical RFC 8785-subset serialization + SHA-256. MUST stay byte-identical to Go. |
| `signing.ts`     | JWS compact (EdDSA) sign over canonical bytes. |
| `keys.ts`        | Load Ed25519 private/public from `AUDIT_PRIVATE_KEY_PEM`. |
| `jwks.ts`        | Export the audit public JWK so the well-known publisher includes it. |
| `emitter.ts`     | Build → sign → POST `submit_event`, with 200 ms hot-path budget. |
| `chain.ts`       | Persist last commitment per agent_url so chains survive restarts. |

## Env

| Var | Required | Notes |
|-----|----------|-------|
| `AUDIT_PRIVATE_KEY_PEM` | yes (to emit) | PKCS#8 PEM Ed25519. Generate via `bun run scripts/gen-audit-key.ts`. |
| `AUDIT_KEY_ID`          | yes (to emit) | The kid published in JWKS. Example: `audit-2026-06`. |
| `VELES_URL`             | yes (to emit) | Veles MCP base URL. Example: `https://veles.purrsonality.rocketscience.pl/mcp`. |
| `VELES_SUBMIT_TOKEN`    | optional      | Bearer token Veles checks on `submit_event`. Empty = unauth (dev). |
| `AUDIT_CHAIN_STATE_PATH`| optional      | Path to JSON file persisting `agent_url → last commitment`. Default `./.audit-chain-state.json`. Fly: set to `/data/audit-chain-state.json`. |

## Operational notes

- **Key rotation**: change `AUDIT_KEY_ID` AND `AUDIT_PRIVATE_KEY_PEM`
  together. Veles caches JWKS per `cfg.JWKS.CacheTTL` (default 10m),
  so the new kid becomes verifiable in at most one cache lifetime.
- **Replay protection**: Veles' SQLite enforces UNIQUE on
  `event_commitment`. A duplicate emit (e.g. retry after timeout)
  returns `{ duplicate: true }` — the seller should accept this as
  success.
- **Chain breakage**: if Veles returns `CHAIN_BROKEN`, the local
  chain state is out of sync (likely a restart with stale state).
  Recovery: query Veles for the last commitment (via a future
  `get_chain_head` tool) and reset `.audit-chain-state.json`.
- **Wire safety**: emitter NEVER throws into the buyer hot path. On
  any transport error it returns `pending: true` and fires a
  background retry.

## Testing

- `tests/audit-parity.test.ts` runs the 5 spec test vectors and asserts
  byte-identical canonical output + identical commitment hashes vs the
  Go reference. Hash drift fails this test before it ships.
- Local end-to-end against a live Veles: set the env above and curl a
  create_media_buy through the seller; inspect the response for
  `audit_anchor`; call `verify_proof` on Veles with the resulting
  `proof_id`.
