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
    // Accept both `agent` and `operator` billing on sync_accounts. AAO comply
    // suite (notification_config_lifecycle, …) seeds accounts via the
    // acme-outdoor test-kit with `billing: "operator"`. Defaulting to
    // ['agent'] only made the runner mark sync_accounts as
    // BILLING_NOT_SUPPORTED, which cascaded `not_applicable` onto every
    // dependent storyboard. Both billing modes route to the same sandbox
    // account on this single-publisher reference impl.
    supportedBillings: ['agent', 'operator'] as const,
    // Override the SDK's derivation from `accountStore.resolution: 'explicit'`.
    // `require_operator_auth: true` semantically means "operators authenticate
    // independently with the seller via OAuth"; purrsonality has no operator
    // OAuth — the buyer's bearer principal is mapped 1:1 to the sandbox
    // account, so the buyer never needs a separate operator token. Setting
    // false is more accurate AND lifts the SDK runner's blanket-skip of
    // sync_accounts steps (see SDK runner.ts: when require_operator_auth=true
    // it grades every sync_accounts step as `not_applicable` for the
    // notification_config_lifecycle storyboard among others).
    requireOperatorAuth: false,
    config: null,
    // Advertise release-precision AdCP versions we speak. Slot landed in
    // SDK 9.0.0 via PR #2201 closing #2199. AAO comply runner gates
    // prerelease eval (compliance_target=3.1-rc) on this advertisement —
    // without it `evaluate_agent_quality` refuses with "(none advertised)".
    // We honour 3.0 (badge-eligible) AND 3.1-rc (SDK 9.x natively emits
    // the rc14 envelope shape with status / media_buy_status split).
    supported_versions: ['3.0', '3.1', '3.1-rc'] as const,
    // Compliance testing advertisement on `get_adcp_capabilities`. SDK 9.0+
    // emits seed_* scenarios via the live `list_scenarios` probe when the
    // corresponding seed adapters are wired in ComplyControllerConfig.seed
    // (see node_modules/@adcp/sdk/dist/lib/testing/comply-controller.js
    // `advertisedScenarios()`, lines 188–205). Our seed adapters cover
    // product, pricing_option, creative, creative_format, account, media_buy
    // (src/comply.ts). Advertise the full surface so AAO comply runners
    // unblock pagination_integrity, schema_validation, idempotency,
    // get-media-buys-pagination, media-buy-seller pending_creatives phases.
    compliance_testing: {
      scenarios: [
        'force_create_media_buy_arm',
        'force_media_buy_status',
        'force_account_status',
        'force_creative_status',
        'simulate_delivery',
        'simulate_budget_spend',
        'seed_product',
        'seed_pricing_option',
        'seed_creative',
        'seed_creative_format',
        'seed_account',
        'seed_media_buy',
      ] as const,
    },
    // 3.1 canonical_formats storyboards fire get_products with
    // buying_mode=wholesale. The SDK auto-derives buying_modes as
    // ["brief"] (never "wholesale") — AAO then classifies every
    // wholesale storyboard as `not_applicable` and Product Discovery
    // track collapses to SKIP. Declare wholesale explicitly here;
    // getProducts already handles wholesale requests by returning the
    // seeded catalog without brief-mode ranking.
    overrides: {
      media_buy: {
        buying_modes: ['brief', 'wholesale'] as const,
      },
    },
  },
  accounts: accountStore,
  sales,
});
