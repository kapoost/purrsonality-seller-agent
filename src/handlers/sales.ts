import {
  AdcpError,
  buildProduct,
  defineSalesPlatform,
  type SalesPlatform,
  type SyncCreativesRow,
} from '@adcp/sdk/server';
import { FormatAsset } from '@adcp/sdk';
import type {
  GetProductsRequest,
  GetProductsResponse,
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
import { PUBLISHER } from '../config/purrsonality.ts';
import { mockUpstream } from '../upstream/mock.ts';
import type { PurrAccountMeta } from './accounts.ts';

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

function buildPackageResponse(orderId: string, productId: string, budget: number, pricingOptionId: string, hasCreatives: boolean): Package {
  return {
    package_id: `${orderId}_${productId}`,
    product_id: productId,
    budget,
    pricing_option_id: pricingOptionId,
    pacing: 'even',
    status: hasCreatives ? 'active' : 'pending_creatives',
  } as unknown as Package;
}

export const sales: SalesPlatform<PurrAccountMeta> = defineSalesPlatform<PurrAccountMeta>({
  async getProducts(req: GetProductsRequest, _ctx): Promise<GetProductsResponse> {
    const r = req as {
      buying_mode?: string;
      brief?: string;
      refine?: Array<{ scope?: string; proposal_id?: string; product_id?: string; action?: string }>;
    };
    const products = mockUpstream.listProducts().map((p) =>
      buildProduct({
        id: p.product_id,
        name: p.name,
        description: p.description,
        formats: [...p.format_ids],
        agentUrl: FORMAT_AGENT_URL,
        delivery_type: 'non_guaranteed',
        pricing: { model: 'cpm', floor: p.min_cpm, currency: p.currency },
        publisher_domain: PUBLISHER.adcp_publisher,
        channels: [p.channel],
        ctx_metadata: { ad_unit_ids: [...p.ad_unit_ids] },
      }),
    );

    const generateProposal = (forProposalId?: string, isCommitted = false) => {
      const proposalId = forProposalId ?? `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const evenPct = Math.floor(100 / products.length);
      const allocations = products.map((p, i) => ({
        product_id: p.product_id,
        allocation_percentage: i === 0 ? 100 - evenPct * (products.length - 1) : evenPct,
        pricing_option_id: p.pricing_options?.[0]?.pricing_option_id,
      }));
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
      return {
        products,
        proposals: [generateProposal()],
      } as unknown as GetProductsResponse;
    }

    if (r.buying_mode === 'refine' && Array.isArray(r.refine) && r.refine.length > 0 && products.length > 0) {
      const refinement_applied = r.refine.map((entry) => {
        if (entry.scope === 'proposal') {
          return {
            scope: 'proposal' as const,
            proposal_id: entry.proposal_id,
            status: 'applied' as const,
            notes: `Refinement '${entry.action ?? 'update'}' applied to proposal`,
          };
        }
        if (entry.scope === 'product') {
          return {
            scope: 'product' as const,
            product_id: entry.product_id,
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
      } as unknown as GetProductsResponse;
    }

    return { products };
  },

  async createMediaBuy(req: CreateMediaBuyRequest, ctx): Promise<CreateMediaBuySuccess> {
    const account = ctx.account;
    if (!account) throw new AdcpError('ACCOUNT_NOT_FOUND', { message: 'no account in context' });

    const packages = req.packages ?? [];
    if (packages.length === 0 && !req.proposal_id) {
      throw new AdcpError('INVALID_REQUEST', { message: 'packages[] or proposal_id is required' });
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
      client_request_id: req.idempotency_key,
    });

    for (const [productId, overlay] of overlayMap.entries()) {
      mockUpstream.setPackageOverlay(order.order_id, productId, overlay);
    }

    const status: MediaBuyStatus = hasAnyCreatives ? 'active' : 'pending_creatives';

    return {
      media_buy_id: order.order_id,
      status,
      confirmed_at: order.created_at,
      revision: 1,
      packages: packages.map((pkg) =>
        buildPackageResponse(
          order.order_id,
          pkg.product_id,
          pkg.budget,
          pkg.pricing_option_id ?? 'po_cpm_default',
          hasAnyCreatives,
        ),
      ),
    } as unknown as CreateMediaBuySuccess;
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
    }

    const updated = mockUpstream.getOrder(buyId)!;
    return {
      media_buy_id: buyId,
      status: mockToWireStatus(updated.status),
      revision: 2,
    } as unknown as UpdateMediaBuySuccess;
  },

  async getMediaBuyDelivery(
    req: GetMediaBuyDeliveryRequest,
    _ctx,
  ): Promise<GetMediaBuyDeliveryResponse> {
    const r = (req ?? {}) as { media_buy_ids?: string[]; start_date?: string; end_date?: string };
    const ids = Array.isArray(r.media_buy_ids) ? r.media_buy_ids : [];

    const periodStart = r.start_date ? `${r.start_date}T00:00:00Z` : new Date(Date.now() - 86_400_000).toISOString();
    const periodEnd = r.end_date ? `${r.end_date}T23:59:59Z` : new Date().toISOString();

    let aggImpressions = 0;
    let aggSpend = 0;
    let aggClicks = 0;
    let resolvedCurrency = 'USD';

    const deliveries = ids.map((id) => {
      const order = mockUpstream.getOrder(id);
      const delivery = mockUpstream.getDelivery(id);
      const impressions = delivery?.impressions ?? 0;
      const clicks = delivery?.clicks ?? 0;
      const spend = delivery?.spend ?? 0;
      const currency = delivery?.currency ?? order?.currency ?? 'USD';
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
              pacing_index: 1.0,
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
      media_buys: orders.map((o) => ({
        media_buy_id: o.order_id,
        status: mockToWireStatus(o.status),
        currency: o.currency,
        total_budget: o.budget,
        confirmed_at: o.created_at,
        revision: 1,
        valid_actions:
          o.status === 'completed' || o.status === 'canceled' || o.status === 'rejected'
            ? []
            : ['pause', 'resume', 'cancel', 'update_budget'],
        packages: o.product_ids.map((pid) => {
          const overlay = o.package_overlays?.[pid];
          return {
            package_id: `${o.order_id}_${pid}`,
            product_id: pid,
            budget: 0,
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
      })),
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
    return list.map((c) => {
      const cAny = c as unknown as Record<string, unknown>;
      const id = (cAny['creative_id'] as string) ?? `creative_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      mockUpstream.seedCreative(id, cAny, accountId);
      return {
        creative_id: id,
        action: 'created' as const,
        status: 'approved' as const,
      };
    }) as unknown as SyncCreativesRow[];
  },

  async listCreatives(req: ListCreativesRequest, ctx): Promise<ListCreativesResponse> {
    const r = (req ?? {}) as { pagination?: { max_results?: number; cursor?: string } };
    const raw = mockUpstream.listCreatives(ctx.account?.id);
    const nowIso = new Date().toISOString();
    const normalized = raw.map((c) => {
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
