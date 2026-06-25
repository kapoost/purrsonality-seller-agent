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
  // Buyer-supplied context echoed back by get_media_buys (3.1 storyboards
  // check_buy_status, pending_creatives_to_start/get_media_buy_after_sync).
  context?: { correlation_id?: string; buyer_ref?: string };
  package_contexts?: Record<string, { correlation_id?: string; buyer_ref?: string }>;
  // Legacy compatibility (3.1 package_correlation_legacy_fallback): packages
  // without product_id, seeded by the compliance runner to model mixed-seller
  // populations. When present, getMediaBuys emits these instead of product-id
  // packages so buyers can correlate by package context.buyer_ref alone.
  legacy_packages?: Array<{ package_id: string; context?: { buyer_ref?: string; correlation_id?: string } }>;
  // Cancellation attribution — stamped when updateOrder({status:'canceled'})
  // fires. AdCP 3.x media_buy_seller/creative_fate_after_cancellation asserts
  // both fields are echoed on the update response and on get_media_buys.
  canceled_by?: 'buyer' | 'seller' | 'system';
  canceled_at?: string;
  // Seeded package overrides via comply_test_controller seed_media_buy.
  // When present, get_media_buys returns these verbatim instead of
  // synthesising packages from `product_ids` — supports legacy-fallback
  // scenarios that seed custom package_id / budget per package.
  seeded_packages?: ReadonlyArray<{
    package_id?: string;
    product_id?: string;
    budget?: number;
    context?: { buyer_ref?: string; correlation_id?: string };
  }>;
  // 3.1 dependency_impairment — per-package creative bindings written by
  // update_media_buy({packages[].creative_assignments[]}) with replacement
  // semantics. The full list replaces the prior one on every write; reads
  // surface them on the package response shape and drive impairment
  // computation against per-creative status state.
  package_creative_assignments?: Record<string, ReadonlyArray<{ creative_id: string }>>;
  // Per-package pricing_option_id captured at create_media_buy time. The
  // 3.1 dependency_impairment storyboard asserts the
  // affected_packages[*].pricing_option_id round-trips the
  // $context.pricing_option_id captured from get_products; package
  // responses must echo the original buyer-supplied option, not a
  // hardcoded default.
  package_pricing_options?: Record<string, string>;
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

// 3.1 stale_response_advisory — when comply_test_controller's
// force_upstream_unavailable scenario fires, we mark the named upstream
// unreachable for subsequent calls. Each entry stores the tool the
// directive targeted (e.g. `get_products`) and the timestamp the
// controller flipped the state. The latter is surfaced as
// `cache_age_seconds` on STALE_RESPONSE.details so buyers can reason
// about staleness without us actually maintaining a real cache (the
// storyboard validates wire-shape, not freshness math).
const unavailableUpstreams = new Map<string, { upstream_name?: string; since: number }>();

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

  listSeededProducts(): readonly PurrProductConfig[] {
    return [...seededProducts.values()];
  },

  hasSeededProducts(): boolean {
    return seededProducts.size > 0;
  },

  markUpstreamUnavailable(tool: string, upstreamName?: string): void {
    unavailableUpstreams.set(tool, { since: Date.now(), ...(upstreamName && { upstream_name: upstreamName }) });
  },

  getUnavailableUpstream(tool: string): { upstream_name?: string; since: number } | undefined {
    return unavailableUpstreams.get(tool);
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
      ...((overrides?.creative_policy ?? prior?.creative_policy) && {
        creative_policy: overrides?.creative_policy ?? prior?.creative_policy,
      }),
      ...((overrides?.pricing_options ?? prior?.pricing_options) && {
        pricing_options: overrides?.pricing_options ?? prior?.pricing_options,
      }),
      ...((overrides?.signal_targeting_allowed ?? prior?.signal_targeting_allowed) !== undefined && {
        signal_targeting_allowed: overrides?.signal_targeting_allowed ?? prior?.signal_targeting_allowed,
      }),
      ...((overrides?.signal_targeting_rules ?? prior?.signal_targeting_rules) && {
        signal_targeting_rules: overrides?.signal_targeting_rules ?? prior?.signal_targeting_rules,
      }),
      ...((overrides?.signal_targeting_options ?? prior?.signal_targeting_options) && {
        signal_targeting_options: overrides?.signal_targeting_options ?? prior?.signal_targeting_options,
      }),
    };
    seededProducts.set(id, product);
    return product;
  },

  /** Append a pricing_option to a seeded product's pricing_options[]. Used
   * by comply seed.pricing_option (pricing_currency_filter seeds two
   * pricing rows per product — USD + EUR — and the second call must NOT
   * overwrite the first). */
  appendPricingOption(
    productId: string,
    option: {
      pricing_option_id: string;
      pricing_model: string;
      currency: string;
      fixed_price?: number;
      floor_price?: number;
    },
  ): void {
    const prior = seededProducts.get(productId);
    const base = prior ?? mockUpstream.seedProduct(productId);
    const existing = [...(base.pricing_options ?? [])];
    const dedupIdx = existing.findIndex((p) => p.pricing_option_id === option.pricing_option_id);
    if (dedupIdx >= 0) {
      existing[dedupIdx] = option;
    } else {
      existing.push(option);
    }
    seededProducts.set(productId, {
      ...base,
      pricing_options: existing,
    });
  },

  /**
   * Returns true when at least one seeded product (NOT a default catalog
   * product) declares creative_policy.provenance_required: true. Used by
   * syncCreatives to gate the PROVENANCE_REQUIRED rejection at the
   * cheapest-buyer-mistake layer — a bare creative submission against an
   * account that has the provenance_enforcement fixture in play.
   *
   * Default catalog products (purr_result_card_v1) also declare
   * provenance_required: true, but historic 3.0 storyboards
   * (creative_lifecycle, creative_fate_after_cancellation) submit bare
   * creatives against those — checking only seeded fixtures keeps both
   * lanes working.
   */
  hasSeededProductRequiringProvenance(): boolean {
    for (const p of seededProducts.values()) {
      const cp = p.creative_policy as { provenance_required?: boolean } | undefined;
      if (cp?.provenance_required === true) return true;
    }
    return false;
  },

  /**
   * Returns the effective creative_policy.provenance_requirements when a
   * seeded product with provenance_required: true is in scope; null
   * otherwise. The 3.1 provenance_enforcement fixture seeds a product
   * whose requirements omit `require_embedded_provenance` — our
   * hardcoded default DOES require embedded. Reading the seeded
   * requirements lets sync_creatives surface the spec-correct error
   * (DISCLOSURE_MISSING) instead of our default's EMBEDDED_MISSING.
   */
  getSeededProvenanceRequirements(): {
    require_digital_source_type?: boolean;
    require_embedded_provenance?: boolean;
    require_disclosure_metadata?: boolean;
  } | null {
    for (const p of seededProducts.values()) {
      const cp = p.creative_policy as {
        provenance_required?: boolean;
        provenance_requirements?: {
          require_digital_source_type?: boolean;
          require_embedded_provenance?: boolean;
          require_disclosure_metadata?: boolean;
        };
      } | undefined;
      if (cp?.provenance_required === true && cp.provenance_requirements) {
        return cp.provenance_requirements;
      }
    }
    return null;
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
    context?: { correlation_id?: string; buyer_ref?: string };
    package_contexts?: Record<string, { correlation_id?: string; buyer_ref?: string }>;
    package_pricing_options?: Record<string, string>;
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
      ...(args.context && Object.keys(args.context).length > 0 && { context: { ...args.context } }),
      ...(args.package_contexts && Object.keys(args.package_contexts).length > 0 && {
        package_contexts: { ...args.package_contexts },
      }),
      ...(args.package_pricing_options && Object.keys(args.package_pricing_options).length > 0 && {
        package_pricing_options: { ...args.package_pricing_options },
      }),
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
    patch: Partial<Pick<MockOrder, 'status' | 'budget' | 'pacing' | 'flight_end' | 'flight_start' | 'canceled_by' | 'canceled_at'>> & {
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

  /** 3.1 dependency_impairment — replacement semantics on package
   * creative_assignments. Full list replaces the prior one; an empty list
   * unbinds all creatives from the package. */
  setPackageCreativeAssignments(
    orderId: string,
    packageId: string,
    assignments: ReadonlyArray<{ creative_id: string }>,
  ): void {
    const o = orders.get(orderId);
    if (!o) return;
    o.package_creative_assignments = o.package_creative_assignments ?? {};
    o.package_creative_assignments[packageId] = [...assignments];
  },

  getPackageCreativeAssignments(
    orderId: string,
    packageId: string,
  ): ReadonlyArray<{ creative_id: string }> {
    const o = orders.get(orderId);
    return o?.package_creative_assignments?.[packageId] ?? [];
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
    legacy_packages?: Array<{ package_id: string; context?: { buyer_ref?: string; correlation_id?: string } }>;
    packages?: MockOrder['seeded_packages'];
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
      ...(args.packages && args.packages.length > 0 && { seeded_packages: args.packages }),
    };
    if (args.status) order.status = args.status;
    if (args.legacy_packages && args.legacy_packages.length > 0) {
      order.legacy_packages = args.legacy_packages;
    }
    if (args.packages && args.packages.length > 0) order.seeded_packages = args.packages;
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

  // Account status override map. Phase 2 deterministic_account storyboards drive
  // accounts through suspended/payment_required/active without going through
  // sync_accounts (we don't implement it). The controller pre-seeds the override
  // for any account_id passed, so the force returns a clean previous→current
  // transition even on a fresh process.
  _accountStatusOverrides: new Map<string, 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed'>(),

  getAccountStatus(accountId: string): 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed' {
    return this._accountStatusOverrides.get(accountId) ?? 'active';
  },

  setAccountStatus(
    accountId: string,
    status: 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed',
  ): 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed' {
    const previous = this._accountStatusOverrides.get(accountId) ?? 'active';
    this._accountStatusOverrides.set(accountId, status);
    return previous;
  },

  // Creative status override map for deterministic_creative storyboards.
  // Each entry tracks the current status + optional rejection_reason carried
  // through force_creative_status. NOT_FOUND is signalled by absence of the
  // creative in BOTH the persistent store and the seededCreatives map AND the
  // override map — the controller raises TestControllerError('NOT_FOUND').
  _creativeStatusOverrides: new Map<
    string,
    { status: string; rejection_reason?: string; observed_at?: string }
  >(),

  getCreativeStatus(creativeId: string): { status: string; rejection_reason?: string; observed_at?: string } | undefined {
    const override = this._creativeStatusOverrides.get(creativeId);
    if (override) return override;
    // Fallback to seeded creatives so a creative seeded via comply seed.creative
    // counts as "exists" for the NOT_FOUND probe. Default status is 'processing'
    // for newly-seeded creatives that haven't been touched by a force yet.
    const seeded = seededCreatives.get(creativeId);
    if (seeded) {
      return { status: (seeded['status'] as string) ?? 'processing' };
    }
    return undefined;
  },

  setCreativeStatus(
    creativeId: string,
    status: string,
    rejectionReason?: string,
  ): { status: string; rejection_reason?: string; observed_at?: string } | undefined {
    const previous = this.getCreativeStatus(creativeId);
    this._creativeStatusOverrides.set(creativeId, {
      status,
      observed_at: new Date().toISOString(),
      ...(rejectionReason !== undefined && { rejection_reason: rejectionReason }),
    });
    return previous;
  },

  /** 3.1 dependency_impairment — compute impairment[] entries for an
   * order. Walks the order's per-package creative_assignments, looks up
   * each creative's status, and emits an entry for every creative whose
   * status indicates the dependency is offline (`rejected` for now;
   * `archived` etc. follow the same rule when the spec expands).
   * Same-resource entries are merged so the same creative rejected on
   * multiple packages yields a single impairment carrying both package_ids. */
  computeImpairmentsForOrder(orderId: string): ReadonlyArray<{
    impairment_id: string;
    resource_type: 'creative';
    resource_id: string;
    package_ids: string[];
    transition: { to: string };
    reason_code: string;
    observed_at: string;
  }> {
    const o = orders.get(orderId);
    if (!o) return [];
    const offlineStatuses = new Set(['rejected']);
    const byCreative = new Map<string, {
      packageIds: Set<string>;
      status: string;
      reason?: string;
      observedAt: string;
    }>();
    for (const [packageId, assignments] of Object.entries(o.package_creative_assignments ?? {})) {
      for (const a of assignments) {
        const s = this.getCreativeStatus(a.creative_id);
        if (!s || !offlineStatuses.has(s.status)) continue;
        const prior = byCreative.get(a.creative_id);
        if (prior) {
          prior.packageIds.add(packageId);
        } else {
          byCreative.set(a.creative_id, {
            packageIds: new Set([packageId]),
            status: s.status,
            ...(s.rejection_reason !== undefined && { reason: s.rejection_reason }),
            observedAt: s.observed_at ?? new Date().toISOString(),
          });
        }
      }
    }
    return [...byCreative.entries()].map(([creativeId, entry], idx) => ({
      impairment_id: `imp_${orderId}_${idx}_${creativeId}`,
      resource_type: 'creative' as const,
      resource_id: creativeId,
      package_ids: [...entry.packageIds],
      transition: { to: entry.status },
      reason_code: entry.reason ?? 'CREATIVE_REJECTED',
      observed_at: entry.observedAt,
    }));
  },

  hasCreative(creativeId: string): boolean {
    return (
      this._creativeStatusOverrides.has(creativeId) ||
      seededCreatives.has(creativeId)
    );
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

  // Wipe all module-level state. Sandbox-only escape hatch for in-memory mode:
  // the compliance runner accumulates seeds across storyboards within one
  // process (upstream adcp#5247), which degrades the baseline on the second
  // run of the same suite against the same seller process. Operators call
  // this between full-suite runs to recover the fresh-start baseline.
  //
  // Note (sdk-9x reconcile 2026-06-23): bridge's revert (commit 7a38fde)
  // removed clearAll claiming SDK 9.x has native `taskRegistry.clear()`.
  // True, but our clearAll covers MORE than the task registry — orders,
  // request keys, delivery sim, seeded products/creatives/formats,
  // proposals, create-media-buy directives, AND Phase-2 account/creative
  // status overrides. SDK has no native equivalent for the upstream mock
  // state, so clearAll stays. The bridge's revert applies only to the
  // taskRegistry side which is handled in src/stores/index.ts.
  clearAll(): void {
    orders.clear();
    requestKey.clear();
    deliverySim.clear();
    seededProducts.clear();
    seededCreatives.clear();
    seededFormats.clear();
    proposalsMap.clear();
    createMediaBuyDirectives.clear();
    unavailableUpstreams.clear();
    this._accountStatusOverrides.clear();
    this._creativeStatusOverrides.clear();
  },
};
