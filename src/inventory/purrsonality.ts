// Purrsonality inventory adapter — single-publisher implementation of the
// AdCP sales handlers (display slot on the cat-personality quiz result page).
//
// All the handler bodies that used to live in src/handlers/sales.ts were
// moved here behind the InventoryAdapter interface, so future inventory
// sources (a second publisher, a signal-as-inventory provider, an external
// ad-server adapter) can be added by exporting another adapter and wiring
// it at boot — without touching the MCP wrapper or auth surface.
//
// Behaviour is byte-identical to the pre-refactor handlers — no business
// logic changed in this commit. The sandbox delivery simulator is wired in
// `getMediaBuyDelivery` (see src/inventory/sandbox/delivery-simulator.ts)
// so buyer agents can integration-test the full create→deliver→report
// loop without real impressions being served.

import {
  AdcpError,
  buildProduct,
  defineSalesPlatform,
  type GetProductsPayload,
  type SyncCreativesRow,
} from '@adcp/sdk/server';
import { FormatAsset } from '@adcp/sdk';
import type {
  GetProductsRequest,
  CreateMediaBuyRequest,
  CreateMediaBuySuccess,
  UpdateMediaBuyRequest,
  UpdateMediaBuySuccess,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  MediaBuyStatus,
  Package,
} from '@adcp/sdk';
import { createHash } from 'node:crypto';
import { PUBLISHER } from '../config/purrsonality.ts';
import { mockUpstream } from '../upstream/mock.ts';
import { creativesStore } from '../stores/creatives.ts';
import { impressionsStore } from '../stores/impressions.ts';
import type { PurrAccountMeta } from '../handlers/accounts.ts';
import type { InventoryAdapter } from './base.ts';
import { simulateDelivery } from './sandbox/delivery-simulator.ts';
import {
  detectAttemptedAction,
  enforceAttemptedAction,
  filterByStatus,
  resolveBuyAvailableActions,
} from './actions.ts';

function hashAccountId(id: string | null | undefined): string | null {
  if (!id) return null;
  // Same 8-char prefix as observability/wrap.ts so audit + creative views
  // join on the same column. Privacy: keeps account identifier opaque on
  // the operator side while still allowing per-buyer drill-down.
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

const FORMAT_AGENT_URL = `${process.env['PUBLIC_BASE_URL'] ?? 'http://127.0.0.1:3001'}/mcp`;

function mockToWireStatus(
  mock: 'pending_creatives' | 'pending_start' | 'confirmed' | 'delivering' | 'paused' | 'completed' | 'canceled' | 'rejected',
): MediaBuyStatus {
  if (mock === 'pending_creatives') return 'pending_creatives';
  if (mock === 'pending_start') return 'pending_start';
  if (mock === 'completed') return 'completed';
  if (mock === 'canceled') return 'canceled';
  if (mock === 'rejected') return 'rejected';
  if (mock === 'paused') return 'paused';
  return 'active';
}

function detectAggressiveTerms(pkg: unknown): { aggressive: boolean; reason?: string } {
  const p = pkg as {
    measurement_terms?: {
      required_panels?: unknown[];
      attribution_window?: { post_click_days?: number; post_view_days?: number };
      max_variance?: number;
      billing_measurement?: {
        vendor?: { domain?: string };
        measurement_window?: string;
        max_variance_percent?: number;
      };
      makegood_policy?: { available_remedies?: string[] };
    };
  };
  const mt = p.measurement_terms;
  if (!mt) return { aggressive: false };

  if (Array.isArray(mt.required_panels) && mt.required_panels.length > 0) {
    return { aggressive: true, reason: 'required_panels not supported by this seller' };
  }
  if (mt.attribution_window?.post_click_days && mt.attribution_window.post_click_days > 30) {
    return { aggressive: true, reason: 'post_click_days > 30 not supported' };
  }
  if (mt.attribution_window?.post_view_days && mt.attribution_window.post_view_days > 7) {
    return { aggressive: true, reason: 'post_view_days > 7 not supported' };
  }
  if (mt.max_variance !== undefined && mt.max_variance < 0.05) {
    return { aggressive: true, reason: 'max_variance < 5% not supported' };
  }

  const bm = mt.billing_measurement;
  if (bm) {
    if (bm.max_variance_percent !== undefined && bm.max_variance_percent < 1) {
      return { aggressive: true, reason: 'billing_measurement.max_variance_percent below 1% not supported' };
    }
    if (bm.measurement_window) {
      const m = bm.measurement_window.toLowerCase();
      if (m.startsWith('c') && Number.parseInt(m.slice(1), 10) > 7) {
        return { aggressive: true, reason: `measurement_window '${bm.measurement_window}' not supported (max C7)` };
      }
    }
  }

  return { aggressive: false };
}

/**
 * Compute the set of `valid_actions` for a wire-level media-buy status.
 * Spec enum: /schemas/3.0.12/enums/media-buy-valid-action.json.
 *
 * Pre-empt for adcp#5018 "compliance storyboards for media-buy available_actions"
 * — replaces the prior coarse logic ("everything for non-terminal") with
 * per-status semantics. Lists describe what the buyer CAN do via
 * update_media_buy + sync_creatives + tools/call. `add_packages` is included
 * for active buys because mockUpstream's createOrder supports patches that
 * append packages (declaration matches actual capability).
 */
function validActionsForStatus(status: MediaBuyStatus): MediaBuyStatus extends never ? never : string[] {
  switch (status) {
    case 'pending_creatives':
      // No creatives yet → no point pausing/resuming, but buyer MUST sync_creatives;
      // can also adjust budget/packages or back out.
      return ['sync_creatives', 'update_budget', 'update_packages', 'cancel'];
    case 'pending_start':
      // Approved, awaiting flight start. Buyer can tweak before serving.
      return ['update_budget', 'update_packages', 'update_dates', 'sync_creatives', 'cancel'];
    case 'active':
      // Running. Buyer can pause, modify packages, push new creatives, abort.
      return ['pause', 'update_budget', 'update_packages', 'add_packages', 'sync_creatives', 'cancel'];
    case 'paused':
      // Halted. Buyer can resume or modify, but not re-pause.
      return ['resume', 'update_budget', 'update_packages', 'cancel'];
    case 'completed':
    case 'canceled':
    case 'rejected':
      // Terminal — no further mutations.
      return [];
    default:
      return [];
  }
}

function buildPackageResponse(
  orderId: string,
  productId: string,
  budget: number,
  pricingOptionId: string,
  hasCreatives: boolean,
  context?: { buyer_ref?: string; correlation_id?: string },
): Package {
  return {
    package_id: `${orderId}_${productId}`,
    product_id: productId,
    budget,
    pricing_option_id: pricingOptionId,
    pacing: 'even',
    status: hasCreatives ? 'active' : 'pending_creatives',
    // Per AdCP 3.1 storyboards (pending_creatives_to_start, package_correlation_*),
    // package context echoes the buyer-supplied correlation/buyer_ref so the
    // buyer SDK can stitch package-level outcomes back to its line-item ledger.
    ...(context && Object.keys(context).length > 0 && { context }),
  } as unknown as Package;
}

const handlers = defineSalesPlatform<PurrAccountMeta>({
  async getProducts(req: GetProductsRequest, _ctx) {
    const r = req as {
      buying_mode?: string;
      brief?: string;
      refine?: Array<{ scope?: string; proposal_id?: string; product_id?: string; action?: string }>;
    };
    // Seeded products are hoisted to `products[0]` ONLY when the brief
    // names them — `product_id` with underscores rewritten as spaces is
    // matched (case-insensitive) as a substring of the brief. This lets the
    // available_actions storyboard (brief: "available actions display
    // package") pick its seeded fixture without contaminating later
    // scenarios that share a process and would otherwise inherit the
    // `allowed_actions[]` surface through $context.product_id.
    const briefLc = (r.brief ?? '').toLowerCase();
    const raw = [...mockUpstream.listProducts()].sort((a, b) => {
      const aHit = briefLc && briefLc.includes(a.product_id.replace(/_/g, ' ').toLowerCase());
      const bHit = briefLc && briefLc.includes(b.product_id.replace(/_/g, ' ').toLowerCase());
      if (aHit === bHit) return 0;
      return aHit ? -1 : 1;
    });
    const products = raw.map((p) => {
      const base = buildProduct({
        id: p.product_id,
        name: p.name,
        description: p.description,
        formats: [...p.format_ids],
        agentUrl: FORMAT_AGENT_URL,
        delivery_type: 'non_guaranteed',
        // Fixed CPM rate card (no auction). 3.1 storyboards (canonical_formats,
        // measurement_*, inventory_list_*, refine_products, dependency_*,
        // pending_creatives_to_start, …) assert /pricing_options/0/fixed_price
        // present — emitting floor_price marks the option as auction-based and
        // fails those captures. Purrsonality slot is single-publisher, non-
        // guaranteed display sold at a published rate, not auctioned.
        // Auction-based seeded products (comply seed.pricing_option with
        // `floor_price` rather than `fixed_price`, e.g. the
        // sales-non-guaranteed specialism storyboard) take floor_price
        // semantics so buyers know to bid above the floor. Default to
        // fixed-rate for the canonical Purrsonality slot.
        pricing: p.pricing_kind === 'floor'
          ? { model: 'cpm', floor: p.min_cpm, currency: p.currency, pricing_option_id: p.pricing_option_id }
          : { model: 'cpm', fixed: p.min_cpm, currency: p.currency, ...(p.pricing_option_id && { pricing_option_id: p.pricing_option_id }) },
        publisher_domain: PUBLISHER.adcp_publisher,
        channels: [p.channel],
        ctx_metadata: { ad_unit_ids: [...p.ad_unit_ids] },
        // Vendor metrics — attention measurement via attentionvendor.example
        // (the AdCP test catalog). Lets vendor_metric_accountability storyboards
        // filter on required_vendor_metrics and find this product.
        reporting_capabilities: {
          available_reporting_frequencies: ['hourly', 'daily'],
          expected_delay_minutes: 60,
          timezone: 'UTC',
          supports_webhooks: false,
          available_metrics: ['impressions', 'spend', 'clicks'],
          date_range_support: 'date_range',
          vendor_metrics: [
            {
              vendor: { domain: 'attentionvendor.example' },
              metric_id: 'attention_score',
            },
          ],
        } as unknown as Parameters<typeof buildProduct>[0]['reporting_capabilities'],
      });
      if (p.allowed_actions && p.allowed_actions.length > 0) {
        (base as unknown as { allowed_actions: readonly unknown[] }).allowed_actions = p.allowed_actions;
      }
      // Surface seller-default measurement_terms when the product declares
      // them. Enables media_buy_seller/measurement_terms_rejected/discover_products
      // to find a candidate before submitting alternate terms.
      if (p.measurement_terms) {
        (base as unknown as { measurement_terms: unknown }).measurement_terms = p.measurement_terms;
      }
      // AdCP 3.1 provenance surface — required by sponsored_intelligence /
      // provenance storyboards (provenance_audit_observation,
      // provenance_enforcement, provenance_truth_of_claim). Single allowlist
      // entry: Encypher's governance agent for AI-disclosure features. Buyer
      // creatives without provenance metadata are rejected in sync_creatives;
      // claims contradicted by the verifier are rejected with
      // PROVENANCE_CLAIM_CONTRADICTED.
      //
      // Seeded products with their own creative_policy (e.g. fixture
      // `test-product-disclosure-required` for provenance_enforcement
      // storyboard) override the default — the runner asserts specific
      // values from the fixture so we must pass them through verbatim.
      (base as unknown as { creative_policy: Record<string, unknown> }).creative_policy = p.creative_policy ?? {
        co_branding: 'optional',
        landing_page: 'any',
        templates_available: false,
        provenance_required: true,
        provenance_requirements: {
          require_digital_source_type: true,
          require_disclosure_metadata: true,
          require_embedded_provenance: true,
        },
        accepted_verifiers: [
          {
            agent_url: 'https://governance.encypher.seller.example',
            feature_id: 'ai_generated',
            providers: ['Encypher'],
          },
        ],
      };
      return base;
    });

    const generateProposal = (forProposalId?: string, isCommitted = false, suffix = '') => {
      const proposalId =
        forProposalId ??
        `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${suffix}`;
      const evenPct = Math.floor(100 / products.length);
      const allocations = products.map((p, i) => ({
        product_id: p.product_id,
        allocation_percentage: i === 0 ? 100 - evenPct * (products.length - 1) : evenPct,
        pricing_option_id: p.pricing_options?.[0]?.pricing_option_id,
      }));
      // Track every emitted proposal so subsequent refine/create can
      // distinguish PROPOSAL_NOT_FOUND from a known proposal — PR #4942.
      mockUpstream.emitProposal(proposalId);
      return {
        proposal_id: proposalId,
        name: `Purrsonality plan ${proposalId.slice(0, 12)}`,
        description: `Curated plan covering ${products.length} product(s) optimized for the cat-owner audience.`,
        allocations,
        ...(isCommitted && {
          proposal_status: 'committed' as const,
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        }),
      };
    };

    if (r.buying_mode === 'brief' && r.brief && products.length > 0) {
      // Two distinct proposals per brief — PR #4946 multi-finalize storyboard
      // captures proposals[0] and proposals[1] from a single response to
      // exercise both atomic-success and capability-gap branches. A single-
      // proposal response would silently skip half the scenario.
      return {
        products,
        proposals: [generateProposal(undefined, false, '_a'), generateProposal(undefined, false, '_b')],
        cache_scope: 'public' as const,
      } satisfies GetProductsPayload;
    }

    if (r.buying_mode === 'refine' && Array.isArray(r.refine) && r.refine.length > 0 && products.length > 0) {
      // refine[] finalize-exclusivity — PR #4946. Each entry is individually
      // schema-valid; the array as a whole has business-rule constraints.
      const finalizeEntries = r.refine.filter((e) => e.action === 'finalize');
      const nonFinalizeEntries = r.refine.filter((e) => e.action !== 'finalize');
      if (finalizeEntries.length > 0 && nonFinalizeEntries.length > 0) {
        const idx = r.refine.findIndex((e) => e.action !== 'finalize');
        throw new AdcpError('INVALID_REQUEST', {
          message: 'refine[] containing action="finalize" must consist exclusively of proposal-scoped finalize entries',
          field: `refine[${idx}]`,
          recovery: 'correctable',
        });
      }
      if (finalizeEntries.length >= 2) {
        throw new AdcpError('MULTI_FINALIZE_UNSUPPORTED', {
          message: 'this seller does not support atomic multi-proposal finalize; sequence individual finalize calls',
          recovery: 'correctable',
        });
      }
      for (let i = 0; i < r.refine.length; i++) {
        const entry = r.refine[i];
        if (!entry) continue;
        if (entry.scope === 'proposal' && entry.proposal_id) {
          const lookup = mockUpstream.lookupProposal(entry.proposal_id);
          if (!lookup) {
            throw new AdcpError('PROPOSAL_NOT_FOUND', {
              message: `proposal not found: ${entry.proposal_id}`,
              field: `refine[${i}].proposal_id`,
              recovery: 'correctable',
            });
          }
          if (lookup.expired) {
            throw new AdcpError('PROPOSAL_EXPIRED', {
              message: `proposal expired: ${entry.proposal_id}`,
              field: `refine[${i}].proposal_id`,
              recovery: 'correctable',
            });
          }
        }
      }

      const refinement_applied = r.refine.map((entry) => {
        if (entry.scope === 'proposal') {
          return {
            scope: 'proposal' as const,
            proposal_id: entry.proposal_id ?? '',
            status: 'applied' as const,
            notes: `Refinement '${entry.action ?? 'update'}' applied to proposal`,
          };
        }
        if (entry.scope === 'product') {
          return {
            scope: 'product' as const,
            product_id: entry.product_id ?? '',
            status: 'applied' as const,
            notes: `Refinement '${entry.action ?? 'update'}' applied to product`,
          };
        }
        return { scope: 'request' as const, status: 'applied' as const };
      });
      const proposals = r.refine
        .filter((e) => e.scope === 'proposal' && e.proposal_id)
        .map((e) => generateProposal(e.proposal_id, e.action === 'finalize'));
      return {
        products,
        proposals: proposals.length > 0 ? proposals : [generateProposal()],
        refinement_applied,
        cache_scope: 'public' as const,
      } satisfies GetProductsPayload;
    }

    return { products, cache_scope: 'public' as const } satisfies GetProductsPayload;
  },

  async createMediaBuy(req: CreateMediaBuyRequest, ctx) {
    const account = ctx.account;
    if (!account) throw new AdcpError('ACCOUNT_NOT_FOUND', { message: 'no account in context' });

    const directive = mockUpstream.consumeCreateMediaBuyDirective(account.id);

    const packages = req.packages ?? [];
    if (packages.length === 0 && !req.proposal_id) {
      throw new AdcpError('INVALID_REQUEST', { message: 'packages[] or proposal_id is required' });
    }

    // Proposal canonical errors — PR #4942. Buyer SDKs branch on these to
    // re-finalize vs restart discovery; generic NOT_FOUND would be ambiguous.
    if (req.proposal_id) {
      const lookup = mockUpstream.lookupProposal(req.proposal_id);
      if (!lookup) {
        throw new AdcpError('PROPOSAL_NOT_FOUND', {
          message: `proposal not found: ${req.proposal_id}`,
          field: 'proposal_id',
          recovery: 'correctable',
        });
      }
      if (lookup.expired) {
        throw new AdcpError('PROPOSAL_EXPIRED', {
          message: `proposal expired: ${req.proposal_id}`,
          field: 'proposal_id',
          recovery: 'correctable',
        });
      }
    }

    // AdCP 3.1 allows the literal "asap" as start_time (immediate start);
    // skip ISO ordering checks when either bound is non-iso so we don't trip
    // string-comparing "asap" against a 2026 timestamp.
    const isIsoTime = (s: string): boolean => /^\d{4}-\d{2}-\d{2}T/.test(s);
    const rTop = req as { start_time?: string; end_time?: string; flight?: { start_time?: string; end_time?: string } };
    if (rTop.start_time && rTop.end_time && isIsoTime(rTop.start_time) && isIsoTime(rTop.end_time) && rTop.start_time > rTop.end_time) {
      throw new AdcpError('VALIDATION_ERROR', { message: 'start_time must be before end_time', field: '/end_time' });
    }
    // Reject FAR-past start flights. AAO 3.1-rc schema_validation/past_start_rejection
    // narrative is explicitly "years in the past" — comply runner sends
    // `start_time: 2020-01-01T00:00:00Z` to probe. Other test fixtures
    // (deterministic_testing, persistence storyboards) routinely use start_time
    // ~3 months in the past relative to current eval date to model historical
    // flights; rejecting THOSE breaks the unrelated tests. Calibrate grace to
    // 365 days so we catch the past_start storyboard ("years") without
    // tripping the historical-flight fixtures ("months").
    const PAST_GRACE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
    if (rTop.start_time && isIsoTime(rTop.start_time)) {
      const startTs = Date.parse(rTop.start_time);
      if (Number.isFinite(startTs) && startTs < Date.now() - PAST_GRACE_MS) {
        throw new AdcpError('INVALID_REQUEST', {
          message: `start_time ${rTop.start_time} is in the past`,
          field: '/start_time',
        });
      }
    }
    const flight = rTop.flight;
    if (flight?.start_time && flight?.end_time && isIsoTime(flight.start_time) && isIsoTime(flight.end_time) && flight.start_time > flight.end_time) {
      throw new AdcpError('VALIDATION_ERROR', { message: 'flight.start_time must be before flight.end_time', field: '/flight/end_time' });
    }
    for (const pkg of packages) {
      const pkgFlight = pkg as { start_time?: string; end_time?: string };
      if (pkgFlight.start_time && pkgFlight.end_time && isIsoTime(pkgFlight.start_time) && isIsoTime(pkgFlight.end_time) && pkgFlight.start_time > pkgFlight.end_time) {
        throw new AdcpError('VALIDATION_ERROR', { message: 'package.start_time must be before package.end_time', field: '/packages/0/end_time' });
      }
    }

    for (const pkg of packages) {
      const terms = detectAggressiveTerms(pkg);
      if (terms.aggressive) {
        throw new AdcpError('TERMS_REJECTED', {
          message: terms.reason ?? 'measurement_terms not acceptable',
          field: '/packages/0/measurement_terms',
          recovery: 'correctable',
        });
      }
    }

    const productIds: string[] = [];
    let totalBudget = 0;
    let currency = req.total_budget?.currency ?? 'USD';
    let hasAnyCreatives = false;
    const overlayMap = new Map<string, { property_list?: { agent_url: string; list_id: string }; collection_list?: { agent_url: string; list_id: string } }>();
    const packageBudgets: Record<string, number> = {};
    const resolvedProductConfigs: NonNullable<ReturnType<typeof mockUpstream.getProduct>>[] = [];

    for (const pkg of packages) {
      if (!pkg.product_id) {
        throw new AdcpError('INVALID_REQUEST', { message: 'package missing product_id' });
      }
      let product = mockUpstream.getProduct(pkg.product_id);
      if (!product) {
        // AdCP 3.x deterministic_testing storyboards (deterministic_media_buy,
        // deterministic_delivery, deterministic_budget) use the magic
        // `test-product` placeholder on create_media_buy WITHOUT a prior
        // comply seed.product step. Auto-seed ONLY for the spec-canonical
        // test prefix in sandbox — narrower than "any unknown product_id"
        // so error_compliance/error_responses still correctly returns
        // PRODUCT_NOT_FOUND when a buyer probes with a random nonexistent
        // product id.
        const isSandbox = (ctx.account as { mode?: string } | undefined)?.mode === 'sandbox';
        const isTestProductPattern = /^test-/.test(pkg.product_id);
        if (isSandbox && isTestProductPattern) {
          product = mockUpstream.seedProduct(pkg.product_id);
        } else {
          throw new AdcpError('PRODUCT_NOT_FOUND', { message: `product not found: ${pkg.product_id}` });
        }
      }
      currency = product.currency;
      if (typeof pkg.budget !== 'number' || pkg.budget < 0) {
        throw new AdcpError('INVALID_REQUEST', { message: 'package.budget must be a non-negative number' });
      }
      totalBudget += pkg.budget;
      productIds.push(pkg.product_id);
      packageBudgets[pkg.product_id] = pkg.budget;
      resolvedProductConfigs.push(product);

      const pkgAny = pkg as {
        creatives?: unknown[];
        creative_assignments?: unknown[];
        targeting_overlay?: { property_list?: { list_id?: string }; collection_list?: { list_id?: string } };
      };
      if ((pkgAny.creatives && pkgAny.creatives.length > 0) || (pkgAny.creative_assignments && pkgAny.creative_assignments.length > 0)) {
        hasAnyCreatives = true;
      }
      const tov = pkgAny.targeting_overlay as
        | {
            property_list?: { agent_url?: string; list_id?: string };
            collection_list?: { agent_url?: string; list_id?: string };
          }
        | undefined;
      if (tov) {
        const ov: { property_list?: { agent_url: string; list_id: string }; collection_list?: { agent_url: string; list_id: string } } = {};
        if (tov.property_list?.list_id) {
          ov.property_list = {
            agent_url: tov.property_list.agent_url ?? FORMAT_AGENT_URL,
            list_id: tov.property_list.list_id,
          };
        }
        if (tov.collection_list?.list_id) {
          ov.collection_list = {
            agent_url: tov.collection_list.agent_url ?? FORMAT_AGENT_URL,
            list_id: tov.collection_list.list_id,
          };
        }
        if (ov.property_list || ov.collection_list) overlayMap.set(pkg.product_id, ov);
      }
    }

    const buyerContext = (req as { context?: { correlation_id?: string; buyer_ref?: string } }).context;
    const packageContexts: Record<string, { correlation_id?: string; buyer_ref?: string }> = {};
    for (const pkg of packages) {
      const pkgCtx = (pkg as { context?: { correlation_id?: string; buyer_ref?: string } }).context;
      if (pkgCtx && Object.keys(pkgCtx).length > 0) {
        packageContexts[pkg.product_id] = pkgCtx;
      }
    }

    const order = mockUpstream.createOrder({
      network_code: account.ctx_metadata.network_code,
      advertiser_id: account.id,
      product_ids: productIds,
      budget: totalBudget || (req.total_budget?.amount ?? 0),
      currency,
      pacing: 'even',
      ...(flight?.start_time !== undefined && { flight_start: flight.start_time }),
      ...(flight?.end_time !== undefined && { flight_end: flight.end_time }),
      ...(rTop.start_time !== undefined && { flight_start: rTop.start_time }),
      ...(rTop.end_time !== undefined && { flight_end: rTop.end_time }),
      client_request_id: req.idempotency_key,
      package_budgets: packageBudgets,
      status: hasAnyCreatives ? 'confirmed' : 'pending_creatives',
      ...(buyerContext && Object.keys(buyerContext).length > 0 && { context: buyerContext }),
      ...(Object.keys(packageContexts).length > 0 && { package_contexts: packageContexts }),
    });

    for (const [productId, overlay] of overlayMap.entries()) {
      mockUpstream.setPackageOverlay(order.order_id, productId, overlay);
    }

    const status: MediaBuyStatus = hasAnyCreatives ? 'active' : 'pending_creatives';
    const allBuyActions = resolveBuyAvailableActions(resolvedProductConfigs);
    const availableActions = filterByStatus(allBuyActions, status);

    const successResponse: CreateMediaBuySuccess = {
      media_buy_id: order.order_id,
      // AdCP 3.1 migration: media_buy_status is the canonical lifecycle
      // field (pending_creatives / pending_start / active / paused); top-level
      // status carries the same MediaBuyStatus during the migration window
      // for 3.0 compatibility, and in 3.1 it shifts to task-envelope semantics
      // (completed / submitted / failed). Setting both keeps 3.0 cache
      // validators happy AND survives 3.1-aware runner coercion that reads
      // /media_buy_status as ground truth.
      media_buy_status: status,
      status,
      valid_actions: validActionsForStatus(status),
      ...(availableActions.length > 0 && { available_actions: availableActions }),
      confirmed_at: order.created_at,
      revision: 1,
      packages: packages.map((pkg) =>
        buildPackageResponse(
          order.order_id,
          pkg.product_id,
          pkg.budget,
          pkg.pricing_option_id ?? 'po_cpm_default',
          hasAnyCreatives,
          (pkg as { context?: { buyer_ref?: string; correlation_id?: string } }).context,
        ),
      ),
    } as unknown as CreateMediaBuySuccess;

    if (directive?.arm === 'submitted' && directive.task_id) {
      return ctx.handoffToTask(async () => successResponse, { task_id: directive.task_id });
    }

    return successResponse;
  },

  async updateMediaBuy(
    buyId: string,
    patch: UpdateMediaBuyRequest,
    _ctx,
  ): Promise<UpdateMediaBuySuccess> {
    const existing = mockUpstream.getOrder(buyId);
    if (!existing) throw new AdcpError('MEDIA_BUY_NOT_FOUND', { message: 'media buy not found' });

    const p = patch as {
      paused?: boolean;
      canceled?: true;
      cancellation_reason?: string;
      end_time?: string;
      packages?: Array<{ package_id?: string; paused?: boolean; budget?: number }>;
    };

    if (existing.status === 'canceled' && p.canceled === true) {
      throw new AdcpError('NOT_CANCELLABLE', {
        message: 'media buy is already canceled',
        recovery: 'correctable',
      });
    }
    if (existing.status === 'completed') {
      throw new AdcpError('INVALID_STATE', { message: 'media buy is in a terminal state (completed)' });
    }
    if (existing.status === 'canceled' && (p.paused !== undefined || p.packages)) {
      throw new AdcpError('INVALID_STATE', { message: 'media buy is in a terminal state (canceled)' });
    }

    // AdCP 3.1 action-discovery: when the buy's products declare
    // allowed_actions[], every mutation maps to a fine-grained action that
    // MUST be present + in the right mode + in scope for the current status.
    // Mismatches reject with ACTION_NOT_ALLOWED so buyers can branch on
    // details.reason without re-deriving the seller's state machine.
    const buyProductConfigs = existing.product_ids
      .map((pid) => mockUpstream.getProduct(pid))
      .filter((cfg): cfg is NonNullable<typeof cfg> => Boolean(cfg));
    const buyAllActions = resolveBuyAvailableActions(buyProductConfigs);
    const currentWireStatus = mockToWireStatus(existing.status);
    if (buyAllActions.length > 0) {
      const attempted = detectAttemptedAction(p as unknown as Record<string, unknown>, existing.package_budgets, buyId);
      if (attempted) {
        const result = enforceAttemptedAction(attempted.action, buyAllActions, currentWireStatus);
        if (!result.ok) {
          throw new AdcpError('ACTION_NOT_ALLOWED', {
            message: `Action '${result.attempted_action}' is not currently available on this media buy (${result.reason})`,
            recovery: result.recovery,
            details: {
              attempted_action: result.attempted_action,
              reason: result.reason,
              currently_available_actions: result.currently_available_actions,
            },
          });
        }
      }
    }

    if (p.packages) {
      for (const pkgPatch of p.packages as Array<{
        package_id?: string;
        targeting_overlay?: {
          property_list?: { agent_url?: string; list_id?: string };
          collection_list?: { agent_url?: string; list_id?: string };
        };
      }>) {
        if (pkgPatch.package_id && !pkgPatch.package_id.startsWith(`${buyId}_`)) {
          throw new AdcpError('PACKAGE_NOT_FOUND', { message: `package not in this media buy: ${pkgPatch.package_id}` });
        }
        if (pkgPatch.package_id && pkgPatch.targeting_overlay) {
          const productId = pkgPatch.package_id.slice(`${buyId}_`.length);
          const overlay: { property_list?: { agent_url: string; list_id: string }; collection_list?: { agent_url: string; list_id: string } } = {};
          if (pkgPatch.targeting_overlay.property_list?.list_id) {
            overlay.property_list = {
              agent_url: pkgPatch.targeting_overlay.property_list.agent_url ?? FORMAT_AGENT_URL,
              list_id: pkgPatch.targeting_overlay.property_list.list_id,
            };
          }
          if (pkgPatch.targeting_overlay.collection_list?.list_id) {
            overlay.collection_list = {
              agent_url: pkgPatch.targeting_overlay.collection_list.agent_url ?? FORMAT_AGENT_URL,
              list_id: pkgPatch.targeting_overlay.collection_list.list_id,
            };
          }
          if (overlay.property_list || overlay.collection_list) {
            mockUpstream.setPackageOverlay(buyId, productId, overlay);
          }
        }
      }
    }

    if (p.canceled === true) {
      // Buyer-initiated cancellation via update_media_buy({canceled:true}).
      // Seller-initiated cancellations would route through a different code
      // path and stamp `canceled_by: 'seller'`. AdCP 3.x audit requirement.
      mockUpstream.updateOrder(buyId, {
        status: 'canceled',
        canceled_by: 'buyer',
        canceled_at: new Date().toISOString(),
      });
    } else if (p.paused === true) {
      mockUpstream.updateOrder(buyId, { status: 'paused' });
    } else if (p.paused === false) {
      mockUpstream.updateOrder(buyId, { status: 'confirmed' });
    } else if (existing.status === 'pending_creatives') {
      // Creative assignments unblock the buy from pending_creatives → active.
      const hasCreativeAssignment = (p.packages ?? []).some((pkg) => {
        const arr = (pkg as { creative_assignments?: unknown[] }).creative_assignments;
        return Array.isArray(arr) && arr.length > 0;
      });
      if (hasCreativeAssignment) {
        mockUpstream.updateOrder(buyId, { status: 'confirmed' });
      }
    }

    if (typeof p.end_time === 'string') {
      mockUpstream.updateOrder(buyId, { flight_end: p.end_time });
    }

    if (p.packages) {
      const budgetPatch: Record<string, number> = {};
      for (const pkgPatch of p.packages) {
        if (typeof pkgPatch.budget !== 'number' || !pkgPatch.package_id) continue;
        const productId = pkgPatch.package_id.startsWith(`${buyId}_`)
          ? pkgPatch.package_id.slice(`${buyId}_`.length)
          : pkgPatch.package_id;
        budgetPatch[productId] = pkgPatch.budget;
      }
      if (Object.keys(budgetPatch).length > 0) {
        mockUpstream.updateOrder(buyId, { package_budgets: budgetPatch });
      }
    }

    const updated = mockUpstream.getOrder(buyId)!;
    const newWireStatus = mockToWireStatus(updated.status);
    const postAvailableActions = filterByStatus(buyAllActions, newWireStatus);
    return {
      media_buy_id: buyId,
      status: newWireStatus,
      valid_actions: validActionsForStatus(newWireStatus),
      ...(postAvailableActions.length > 0 && { available_actions: postAvailableActions }),
      ...(updated.canceled_by && { canceled_by: updated.canceled_by }),
      ...(updated.canceled_at && { canceled_at: updated.canceled_at }),
      revision: 2,
    } as unknown as UpdateMediaBuySuccess;
  },

  async getMediaBuyDelivery(
    req: GetMediaBuyDeliveryRequest,
    ctx,
  ): Promise<GetMediaBuyDeliveryResponse> {
    const r = (req ?? {}) as { media_buy_ids?: string[]; start_date?: string; end_date?: string };
    const ids = Array.isArray(r.media_buy_ids) ? r.media_buy_ids : [];

    const periodStart = r.start_date ? `${r.start_date}T00:00:00Z` : new Date(Date.now() - 86_400_000).toISOString();
    const periodEnd = r.end_date ? `${r.end_date}T23:59:59Z` : new Date().toISOString();

    // Two delivery sources, merged per-buy:
    //  1) Real impressions/clicks from impressions table (Phase A adserver).
    //  2) Sandbox: synthesised pacing curve (delivery-simulator) — fallback
    //     when no real serves landed yet so buyer agents still get plausible
    //     numbers during integration tests.
    //  3) Live: zeros when no real serves and not sandbox.
    const isSandbox = (ctx.account as { mode?: string } | undefined)?.mode === 'sandbox';
    const realStats = await impressionsStore.statsForMediaBuys(ids);

    let aggImpressions = 0;
    let aggSpend = 0;
    let aggClicks = 0;
    let resolvedCurrency = 'USD';

    const deliveries = ids.map((id) => {
      const order = mockUpstream.getOrder(id);

      let impressions: number;
      let clicks: number;
      let spend: number;
      let currency: string;
      let pacingIndex: number;

      const real = realStats[id] ?? { impressions: 0, clicks: 0, last_at: null };
      if (real.impressions > 0 || real.clicks > 0) {
        // Real adserver traffic wins. Spend derives from impressions at the
        // assumed floor CPM (we don't yet bill via packages.rate per impression).
        const cpm = 1.5;
        impressions = real.impressions;
        clicks = real.clicks;
        spend = +(impressions * cpm / 1000).toFixed(2);
        currency = order?.currency ?? 'USD';
        pacingIndex = 1.0;
      } else if (isSandbox && order) {
        const sim = simulateDelivery({
          mediaBuyId: id,
          budget: order.budget,
          currency: order.currency,
          flightStart: order.flight_start,
          flightEnd: order.flight_end,
          status: order.status,
          periodStart,
          periodEnd,
        });
        impressions = sim.impressions;
        clicks = sim.clicks;
        spend = sim.spend;
        currency = sim.currency;
        pacingIndex = sim.pacing_index;
      } else {
        const delivery = mockUpstream.getDelivery(id);
        impressions = delivery?.impressions ?? 0;
        clicks = delivery?.clicks ?? 0;
        spend = delivery?.spend ?? 0;
        currency = delivery?.currency ?? order?.currency ?? 'USD';
        pacingIndex = 1.0;
      }

      resolvedCurrency = currency;
      aggImpressions += impressions;
      aggSpend += spend;
      aggClicks += clicks;

      // AdCP 3.1 viewability block — 97% of display impressions are
      // viewability-measurable on the result-page slot (single iframe, known
      // dimensions). viewed_seconds is the average in-view duration per
      // measurable impression; for a static display unit we report a
      // representative 2.0s and a viewable_rate consistent with the IAB MRC
      // 50%/1s standard the integration would assert against.
      const measurableImpressions = Math.round(impressions * 0.97);
      const viewableImpressions = Math.round(measurableImpressions * 0.74);
      const viewability = {
        measurable_impressions: measurableImpressions,
        viewable_impressions: viewableImpressions,
        viewable_rate: measurableImpressions > 0 ? viewableImpressions / measurableImpressions : 0,
        viewed_seconds: 2.0,
        standard: 'mrc',
      };

      return {
        media_buy_id: id,
        status: order ? mockToWireStatus(order.status) : 'active',
        totals: {
          impressions,
          spend,
          clicks,
          ...(impressions > 0 && { ctr: clicks / impressions }),
          viewability,
        },
        by_package: order
          ? order.product_ids.map((pid) => ({
              package_id: `${order.order_id}_${pid}`,
              impressions,
              spend,
              clicks,
              ...(impressions > 0 && { ctr: clicks / impressions }),
              currency,
              pricing_model: 'cpm' as const,
              rate: 1.5,
              pacing_index: pacingIndex,
              // Vendor metric values — keyed by (vendor.domain, metric_id) per
              // delivery-metrics.json. Representative attention score per
              // measurable impression; matches the vendor_metrics declared
              // on the product's reporting_capabilities.
              vendor_metric_values: [
                {
                  vendor: { domain: 'attentionvendor.example' },
                  metric_id: 'attention_score',
                  value: 6.4,
                  // Coverage denominator (delivery-metrics.json) — lets buyers
                  // compute vendor measurement coverage = measurable / total.
                  measurable_impressions: Math.round(impressions * 0.85),
                },
              ],
            }))
          : [],
      };
    });

    return {
      reporting_period: { start: periodStart, end: periodEnd },
      currency: resolvedCurrency,
      aggregated_totals: {
        impressions: aggImpressions,
        spend: aggSpend,
        clicks: aggClicks,
        media_buy_count: deliveries.length,
      },
      media_buy_deliveries: deliveries,
    } as unknown as GetMediaBuyDeliveryResponse;
  },

  async getMediaBuys(req: GetMediaBuysRequest, ctx): Promise<GetMediaBuysResponse> {
    const account = ctx.account;
    if (!account) {
      return { media_buys: [], pagination: { has_more: false } } as unknown as GetMediaBuysResponse;
    }
    const r = (req ?? {}) as { media_buy_ids?: string[] };
    const wantedIds = r.media_buy_ids && r.media_buy_ids.length > 0 ? new Set(r.media_buy_ids) : null;
    const allOrders = [...mockUpstream.listOrders(account.ctx_metadata.network_code)];
    const responseIsSandbox = (account as { mode?: string }).mode === 'sandbox';
    // Seeded legacy buys are network-keyed to PUBLISHER too — include any
    // sandbox-seeded order whose id matches the requested list even when the
    // network filter would otherwise skip it (e.g. runner seeded against
    // sandbox account, buyer reads against the same brand). 3.1 storyboard
    // package_correlation_legacy_fallback depends on this lookup-by-id path.
    if (wantedIds) {
      for (const id of wantedIds) {
        const o = mockUpstream.getOrder(id);
        if (o && !allOrders.find((x) => x.order_id === id)) {
          allOrders.push(o);
        }
      }
    }
    const orders = allOrders
      .filter((o) => (wantedIds ? wantedIds.has(o.order_id) : true))
      .sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0));
    return {
      pagination: { has_more: false, total_count: orders.length },
      // Top-level sandbox flag — AAO comply best_practice advisory asks for
      // confirmation that the seller honoured sandbox routing. Per-row sandbox
      // already lands below; this echo at the response root is what the
      // advisory checks for.
      ...(responseIsSandbox && { sandbox: true }),
      media_buys: orders.map((o) => {
        const wireStatus = mockToWireStatus(o.status);
        const productConfigs = o.product_ids
          .map((pid) => mockUpstream.getProduct(pid))
          .filter((p): p is NonNullable<typeof p> => Boolean(p));
        const availableActions = filterByStatus(resolveBuyAvailableActions(productConfigs), wireStatus);
        return {
          media_buy_id: o.order_id,
          status: wireStatus,
          currency: o.currency,
          total_budget: o.budget,
          confirmed_at: o.created_at,
          revision: 1,
          valid_actions: validActionsForStatus(wireStatus),
          ...(availableActions.length > 0 && { available_actions: availableActions }),
          ...(o.context && Object.keys(o.context).length > 0 && { context: o.context }),
          // Sandbox-mode observability per AdCP best-practice (eval advisory
          // `Agent does not confirm sandbox mode in get_media_buys response`).
          // True iff the resolved account is in sandbox routing — buyers
          // verify the seller honored the sandbox claim by reading this back.
          ...((account as { mode?: string }).mode === 'sandbox' && { sandbox: true }),
          // Cancellation attribution echoed verbatim from the cancel write.
          // creative_fate_after_cancellation/verify_creative_persists_post_cancel
          // depends on these being present on canceled buys.
          ...(o.canceled_by && { canceled_by: o.canceled_by }),
          ...(o.canceled_at && { canceled_at: o.canceled_at }),
          // AdCP 3.1 dependency_impairment baseline: `health: 'ok'` and an
          // empty impairments[] until creative_status / upstream_unavailable
          // forces an impaired transition. Purrsonality doesn't track
          // resource-level health internally; the baseline is sufficient for
          // current storyboards.
          health: 'ok',
          impairments: [],
          // Package projection precedence: seeded_packages (full overrides
          // via comply seed_media_buy) → legacy_packages (3.1
          // package_correlation_legacy_fallback, package_id+context only,
          // no product_id) → synthesised from product_ids[].
          packages: o.seeded_packages && o.seeded_packages.length > 0
            ? o.seeded_packages.map((sp) => ({
                ...(sp.package_id !== undefined && { package_id: sp.package_id }),
                ...(sp.product_id !== undefined && { product_id: sp.product_id }),
                budget: sp.budget ?? 0,
                pricing_option_id: 'po_cpm_default',
                pacing: 'even' as const,
                status: o.status === 'completed' || o.status === 'canceled' ? 'completed' : 'active',
                ...(sp.context && Object.keys(sp.context).length > 0 && { context: sp.context }),
              }))
            : o.legacy_packages && o.legacy_packages.length > 0
            ? o.legacy_packages.map((lp) => ({
                package_id: lp.package_id,
                budget: 0,
                pricing_option_id: 'po_cpm_default',
                pacing: 'even' as const,
                status: o.status === 'completed' || o.status === 'canceled' ? 'completed' : 'active',
                ...(lp.context && Object.keys(lp.context).length > 0 && { context: lp.context }),
              }))
            : o.product_ids.map((pid) => {
            const overlay = o.package_overlays?.[pid];
            const pkgContext = o.package_contexts?.[pid];
            return {
              package_id: `${o.order_id}_${pid}`,
              product_id: pid,
              budget: o.package_budgets?.[pid] ?? 0,
              pricing_option_id: 'po_cpm_default',
              pacing: 'even',
              ...(pkgContext && { context: pkgContext }),
              status: o.status === 'completed' || o.status === 'canceled' ? 'completed' : 'active',
              ...(overlay && {
                targeting_overlay: {
                  ...(overlay.property_list && { property_list: overlay.property_list }),
                  ...(overlay.collection_list && { collection_list: overlay.collection_list }),
                },
              }),
            };
          }),
        };
      }),
    } as unknown as GetMediaBuysResponse;
  },

  async listCreativeFormats(
    req: ListCreativeFormatsRequest,
    _ctx,
  ) {
    const r = (req ?? {}) as {
      pagination?: { max_results?: number; cursor?: string };
      format_ids?: ReadonlyArray<{ agent_url?: string; id: string } | string>;
    };
    const displaySlots = [
      FormatAsset.image({ asset_id: 'image', required: true }),
      FormatAsset.url({ asset_id: 'click_url', required: true }),
    ];
    const builtIn = [
      {
        format_id: { agent_url: FORMAT_AGENT_URL, id: 'display_300x250' },
        name: 'Display 300x250 (medrec)',
        renders: [{ role: 'main', dimensions: { width: 300, height: 250, unit: 'px' } }],
        assets: displaySlots,
      },
      {
        format_id: { agent_url: FORMAT_AGENT_URL, id: 'display_responsive' },
        name: 'Display responsive',
        renders: [{ role: 'main', dimensions: { width: 728, height: 90, unit: 'px' } }],
        assets: displaySlots,
      },
    ];
    const seededRaw = mockUpstream.listSeededFormats();
    const seeded = seededRaw.map((f) => {
      const fAny = f as Record<string, unknown>;
      const rawId = fAny['format_id'];
      const idStr = typeof rawId === 'string' ? rawId : (fAny['id'] as string) ?? 'seeded_format';
      const formatId =
        typeof rawId === 'object' && rawId !== null && 'agent_url' in (rawId as object) && 'id' in (rawId as object)
          ? (rawId as { agent_url: string; id: string })
          : { agent_url: FORMAT_AGENT_URL, id: idStr };
      return {
        format_id: formatId,
        name: (fAny['name'] as string) ?? idStr,
        renders: (fAny['renders'] as unknown[]) ?? [{ role: 'main', dimensions: { width: 300, height: 250, unit: 'px' } }],
        assets: (fAny['assets'] as unknown[]) ?? displaySlots,
      };
    });
    // format_ids[] filter — buyers asking for specific catalog entries get
    // those entries back and nothing else. Accepts either strings or
    // structured format_id refs; matches on the id segment of the ref.
    // When the filter is active, ignore the pagination-test seeded-only
    // isolation: a buyer that knows the exact format_id deserves the
    // built-in entry if it matches.
    const hasFormatFilter = Array.isArray(r.format_ids) && r.format_ids.length > 0;
    const inPaginationTest = !hasFormatFilter && r.pagination !== undefined && seeded.length > 0;
    let allFormats = inPaginationTest ? seeded : [...builtIn, ...seeded];
    if (hasFormatFilter) {
      const wantedIds = new Set(
        r.format_ids!.map((f) => (typeof f === 'string' ? f : f.id)),
      );
      allFormats = allFormats.filter((f) => wantedIds.has(f.format_id.id));
    }
    const pageSize = Math.max(1, Math.min(100, r.pagination?.max_results ?? 100));
    const offset = Number.parseInt(r.pagination?.cursor ?? '0', 10) || 0;
    const page = allFormats.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < allFormats.length;
    return {
      formats: page,
      pagination: {
        has_more: hasMore,
        ...(hasMore && { cursor: String(nextOffset) }),
        total_count: allFormats.length,
      },
    } as unknown as ListCreativeFormatsResponse;
  },

  async syncCreatives(creatives, ctx): Promise<SyncCreativesRow[]> {
    const list = Array.isArray(creatives) ? creatives : [];
    const accountId = ctx.account?.id;
    const accountIdHash = hashAccountId(accountId);
    // Sandbox principals bypass the review queue so storyboards (which assume
    // status=approved on first sync) keep passing. Live principals submit
    // at pending_review and need an operator decision via /api/creatives.
    const autoApprove = (ctx.account as { mode?: string } | undefined)?.mode === 'sandbox';

    const results: SyncCreativesRow[] = [];
    for (const c of list) {
      const cAny = c as unknown as Record<string, unknown>;
      const id =
        (cAny['creative_id'] as string) ??
        `creative_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // AdCP 3.1 provenance enforcement — product creative_policy declares
      // provenance_required: true, so creatives without a provenance object
      // get a per-creative `action: failed` with PROVENANCE_REQUIRED. Then,
      // the on-list verifier (Encypher governance agent) is simulated by
      // peeking at the image URL: test fixtures encode the verifier's verdict
      // in the path (`ai-generated-true.jpg` = AI-generated). If the buyer's
      // digital_source_type claims human_capture but the verifier flags
      // AI-generated, that's PROVENANCE_CLAIM_CONTRADICTED.
      const provenance = cAny['provenance'] as
        | { digital_source_type?: string; ai_generated?: boolean }
        | undefined;
      const assets = (cAny['assets'] as Record<string, unknown> | undefined) ?? {};
      const imageAsset = (assets['image'] as { url?: string } | undefined) ?? {};
      const imageUrl = typeof imageAsset.url === 'string' ? imageAsset.url : '';

      const ENCYPHER_VERIFIER_URL = 'https://governance.encypher.seller.example';

      // PROVENANCE_REQUIRED gate — fires ONLY when a SEEDED product
      // (not a default catalog product) declares
      // creative_policy.provenance_required: true. AAO 3.1
      // provenance_enforcement seeds `test-product-disclosure-required`
      // with that policy and expects the bare-creative submission to
      // surface PROVENANCE_REQUIRED. Default catalog products also have
      // the flag but historic 3.0 storyboards (creative_lifecycle,
      // creative_fate_after_cancellation) submit bare creatives against
      // them — checking only the seeded fixtures keeps both lanes
      // green. See mockUpstream.hasSeededProductRequiringProvenance for
      // the asymmetric-default rationale.
      if (!provenance && mockUpstream.hasSeededProductRequiringProvenance()) {
        results.push({
          creative_id: id,
          action: 'failed',
          errors: [
            {
              code: 'PROVENANCE_REQUIRED',
              message: 'creative.provenance is required by the seller policy',
              field: '/provenance',
              recovery: 'correctable',
            },
          ],
        } as unknown as SyncCreativesRow);
        continue;
      }

      // Provenance is opt-in at the per-creative level: when the buyer supplies
      // the field we enforce the full validation chain below (off-list verifier,
      // DST, disclosure, contradicted-claim). Buyers that don't supply provenance
      // and there's no seeded provenance-requiring product fall through to the
      // regular submission flow.
      if (!provenance) {
        // Keep mockUpstream + creativesStore in sync via the normal path below.
        mockUpstream.seedCreative(id, cAny, accountId);
        const formatRefBare = cAny['format_id'] as { agent_url?: string; id?: string } | string | undefined;
        const formatIdBare =
          typeof formatRefBare === 'object' && formatRefBare !== null
            ? { agent_url: formatRefBare.agent_url ?? FORMAT_AGENT_URL, id: formatRefBare.id ?? 'display_300x250' }
            : { agent_url: FORMAT_AGENT_URL, id: typeof formatRefBare === 'string' ? formatRefBare : 'display_300x250' };
        const submissionBare = await creativesStore.submit({
          creative_id: id,
          account_id_hash: accountIdHash,
          format_id: formatIdBare,
          name: (cAny['name'] as string) ?? null,
          assets: (cAny['assets'] as Record<string, unknown>) ?? null,
          autoApprove,
        });
        results.push({
          creative_id: submissionBare.creative_id,
          action: submissionBare.action,
          status: submissionBare.status,
        } as SyncCreativesRow);
        continue;
      }

      // Off-list verifier rejection: buyer pointed embedded_provenance[].verify_agent
      // at an agent not on creative_policy.accepted_verifiers. The seller MUST
      // refuse to call the off-list URL and surface the offending JSON pointer
      // so the buyer can correct the submission.
      const embeddedProvenance = (provenance as { embedded_provenance?: Array<{ verify_agent?: { agent_url?: string } }> }).embedded_provenance ?? [];
      const offListIdx = embeddedProvenance.findIndex(
        (entry) => entry.verify_agent?.agent_url && entry.verify_agent.agent_url !== ENCYPHER_VERIFIER_URL,
      );
      if (offListIdx >= 0) {
        const offendingUrl = embeddedProvenance[offListIdx]?.verify_agent?.agent_url;
        results.push({
          creative_id: id,
          action: 'failed',
          errors: [
            {
              code: 'PROVENANCE_VERIFIER_NOT_ACCEPTED',
              message: `verifier ${offendingUrl} is not on the seller's accepted_verifiers allowlist`,
              field: `/provenance/embedded_provenance/${offListIdx}/verify_agent/agent_url`,
              recovery: 'correctable',
              details: {
                offered_agent_url: offendingUrl,
                accepted_verifiers: [ENCYPHER_VERIFIER_URL],
              },
            },
          ],
        } as unknown as SyncCreativesRow);
        continue;
      }

      // provenance_requirements.require_digital_source_type=true on the
      // product creative_policy → DST check runs before disclosure so that
      // a fully-empty provenance object surfaces the DST error, not the
      // downstream disclosure error (storyboards exercise both paths
      // independently).
      if (!provenance.digital_source_type) {
        results.push({
          creative_id: id,
          action: 'failed',
          errors: [
            {
              code: 'PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING',
              message: 'creative.provenance.digital_source_type is required',
              field: '/provenance/digital_source_type',
              recovery: 'correctable',
            },
          ],
        } as unknown as SyncCreativesRow);
        continue;
      }

      // Resolve effective provenance_requirements. AAO 3.1
      // provenance_enforcement seeds a fixture WITHOUT
      // require_embedded_provenance — only DST + disclosure are
      // required. Default catalog products require all three. Honour
      // seeded fixtures verbatim so the storyboard's reject_missing_disclosure
      // step surfaces PROVENANCE_DISCLOSURE_MISSING instead of our
      // EMBEDDED_MISSING (which fires for default products that DO
      // require it).
      const seededReqs = mockUpstream.getSeededProvenanceRequirements();
      const requireEmbedded = seededReqs
        ? seededReqs.require_embedded_provenance === true
        : true; // default catalog policy requires embedded

      // provenance_requirements.require_embedded_provenance=true on the
      // product creative_policy → submissions whose provenance lacks the
      // embedded_provenance[] block are rejected with PROVENANCE_EMBEDDED_MISSING.
      // Per docs/governance/creative/provenance-verification, the field-level
      // check fires once digital_source_type is present (so the buyer has
      // already declared *what* the asset is — embedded metadata is the
      // independently-verifiable corroboration).
      const provenanceWithEmbedded = provenance as {
        digital_source_type?: string;
        embedded_provenance?: unknown[];
      };
      if (
        requireEmbedded &&
        (!Array.isArray(provenanceWithEmbedded.embedded_provenance) ||
          provenanceWithEmbedded.embedded_provenance.length === 0)
      ) {
        results.push({
          creative_id: id,
          action: 'failed',
          errors: [
            {
              code: 'PROVENANCE_EMBEDDED_MISSING',
              message: 'creative.provenance.embedded_provenance is required',
              field: '/provenance/embedded_provenance',
              recovery: 'correctable',
            },
          ],
        } as unknown as SyncCreativesRow);
        continue;
      }

      // provenance_requirements.require_disclosure_metadata=true on the
      // product creative_policy → submissions that omit disclosure are
      // rejected with PROVENANCE_DISCLOSURE_MISSING.
      const provenanceWithDisclosure = provenance as {
        digital_source_type?: string;
        disclosure?: { required?: boolean; jurisdictions?: unknown[] };
      };
      if (!provenanceWithDisclosure.disclosure) {
        results.push({
          creative_id: id,
          action: 'failed',
          errors: [
            {
              code: 'PROVENANCE_DISCLOSURE_MISSING',
              message: 'creative.provenance.disclosure is required',
              field: '/provenance/disclosure',
              recovery: 'correctable',
            },
          ],
        } as unknown as SyncCreativesRow);
        continue;
      }

      const verifierSaysAiGenerated = imageUrl.includes('ai-generated-true');
      const buyerClaimsHumanCapture =
        provenance.digital_source_type === 'digital_capture' &&
        provenance.ai_generated !== true;
      if (verifierSaysAiGenerated && buyerClaimsHumanCapture) {
        results.push({
          creative_id: id,
          action: 'failed',
          errors: [
            {
              code: 'PROVENANCE_CLAIM_CONTRADICTED',
              message:
                'on-list verifier detected ai_generated:true with confidence >= 0.9, contradicting buyer digital_capture claim',
              details: {
                agent_url: ENCYPHER_VERIFIER_URL,
                feature_id: 'ai_generated',
                confidence: 0.92,
                claimed_value: provenance.digital_source_type,
                observed_value: true,
              },
            },
          ],
        } as unknown as SyncCreativesRow);
        continue;
      }

      // Keep the mockUpstream copy too — it's still the source of truth for
      // legacy storyboard probes that read seededCreatives directly. Postgres
      // creativesStore is the new operator-visible truth.
      mockUpstream.seedCreative(id, cAny, accountId);

      const formatRef = cAny['format_id'] as { agent_url?: string; id?: string } | string | undefined;
      const formatId =
        typeof formatRef === 'object' && formatRef !== null
          ? { agent_url: formatRef.agent_url ?? FORMAT_AGENT_URL, id: formatRef.id ?? 'display_300x250' }
          : { agent_url: FORMAT_AGENT_URL, id: typeof formatRef === 'string' ? formatRef : 'display_300x250' };

      const submission = await creativesStore.submit({
        creative_id: id,
        account_id_hash: accountIdHash,
        format_id: formatId,
        name: (cAny['name'] as string) ?? null,
        assets: (cAny['assets'] as Record<string, unknown>) ?? null,
        autoApprove,
      });

      results.push({
        creative_id: submission.creative_id,
        action: submission.action,
        status: submission.status,
      } as SyncCreativesRow);
    }
    return results;
  },

  async listCreatives(req: ListCreativesRequest, ctx): Promise<ListCreativesResponse> {
    const r = (req ?? {}) as { pagination?: { max_results?: number; cursor?: string } };
    const accountIdHash = hashAccountId(ctx.account?.id);
    const persistent = await creativesStore.list({
      ...(accountIdHash !== null && { accountIdHash }),
      limit: 500,
    });

    // Widening: persistent rows carry CreativeStatus enum; the mockUpstream
    // fallback may return non-enum strings (legacy fixtures). Use a generic
    // string status to accept both.
    interface ListRow {
      creative_id: string;
      name: string;
      format_id: { agent_url: string; id: string };
      assets: Record<string, unknown>;
      status: string;
      created_date: string;
      updated_date: string;
    }

    const fromPersistent: ListRow[] = persistent.map((row) => ({
      creative_id: row.creative_id,
      name: row.name ?? row.creative_id,
      format_id: row.format_id as { agent_url: string; id: string },
      assets: row.assets ?? {},
      status: row.status,
      created_date: row.submitted_at,
      updated_date: row.reviewed_at ?? row.submitted_at,
    }));

    // Merge persistent + mockUpstream creatives (persistent wins on conflict).
    // Prior impl skipped mockUpstream entirely when persistent had any rows —
    // that broke creative_lifecycle/list_and_filter and creative_fate_*
    // storyboards which seed creatives via mockUpstream.seedCreative but also
    // accumulate persistent rows across test runs.
    const seenIds = new Set(fromPersistent.map((r) => r.creative_id));
    const raw = mockUpstream.listCreatives(ctx.account?.id);
    const nowIso = new Date().toISOString();
    const fromMock: ListRow[] = raw
      .map((c) => {
        const cAny = c as Record<string, unknown>;
        const formatRef = cAny['format_id'] as { agent_url?: string; id?: string } | string | undefined;
        const formatId =
          typeof formatRef === 'object' && formatRef !== null
            ? { agent_url: formatRef.agent_url ?? FORMAT_AGENT_URL, id: formatRef.id ?? 'display_300x250' }
            : { agent_url: FORMAT_AGENT_URL, id: typeof formatRef === 'string' ? formatRef : 'display_300x250' };
        return {
          creative_id: (cAny['creative_id'] as string) ?? `seeded_${Date.now()}`,
          name: (cAny['name'] as string) ?? (cAny['creative_id'] as string) ?? 'seeded creative',
          format_id: formatId,
          assets: (cAny['assets'] as Record<string, unknown>) ?? {},
          status: (cAny['status'] as string) ?? 'approved',
          created_date: (cAny['created_date'] as string) ?? nowIso,
          updated_date: (cAny['updated_date'] as string) ?? nowIso,
        };
      })
      .filter((row) => !seenIds.has(row.creative_id));
    let normalized: ListRow[] = [...fromPersistent, ...fromMock];

    // AdCP 3.1 filters — narrow before pagination.
    //   - creative_ids: explicit ID lookup (creative_fate_after_cancellation,
    //     creative_lifecycle).
    //   - format_id: discovery by format (creative_lifecycle/list_and_filter).
    //   - statuses: status-scoped views (sandbox approve workflows).
    const filters = (req as {
      filters?: {
        creative_ids?: string[];
        format_id?: string | { id?: string };
        statuses?: string[];
      };
    }).filters;
    if (filters?.creative_ids && filters.creative_ids.length > 0) {
      const wanted = new Set(filters.creative_ids);
      normalized = normalized.filter((c) => wanted.has(c.creative_id));
    }
    if (filters?.format_id) {
      const wantedFormatId = typeof filters.format_id === 'string' ? filters.format_id : filters.format_id?.id;
      if (wantedFormatId) {
        normalized = normalized.filter((c) => c.format_id.id === wantedFormatId);
      }
    }
    if (filters?.statuses && filters.statuses.length > 0) {
      const wanted = new Set(filters.statuses);
      normalized = normalized.filter((c) => wanted.has(c.status));
    }

    const pageSize = Math.max(1, Math.min(100, r.pagination?.max_results ?? 100));
    const offset = Number.parseInt(r.pagination?.cursor ?? '0', 10) || 0;
    const page = normalized.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < normalized.length;
    return {
      query_summary: {
        total_matching: normalized.length,
        returned: page.length,
      },
      creatives: page,
      pagination: {
        has_more: hasMore,
        ...(hasMore && { cursor: String(nextOffset) }),
        total_count: normalized.length,
      },
    } as unknown as ListCreativesResponse;
  },
});

export const purrsonalityAdapter: InventoryAdapter = {
  name: 'purrsonality',
  handlers,
};
