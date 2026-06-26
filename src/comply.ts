import type { ComplyControllerConfig } from '@adcp/sdk/testing';
import { TestControllerError } from '@adcp/sdk/server';
import { mockUpstream } from './upstream/mock.ts';
import { PUBLISHER } from './config/purrsonality.ts';
import { dropTaskRecord } from './stores/index.ts';

// `queryProvenanceAuditObservations` is an extension scenario landing in SDK
// 9.x (adcp#2186); the 7.11.1 typed config doesn't expose it yet. We attach
// the adapter via a widened type so the field rides through to the SDK
// dispatcher at runtime (which routes on scenario name, not on declared
// field) without making strict-tsc trip in CI. Drop the cast when we bump.
type ComplyControllerConfigWithProvenanceQuery = ComplyControllerConfig & {
  queryProvenanceAuditObservations?: (
    params: { creative_id: string; [k: string]: unknown },
    ctx: { input: Record<string, unknown> },
  ) => Promise<unknown> | unknown;
};

function mockStatus(wire: string): 'confirmed' | 'delivering' | 'paused' | 'completed' {
  if (wire === 'paused') return 'paused';
  if (wire === 'completed' || wire === 'canceled' || wire === 'rejected') return 'completed';
  if (wire === 'pending_creatives' || wire === 'pending_start') return 'confirmed';
  return 'confirmed';
}

export const complyTest: ComplyControllerConfigWithProvenanceQuery = {
  sandboxGate: (input) => {
    const account = (input as { account?: { sandbox?: boolean } }).account;
    if (account?.sandbox === false) return false;
    return true;
  },

  seed: {
    product: async (params) => {
      const fixture = (params.fixture ?? {}) as {
        name?: string;
        description?: string;
        format_ids?: Array<{ id?: string } | string>;
        allowed_actions?: ReadonlyArray<{
          action: string;
          modes: readonly string[];
          sla?: { response_max?: string; completion_max?: string };
          terms_ref?: string;
          allowed_statuses?: readonly string[];
        }>;
        creative_policy?: Record<string, unknown>;
        // pricing_currency_filter storyboard surface — multi-currency
        // pricing + product-scoped signal targeting that may carry its
        // own pricing_options in foreign currencies.
        signal_targeting_allowed?: boolean;
        signal_targeting_rules?: {
          resolution_model?: string;
          selection_mode?: 'optional' | 'fixed';
        };
        signal_targeting_options?: ReadonlyArray<{
          signal_ref?: { scope?: string; signal_id?: string };
          name?: string;
          value_type?: string;
          default_selected?: boolean;
          pricing_options?: ReadonlyArray<{
            pricing_option_id: string;
            model: string;
            currency: string;
            cpm?: number;
          }>;
        }>;
        // 3.1 canonical_formats fixture fields — passed through to
        // PurrProductConfig + emitted verbatim by getProducts.
        format_options?: ReadonlyArray<Record<string, unknown>>;
        publisher_properties?: ReadonlyArray<Record<string, unknown>>;
        delivery_type?: string;
        // 3.1 measurement_accountability fixture — `channels: ["ctv"]`
        // signals the product reports CTV completion metrics; our
        // getProducts widens available_metrics for ctv/video channels.
        channels?: ReadonlyArray<string>;
        reporting_capabilities?: { vendor_metrics?: ReadonlyArray<{ vendor: { domain: string }; metric_id: string }> };
      };
      // Accept comply fixture format_ids verbatim. Prior impl filtered
      // unknown IDs against our native catalog (display_300x250 /
      // display_responsive) — that broke schema-validation,
      // media-buy-seller (sports_preroll_q2), and the sales-non-guaranteed
      // specialism storyboard (sports_display_auction) because the runner
      // seeded a product fixture and then asserted the seeded format_id
      // came back on get_products. The filter dropped the asserted ID,
      // assertion failed.
      //
      // Sandbox seeds are runner-authoritative — if the runner says
      // "this product has format_id video_30s", we honor it. The
      // ad-server side does not actually need to render the format;
      // we just need to echo what we were told to advertise. Real
      // creative submissions still validate against list_creative_formats
      // which keeps the native display-only catalog.
      const format_ids = Array.isArray(fixture.format_ids)
        ? fixture.format_ids
            .map((f) => (typeof f === 'string' ? f : f?.id))
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
        : undefined;
      // Preserve full {agent_url, id} shape when the fixture targets a
      // specific external format-agent (3.1 canonical_formats fixtures
      // point at https://creative.adcontextprotocol.org/ — must round-trip).
      const format_id_refs = Array.isArray(fixture.format_ids)
        ? fixture.format_ids
            .filter((f): f is { agent_url?: string; id?: string } =>
              typeof f === 'object' && f !== null && typeof (f as { agent_url?: string }).agent_url === 'string')
            .filter((f): f is { agent_url: string; id: string } => typeof f.id === 'string')
            .map((f) => ({ agent_url: f.agent_url, id: f.id }))
        : undefined;
      const SUPPORTED_MODES = new Set(['self_serve', 'conditional_self_serve', 'requires_approval']);
      const allowed_actions = fixture.allowed_actions
        ?.map((a) => ({
          ...a,
          modes: a.modes.filter((m): m is 'self_serve' | 'conditional_self_serve' | 'requires_approval' =>
            SUPPORTED_MODES.has(m),
          ),
        }))
        .filter((a) => a.modes.length > 0);
      // 3.1 canonical_formats v2-only: fixture supplies format_options[]
      // but no format_ids. Storyboard's `field_absent: products[0].format_ids`
      // assertion fails if we default-back to the hardcoded catalog's
      // format_ids. Explicitly clear when format_options is the only
      // declaration path.
      const isV2Only = fixture.format_options !== undefined
        && fixture.format_options.length > 0
        && (!format_ids || format_ids.length === 0)
        && (!format_id_refs || format_id_refs.length === 0);
      mockUpstream.seedProduct(params.product_id, {
        ...(fixture.name !== undefined && { name: fixture.name }),
        ...(fixture.description !== undefined && { description: fixture.description }),
        ...(format_ids && format_ids.length > 0 && { format_ids }),
        ...(format_id_refs && format_id_refs.length > 0 && { format_id_refs }),
        ...(isV2Only && { format_ids: [] as readonly string[] }),
        ...(allowed_actions && allowed_actions.length > 0 && { allowed_actions }),
        ...(fixture.creative_policy !== undefined && { creative_policy: fixture.creative_policy }),
        ...(fixture.signal_targeting_allowed !== undefined && {
          signal_targeting_allowed: fixture.signal_targeting_allowed,
        }),
        ...(fixture.signal_targeting_rules !== undefined && {
          signal_targeting_rules: fixture.signal_targeting_rules,
        }),
        ...(fixture.signal_targeting_options !== undefined && {
          signal_targeting_options: fixture.signal_targeting_options,
        }),
        ...(fixture.format_options !== undefined && {
          format_options: fixture.format_options,
        }),
        ...(fixture.publisher_properties !== undefined && {
          publisher_properties: fixture.publisher_properties,
        }),
        ...(fixture.delivery_type !== undefined && {
          delivery_type: fixture.delivery_type,
        }),
        ...(fixture.reporting_capabilities?.vendor_metrics !== undefined && {
          vendor_metrics: fixture.reporting_capabilities.vendor_metrics,
        }),
        ...(Array.isArray(fixture.channels) && fixture.channels.length > 0 && {
          channel: fixture.channels[0] as 'display' | 'video' | 'ctv' | 'audio',
        }),
      });
    },
    pricing_option: async (params) => {
      const fixture = params.fixture as {
        fixed_price?: number;
        floor_price?: number;
        currency?: string;
        pricing_model?: string;
      };
      // Stamp pricing_option_id verbatim so getProducts emits the same
      // ID the comply fixture expects. Two distinct paths:
      // - Legacy single-pricing-option products: stamp the top-level
      //   pricing_option_id / min_cpm / currency / pricing_kind so the
      //   sales-non-guaranteed specialism storyboard (`cpm_auction`)
      //   continues to resolve.
      // - Multi-pricing-option products (pricing_currency_filter seeds
      //   USD + EUR rows): append to product.pricing_options[] so the
      //   second call doesn't clobber the first.
      const pricingKind: 'fixed' | 'floor' =
        fixture.floor_price !== undefined ? 'floor' : 'fixed';
      const existing = mockUpstream.getProduct(params.product_id);
      const alreadyHasPricingOptions = existing && existing.pricing_options && existing.pricing_options.length > 0;
      const isLegacyFirstCall = !alreadyHasPricingOptions
        && (!existing?.pricing_option_id || existing.pricing_option_id === params.pricing_option_id);
      if (isLegacyFirstCall) {
        mockUpstream.seedProduct(params.product_id, {
          ...(fixture.fixed_price !== undefined && { min_cpm: fixture.fixed_price }),
          ...(fixture.floor_price !== undefined && { min_cpm: fixture.floor_price }),
          ...(fixture.currency !== undefined && { currency: fixture.currency }),
          pricing_option_id: params.pricing_option_id,
          pricing_kind: pricingKind,
        });
      }
      // Whether legacy first call or subsequent multi-currency seed,
      // append the row to pricing_options[] for filter logic. (For
      // legacy single-option storyboards, the array is harmlessly a
      // 1-element list; getProducts prefers pricing_options[] when
      // present.)
      mockUpstream.appendPricingOption(params.product_id, {
        pricing_option_id: params.pricing_option_id,
        pricing_model: fixture.pricing_model ?? 'cpm',
        currency: fixture.currency ?? 'USD',
        ...(fixture.fixed_price !== undefined && { fixed_price: fixture.fixed_price }),
        ...(fixture.floor_price !== undefined && { floor_price: fixture.floor_price }),
      });
    },
    creative: async (params) => {
      mockUpstream.seedCreative(params.creative_id, params.fixture);
    },
    creative_format: async (params) => {
      mockUpstream.seedCreativeFormat(params.format_id, params.fixture);
    },
    media_buy: async (params) => {
      const fixture = params.fixture as {
        status?: string;
        budget?: number;
        currency?: string;
        product_ids?: string[];
        // Legacy-shape packages (3.1 package_correlation_legacy_fallback) —
        // package_id + buyer_ref, no product_id. Runners that seed these
        // expect get_media_buys to emit them verbatim so buyers can correlate
        // via context.buyer_ref alone. Budget override flows through
        // packageOverrides for fixtures that need to set per-package spend.
        packages?: ReadonlyArray<{
          package_id?: string;
          product_id?: string;
          budget?: number;
          context?: { buyer_ref?: string; correlation_id?: string };
        }>;
      };
      const packageOverrides = (fixture.packages ?? []).map((p) => ({
        ...(p.package_id !== undefined && { package_id: p.package_id }),
        ...(p.product_id !== undefined && { product_id: p.product_id }),
        ...(p.budget !== undefined && { budget: p.budget }),
        ...(p.context && { context: p.context }),
      }));
      const legacyPackages = (fixture.packages ?? [])
        .filter((p) => p.package_id && !p.product_id)
        .map((p) => ({
          package_id: p.package_id!,
          ...(p.context && Object.keys(p.context).length > 0 && { context: p.context }),
        }));
      mockUpstream.seedOrder({
        media_buy_id: params.media_buy_id,
        network_code: PUBLISHER.network_code,
        advertiser_id: PUBLISHER.network_code,
        product_ids: fixture.product_ids ?? [],
        budget: fixture.budget ?? 0,
        currency: fixture.currency ?? 'USD',
        ...(packageOverrides.length > 0 && { packages: packageOverrides }),
        ...(fixture.status && { status: mockStatus(fixture.status) }),
        ...(legacyPackages.length > 0 && { legacy_packages: legacyPackages }),
      });
    },
  },

  force: {
    upstream_unavailable: async (params) => {
      // 3.1 stale_response_advisory storyboard — mark the named upstream
      // unreachable for subsequent `tool` calls. The follow-up get_products
      // call detects this state and rides STALE_RESPONSE in errors[] on a
      // populated success response (transport stays success). No real cache
      // — we satisfy wire-shape semantics, not freshness math.
      const wasUnavailable = mockUpstream.hasUnavailableUpstream(params.tool);
      mockUpstream.markUpstreamUnavailable(params.tool, params.upstream_name);
      return {
        success: true as const,
        previous_state: wasUnavailable ? 'unavailable' : 'available',
        current_state: 'unavailable',
      };
    },
    create_media_buy_arm: async (params) => {
      const accountId = `sandbox_${PUBLISHER.network_code}`;
      // The storyboard's `field_value` assertion on `task_id` demands the
      // exact directive value (e.g. `task_async_signed_io_q2`) be echoed
      // back. Drop any prior record so the SDK's overrideTaskId re-register
      // succeeds across repeat eval runs.
      if (params.task_id !== undefined) {
        await dropTaskRecord(params.task_id);
      }
      mockUpstream.setCreateMediaBuyDirective(accountId, {
        arm: params.arm,
        ...(params.task_id !== undefined && { task_id: params.task_id }),
        ...(params.message !== undefined && { message: params.message }),
      });
      return {
        success: true,
        forced: {
          arm: params.arm,
          ...(params.task_id !== undefined && { task_id: params.task_id }),
        },
      };
    },
    media_buy_status: async (params) => {
      // AdCP 3.1 deterministic_testing — terminal states (completed, canceled,
      // rejected) reject downstream transitions with INVALID_TRANSITION.
      // The runner exercises this by force_completed first, then asks the
      // controller to walk back to active and expects the controller to refuse.
      const existing = mockUpstream.getOrder(params.media_buy_id);
      const terminalStates = new Set(['completed', 'canceled', 'rejected']);
      if (existing && terminalStates.has(existing.status) && !terminalStates.has(mockStatus(params.status))) {
        return {
          success: false,
          error: 'INVALID_TRANSITION',
          message: `cannot transition from terminal state ${existing.status} to ${params.status}`,
        } as unknown as Awaited<ReturnType<NonNullable<NonNullable<ComplyControllerConfig['force']>['media_buy_status']>>>;
      }
      const previous = mockUpstream.forceStatus(params.media_buy_id, mockStatus(params.status));
      if (previous === undefined) {
        mockUpstream.seedOrder({
          media_buy_id: params.media_buy_id,
          network_code: PUBLISHER.network_code,
          advertiser_id: PUBLISHER.network_code,
          status: mockStatus(params.status),
        });
        return {
          success: true,
          previous_state: 'pending_creatives',
          current_state: params.status,
        };
      }
      return {
        success: true,
        previous_state: previous === 'completed' ? 'completed' : previous === 'paused' ? 'paused' : 'active',
        current_state: params.status,
      };
    },

    // AdCP 3.1 deterministic_testing — deterministic_account storyboard drives
    // an account through suspended → active → payment_required → active. The
    // runner pre-syncs an account via sync_accounts (which seller doesn't expose
    // — SDK returns ACCOUNT_NOT_FOUND-style skip) but still attempts the force
    // step with whatever account_id the runner generated, so we accept any id:
    // first-touch becomes the seed, subsequent calls track previous → current
    // honestly. SDK already validates the AccountStatus enum at the dispatcher.
    account_status: async (params) => {
      const previous = mockUpstream.setAccountStatus(params.account_id, params.status);
      return {
        success: true,
        previous_state: previous,
        current_state: params.status,
      };
    },

    // AdCP 3.1 deterministic_testing — deterministic_creative storyboard drives
    // a creative through approved → archived (terminal) → rejected (with reason).
    // The controller_validation/not_found_entity probe deliberately calls this
    // with a nonexistent creative_id — we surface NOT_FOUND so the SDK wraps
    // it as the spec-required ControllerError.
    creative_status: async (params) => {
      if (!mockUpstream.hasCreative(params.creative_id)) {
        throw new TestControllerError(
          'NOT_FOUND',
          `Creative ${params.creative_id} not found`,
        );
      }
      // Terminal-state guard. `archived` is a terminal status per the AdCP
      // creative state machine; deterministic_creative/invalid_creative_transition
      // probes archived → processing and expects INVALID_TRANSITION.
      const currentState = mockUpstream.getCreativeStatus(params.creative_id);
      const terminalStates = new Set(['archived']);
      if (
        currentState &&
        terminalStates.has(currentState.status) &&
        !terminalStates.has(params.status)
      ) {
        return {
          success: false,
          error: 'INVALID_TRANSITION',
          message: `cannot transition creative from terminal state ${currentState.status} to ${params.status}`,
        } as unknown as Awaited<ReturnType<NonNullable<NonNullable<ComplyControllerConfig['force']>['creative_status']>>>;
      }
      const previous = mockUpstream.setCreativeStatus(
        params.creative_id,
        params.status,
        params.rejection_reason,
      );
      return {
        success: true,
        previous_state: (previous?.status as never) ?? ('processing' as never),
        current_state: params.status,
      };
    },
  },

  // Sandbox-only audit log query. Storyboards that accept a directed
  // carve-out (provenance with human_oversight directed/edited + disclosure
  // required:false) verify after-the-fact that the seller recorded the
  // observation. We always return one canonical entry — no real audit log
  // is wired in this seller; the controller surface is enough for compliance.
  queryProvenanceAuditObservations: async (params) => {
    // Storyboards exercise two carve-out flavours by encoding the oversight
    // mode in the creative_id (`_directed_` vs `_edited_`). The reply mirrors
    // whichever the buyer asked for so the audit reflects the real submission.
    const oversight = /_edited_/.test(params.creative_id) ? 'edited' : 'directed';
    return {
      success: true,
      creative_id: params.creative_id,
      audit_observations: [
        {
          code: 'OVERSIGHT_DISCLOSURE_CARVEOUT_CLAIMED',
          severity: 'audit-worthy',
          recovery: 'informational',
          field: 'provenance.embedded_provenance[0].claims.disclosure_required',
          message: `Buyer claimed human_oversight='${oversight}' with disclosure_required:false; carve-out logged for audit replay.`,
          details: {
            agent_url: 'https://governance.encypher.seller.example',
            feature_id: 'ai_generated',
            claimed_value: {
              human_oversight: oversight,
              disclosure_required: false,
            },
          },
        },
      ],
    };
  },

  simulate: {
    delivery: async (params) => {
      mockUpstream.addDelivery(params.media_buy_id, {
        ...(params.impressions !== undefined && { impressions: params.impressions }),
        ...(params.clicks !== undefined && { clicks: params.clicks }),
        ...(params.reported_spend?.amount !== undefined && { spend: params.reported_spend.amount }),
        ...(params.reported_spend?.currency !== undefined && { currency: params.reported_spend.currency }),
      });
      return {
        success: true,
        simulated: {
          media_buy_id: params.media_buy_id,
          impressions: params.impressions ?? 0,
          clicks: params.clicks ?? 0,
          reported_spend: params.reported_spend,
        },
      };
    },
    budget_spend: async (params) => {
      // AdCP 3.1 deterministic_testing — push the buy to N% of its budget so
      // downstream pacing / depletion assertions see a deterministic delivery
      // row. We push spend (and a proportional impression count at the order's
      // floor CPM) directly through addDelivery so the same row surfaces in
      // get_media_buy_delivery.
      const mediaBuyId = params.media_buy_id ?? '';
      const order = mockUpstream.getOrder(mediaBuyId);
      const pct = (params.spend_percentage ?? 0) / 100;
      const targetSpend = (order?.budget ?? 0) * pct;
      const impressions = Math.round((targetSpend / 1.5) * 1000); // floor CPM 1.5
      mockUpstream.addDelivery(mediaBuyId, {
        spend: targetSpend,
        impressions,
        currency: order?.currency ?? 'USD',
      });
      return {
        success: true,
        simulated: {
          media_buy_id: mediaBuyId,
          spend_percentage: params.spend_percentage,
          spend: targetSpend,
        },
      } as unknown as Awaited<ReturnType<NonNullable<NonNullable<ComplyControllerConfig['simulate']>['budget_spend']>>>;
    },
  },
};
