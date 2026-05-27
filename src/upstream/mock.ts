import { PRODUCTS, PUBLISHER, type PurrProductConfig, type ProductAllowedAction } from '../config/purrsonality.ts';

export interface MockOrder {
  order_id: string;
  network_code: string;
  advertiser_id: string;
  product_ids: string[];
  budget: number;
  currency: string;
  pacing: 'even' | 'asap' | 'front_loaded';
  status: 'pending_creatives' | 'pending_start' | 'confirmed' | 'delivering' | 'paused' | 'completed' | 'canceled' | 'rejected';
  flight_start?: string;
  flight_end?: string;
  created_at: string;
  client_request_id?: string;
  package_overlays?: Record<string, PackageOverlay>;
  package_budgets?: Record<string, number>;
}

export interface PackageOverlay {
  property_list?: { agent_url: string; list_id: string };
  collection_list?: { agent_url: string; list_id: string };
}

export interface MockDeliveryRow {
  order_id: string;
  impressions: number;
  clicks: number;
  spend: number;
  currency: string;
  pacing_pct: number;
}

const orders = new Map<string, MockOrder>();
const requestKey = new Map<string, string>();
const deliverySim = new Map<
  string,
  { impressions: number; clicks: number; spend: number; currency: string }
>();
const seededProducts = new Map<string, PurrProductConfig>();
const seededCreatives = new Map<string, Record<string, unknown>>();
const seededFormats = new Map<string, Record<string, unknown>>();
const proposalsMap = new Map<string, { issued_at: string; expires_at: string }>();

export interface CreateMediaBuyDirective {
  arm: 'submitted' | 'input-required';
  task_id?: string;
  message?: string;
}

const createMediaBuyDirectives = new Map<string, CreateMediaBuyDirective>();

function generateOrderId(): string {
  return `mb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const mockUpstream = {
  lookupPublisher(domain: string) {
    return domain === PUBLISHER.adcp_publisher ? PUBLISHER : null;
  },

  listProducts(): readonly PurrProductConfig[] {
    return [...PRODUCTS, ...seededProducts.values()];
  },

  getProduct(id: string): PurrProductConfig | undefined {
    return PRODUCTS.find((p) => p.product_id === id) ?? seededProducts.get(id);
  },

  seedProduct(id: string, overrides?: Partial<PurrProductConfig> & { allowed_actions?: readonly ProductAllowedAction[] }): PurrProductConfig {
    const existing = PRODUCTS[0]!;
    const prior = seededProducts.get(id);
    const product: PurrProductConfig = {
      product_id: id,
      name: overrides?.name ?? prior?.name ?? `Seeded ${id}`,
      description: overrides?.description ?? prior?.description ?? `Test product seeded by compliance runner: ${id}`,
      network_code: PUBLISHER.network_code,
      channel: (overrides?.channel as 'display') ?? prior?.channel ?? 'display',
      format_ids: (overrides?.format_ids as readonly string[]) ?? prior?.format_ids ?? existing.format_ids,
      ad_unit_ids: (overrides?.ad_unit_ids as readonly string[]) ?? prior?.ad_unit_ids ?? existing.ad_unit_ids,
      min_cpm: overrides?.min_cpm ?? prior?.min_cpm ?? existing.min_cpm,
      currency: overrides?.currency ?? prior?.currency ?? existing.currency,
      min_spend: overrides?.min_spend ?? prior?.min_spend ?? existing.min_spend,
      estimated_impressions_per_month: overrides?.estimated_impressions_per_month ?? prior?.estimated_impressions_per_month ?? existing.estimated_impressions_per_month,
      ...((overrides?.allowed_actions ?? prior?.allowed_actions) && {
        allowed_actions: overrides?.allowed_actions ?? prior?.allowed_actions,
      }),
    };
    seededProducts.set(id, product);
    return product;
  },

  seedCreative(id: string, fixture: Record<string, unknown>, accountId?: string): void {
    seededCreatives.set(id, { ...fixture, creative_id: id, _account_id: accountId });
  },

  listCreatives(accountId?: string): Array<Record<string, unknown>> {
    const all = [...seededCreatives.values()].reverse();
    if (!accountId) return all;
    return all.filter((c) => {
      const owner = c['_account_id'];
      return owner === undefined || owner === accountId;
    });
  },

  seedCreativeFormat(id: string, fixture: Record<string, unknown>): void {
    seededFormats.set(id, { ...fixture, format_id: id });
  },

  listSeededFormats(): Array<Record<string, unknown>> {
    return [...seededFormats.values()];
  },

  setCreateMediaBuyDirective(accountId: string, directive: CreateMediaBuyDirective): void {
    createMediaBuyDirectives.set(accountId, directive);
  },

  consumeCreateMediaBuyDirective(accountId: string): CreateMediaBuyDirective | undefined {
    const d = createMediaBuyDirectives.get(accountId);
    if (d) createMediaBuyDirectives.delete(accountId);
    return d;
  },

  createOrder(args: {
    network_code: string;
    advertiser_id: string;
    product_ids: string[];
    budget: number;
    currency: string;
    pacing?: 'even' | 'asap' | 'front_loaded';
    flight_start?: string;
    flight_end?: string;
    client_request_id?: string;
    package_budgets?: Record<string, number>;
    status?: MockOrder['status'];
  }): MockOrder {
    if (args.client_request_id) {
      const existing = requestKey.get(args.client_request_id);
      if (existing) {
        const order = orders.get(existing);
        if (order) return order;
      }
    }

    const order: MockOrder = {
      order_id: generateOrderId(),
      network_code: args.network_code,
      advertiser_id: args.advertiser_id,
      product_ids: args.product_ids,
      budget: args.budget,
      currency: args.currency,
      pacing: args.pacing ?? 'even',
      status: args.status ?? 'confirmed',
      ...(args.flight_start !== undefined && { flight_start: args.flight_start }),
      ...(args.flight_end !== undefined && { flight_end: args.flight_end }),
      created_at: new Date().toISOString(),
      ...(args.client_request_id !== undefined && { client_request_id: args.client_request_id }),
      ...(args.package_budgets && { package_budgets: { ...args.package_budgets } }),
    };

    orders.set(order.order_id, order);
    if (args.client_request_id) requestKey.set(args.client_request_id, order.order_id);
    return order;
  },

  getOrder(id: string): MockOrder | undefined {
    return orders.get(id);
  },

  listOrders(networkCode: string): MockOrder[] {
    return [...orders.values()].filter((o) => o.network_code === networkCode);
  },

  updateOrder(
    id: string,
    patch: Partial<Pick<MockOrder, 'status' | 'budget' | 'pacing' | 'flight_end' | 'flight_start'>> & {
      package_budgets?: Record<string, number>;
    },
  ): MockOrder | undefined {
    const o = orders.get(id);
    if (!o) return undefined;
    const { package_budgets, ...rest } = patch;
    Object.assign(o, rest);
    if (package_budgets) {
      o.package_budgets = { ...(o.package_budgets ?? {}), ...package_budgets };
    }
    return o;
  },

  // Proposal registry — every proposal_id we emit in get_products is tracked
  // here so refine/create flows can distinguish a known-but-expired proposal
  // from one we never issued. The "expired-" prefix is a storyboard sentinel
  // (PR #4942) for forcing PROPOSAL_EXPIRED without burning real TTL.
  emitProposal(id: string, ttlMs: number = 24 * 3600 * 1000): void {
    const now = Date.now();
    proposalsMap.set(id, {
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMs).toISOString(),
    });
  },

  lookupProposal(id: string): { issued_at: string; expires_at: string; expired: boolean } | undefined {
    if (id.startsWith('expired-')) {
      const past = new Date(Date.now() - 60_000).toISOString();
      return { issued_at: past, expires_at: past, expired: true };
    }
    const p = proposalsMap.get(id);
    if (!p) return undefined;
    return { ...p, expired: new Date(p.expires_at).getTime() < Date.now() };
  },

  setPackageOverlay(orderId: string, productId: string, overlay: PackageOverlay): void {
    const o = orders.get(orderId);
    if (!o) return;
    o.package_overlays = o.package_overlays ?? {};
    o.package_overlays[productId] = { ...(o.package_overlays[productId] ?? {}), ...overlay };
  },

  getDelivery(orderId: string): MockDeliveryRow | null {
    const o = orders.get(orderId);
    if (!o) return null;
    const sim = deliverySim.get(orderId);
    return {
      order_id: o.order_id,
      impressions: sim?.impressions ?? 0,
      clicks: sim?.clicks ?? 0,
      spend: sim?.spend ?? 0,
      currency: sim?.currency ?? o.currency,
      pacing_pct: 0,
    };
  },

  seedOrder(args: {
    media_buy_id: string;
    network_code: string;
    advertiser_id: string;
    product_ids?: string[];
    budget?: number;
    currency?: string;
    status?: MockOrder['status'];
  }): MockOrder {
    const existing = orders.get(args.media_buy_id);
    const order: MockOrder = existing ?? {
      order_id: args.media_buy_id,
      network_code: args.network_code,
      advertiser_id: args.advertiser_id,
      product_ids: args.product_ids ?? [],
      budget: args.budget ?? 0,
      currency: args.currency ?? 'USD',
      pacing: 'even',
      status: args.status ?? 'confirmed',
      created_at: new Date().toISOString(),
    };
    if (args.status) order.status = args.status;
    orders.set(args.media_buy_id, order);
    return order;
  },

  forceStatus(mediaBuyId: string, status: MockOrder['status']): MockOrder['status'] | undefined {
    const order = orders.get(mediaBuyId);
    if (!order) return undefined;
    const previous = order.status;
    order.status = status;
    return previous;
  },

  addDelivery(
    mediaBuyId: string,
    delta: { impressions?: number; clicks?: number; spend?: number; currency?: string },
  ): void {
    const prev = deliverySim.get(mediaBuyId) ?? {
      impressions: 0,
      clicks: 0,
      spend: 0,
      currency: 'USD',
    };
    deliverySim.set(mediaBuyId, {
      impressions: prev.impressions + (delta.impressions ?? 0),
      clicks: prev.clicks + (delta.clicks ?? 0),
      spend: prev.spend + (delta.spend ?? 0),
      currency: delta.currency ?? prev.currency,
    });
  },
};
