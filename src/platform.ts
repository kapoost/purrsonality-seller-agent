import { definePlatform } from '@adcp/sdk/server';
import { accountStore, type PurrAccountMeta } from './handlers/accounts.ts';
import { sales } from './handlers/sales.ts';

export const platform = definePlatform<null, PurrAccountMeta>({
  capabilities: {
    // `signed-requests` dropped from declared specialisms 2026-06-20: AAO
    // comply runner tests negative vector 001 ("unsigned + required_for →
    // request_signature_required") for any agent declaring this specialism,
    // and our required_for: [] posture (Phase 1 trade-off for media_buy_seller
    // storyboards) means we can't return 401 on unsigned mutating ops.
    //
    // Code stays: RFC 9421 verifier is still wired in src/index.ts behind
    // signedRequests in createAdcpServerFromPlatform, so buyer agents that
    // OPT-IN to signing continue to authenticate that way as a second factor.
    // Discovery in /.well-known/adcp-capabilities.json reports
    // request_signing.supported: true via supported_for. We simply don't
    // advertise the comply-graded specialism. Honest signalling.
    //
    // Restore the original `['sales-non-guaranteed', 'signed-requests']` shape
    // when SDK 9.x lands per-account `required_for` predicates (mira's option
    // B from the humanMCP panel 2026-06-19) so live accounts require signing
    // and sandbox accounts (= AAO runner) skip the gate.
    specialisms: ['sales-non-guaranteed'] as const,
    channels: ['display'] as const,
    pricingModels: ['cpm'] as const,
    config: null,
    // Comply test controller advertisement. The SDK's `list_scenarios`
    // probe returns this list — AAO comply runners read it before each
    // storyboard and skip any storyboard whose required scenario is
    // missing (manifests as `fixture_seed_unsupported` cascades on
    // schema-validation, idempotency, get-media-buys-pagination,
    // media-buy-seller, sales-non-guaranteed). The prior hand-rolled
    // 2-entry list omitted every seed scenario even though src/comply.ts
    // wires them all — runner saw the agent advertise comply_test_controller
    // but reject every seed call.
    //
    // Mirror every adapter actually wired in src/comply.ts so the runner's
    // list_scenarios probe matches the dispatch surface exactly.
    compliance_testing: {
      scenarios: [
        // seed.* (src/comply.ts:32-130)
        'seed_product',
        'seed_pricing_option',
        'seed_creative',
        'seed_creative_format',
        'seed_media_buy',
        // force.* (src/comply.ts:146-258)
        'force_create_media_buy_arm',
        'force_media_buy_status',
        'force_account_status',
        'force_creative_status',
        // simulate.* (src/comply.ts:285-320)
        'simulate_delivery',
        'simulate_budget_spend',
        // adapter — sandbox-only provenance audit observation
        // (src/comply.ts:259)
        'query_provenance_audit_observations',
      ] as const,
    },
  },
  accounts: accountStore,
  sales,
});
