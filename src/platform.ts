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
    compliance_testing: {
      scenarios: [
        'force_media_buy_status',
        'simulate_delivery',
      ] as const,
    },
  },
  accounts: accountStore,
  sales,
});
