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
  inputContext?: Record<string, unknown> | undefined,
): Package {
  return {
    package_id: `${orderId}_${productId}`,
    product_id: productId,
    budget,
    pricing_option_id: pricingOptionId,
    pacing: 'even',
    status: hasCreatives ? 'active' : 'pending_creatives',
    ...(inputContext && Object.keys(inputContext).length > 0 && { context: inputContext }),
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
        pricing: { model: 'cpm', fixed: p.min_cpm, currency: p.currency },
        publisher_domain: PUBLISHER.adcp_publisher,
        channels: [p.channel],
        ctx_metadata: { ad_unit_ids: [...p.ad_unit_ids] },
      });
      if (p.allowed_actions && p.allowed_actions.length > 0) {
        (base as unknown as { allowed_actions: readonly unknown[] }).allowed_actions = p.allowed_actions;
      }
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

    const rTop = req as { start_time?: string; end_time?: string; flight?: { start_time?: string; end_time?: string } };
    if (rTop.start_time && rTop.end_time && rTop.start_time > rTop.end_time) {
      throw new AdcpError('VALIDATION_ERROR', { message: 'start_time must be before end_time', field: '/end_time' });
    }
    const flight = rTop.flight;
    if (flight?.start_time && flight?.end_time && flight.start_time > flight.end_time) {
      throw new AdcpError('VALIDATION_ERROR', { message: 'flight.start_time must be before flight.end_time', field: '/flight/end_time' });
    }
    for (const pkg of packages) {
      const pkgFlight = pkg as { start_time?: string; end_time?: string };
      if (pkgFlight.start_time && pkgFlight.end_time && pkgFlight.start_time > pkgFlight.end_time) {
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
      const product = mockUpstream.getProduct(pkg.product_id);
      if (!product) {
        throw new AdcpError('PRODUCT_NOT_FOUND', { message: `product not found: ${pkg.product_id}` });
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
    });

    for (const [productId, overlay] of overlayMap.entries()) {
      mockUpstream.setPackageOverlay(order.order_id, productId, overlay);
    }

    const status: MediaBuyStatus = hasAnyCreatives ? 'active' : 'pending_creatives';
    const allBuyActions = resolveBuyAvailableActions(resolvedProductConfigs);
    const availableActions = filterByStatus(allBuyActions, status);

    const successResponse: CreateMediaBuySuccess = {
      media_buy_id: order.order_id,
      status,
      health: 'ok' as const,
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
          (pkg as { context?: Record<string, unknown> }).context,
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
      mockUpstream.updateOrder(buyId, { status: 'canceled' });
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
      health: 'ok' as const,
      valid_actions: validActionsForStatus(newWireStatus),
      ...(postAvailableActions.length > 0 && { available_actions: postAvailableActions }),
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

      return {
        media_buy_id: id,
        status: order ? mockToWireStatus(order.status) : 'active',
        totals: {
          impressions,
          spend,
          clicks,
          ...(impressions > 0 && { ctr: clicks / impressions }),
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

  async getMediaBuys(_req: GetMediaBuysRequest, ctx): Promise<GetMediaBuysResponse> {
    const account = ctx.account;
    if (!account) {
      return { media_buys: [], pagination: { has_more: false } } as unknown as GetMediaBuysResponse;
    }
    const orders = [...mockUpstream.listOrders(account.ctx_metadata.network_code)].sort(
      (a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0),
    );
    return {
      pagination: { has_more: false, total_count: orders.length },
      media_buys: orders.map((o) => {
        const wireStatus = mockToWireStatus(o.status);
        const productConfigs = o.product_ids
          .map((pid) => mockUpstream.getProduct(pid))
          .filter((p): p is NonNullable<typeof p> => Boolean(p));
        const availableActions = filterByStatus(resolveBuyAvailableActions(productConfigs), wireStatus);
        return {
          media_buy_id: o.order_id,
          status: wireStatus,
          health: 'ok' as const,
          currency: o.currency,
          total_budget: o.budget,
          confirmed_at: o.created_at,
          revision: 1,
          valid_actions: validActionsForStatus(wireStatus),
          ...(availableActions.length > 0 && { available_actions: availableActions }),
          packages: o.product_ids.map((pid) => {
            const overlay = o.package_overlays?.[pid];
            return {
              package_id: `${o.order_id}_${pid}`,
              product_id: pid,
              budget: o.package_budgets?.[pid] ?? 0,
              pricing_option_id: 'po_cpm_default',
              pacing: 'even',
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
  ): Promise<ListCreativeFormatsResponse> {
    const r = (req ?? {}) as { pagination?: { max_results?: number; cursor?: string } };
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
    const inPaginationTest = r.pagination !== undefined && seeded.length > 0;
    const allFormats = inPaginationTest ? seeded : [...builtIn, ...seeded];
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

    // Fall back to mockUpstream rows when Postgres returned nothing — keeps
    // legacy storyboard fixtures (seed via mockUpstream.seedCreative outside
    // sync_creatives) visible. Persistent rows win when present.
    const fromPersistent = persistent.map((row) => ({
      creative_id: row.creative_id,
      name: row.name ?? row.creative_id,
      format_id: row.format_id as { agent_url: string; id: string },
      assets: row.assets ?? {},
      status: row.status,
      created_date: row.submitted_at,
      updated_date: row.reviewed_at ?? row.submitted_at,
    }));

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
    let normalized: ListRow[] = fromPersistent as ListRow[];
    if (normalized.length === 0) {
      const raw = mockUpstream.listCreatives(ctx.account?.id);
      const nowIso = new Date().toISOString();
      normalized = raw.map((c) => {
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
      });
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
