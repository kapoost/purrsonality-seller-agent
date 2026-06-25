import type { Env } from '../env.ts';

export interface PurrSignal {
  id: string;
  name: string;
  description: string;
  type: 'behavioral';
}

export const SIGNALS: readonly PurrSignal[] = [
  { id: 'purr_cat_owner',         name: 'Cat owner',                       description: 'Visitors who completed a feline-personality quiz.', type: 'behavioral' },
  { id: 'purr_persona_angel',     name: 'Cat owner — calm cat',            description: 'Result: low-arousal, sociable cat (The Velvet Whisper).', type: 'behavioral' },
  { id: 'purr_persona_hunter',    name: 'Cat owner — adventurous cat',     description: 'Result: bold, exploratory cat (The Daring Explorer).', type: 'behavioral' },
  { id: 'purr_persona_tornado',   name: 'Cat owner — high-energy cat',     description: 'Result: chaotic, hyperactive cat (The Tiny Tornado).', type: 'behavioral' },
  { id: 'purr_persona_trickster', name: 'Cat owner — mischievous cat',     description: 'Result: clever, rule-breaking cat (The Sly Trickster).', type: 'behavioral' },
  { id: 'purr_persona_tyrant',    name: 'Cat owner — assertive cat',       description: 'Result: dominant, defensive cat (The Tiny Tyrant).', type: 'behavioral' },
] as const;

export type MediaBuyActionMode = 'self_serve' | 'conditional_self_serve' | 'requires_approval';

export interface ProductAllowedAction {
  action: string;
  modes: readonly MediaBuyActionMode[];
  sla?: { response_max?: string; completion_max?: string };
  terms_ref?: string;
  allowed_statuses?: readonly string[];
}

// Seller's default billing measurement + makegood terms. Echoed verbatim on
// get_products under `measurement_terms`. Buyers may override at create_media_buy
// via package.measurement_terms; seller accepts / rejects via detectAggressiveTerms.
// AdCP 3.0.12+ MeasurementTerms shape (subset we expose). MakegoodRemedy enum
// values MUST match /schemas/3.0.x/enums/makegood-remedy.json — using anything
// else breaks JSON-schema validation in the comply runner and cascades into
// failures on every storyboard that asserts get_products response shape.
export interface PurrProductMeasurementTerms {
  billing_measurement?: {
    vendor: { domain: string };
    max_variance_percent?: number;
    measurement_window?: string;
  };
  makegood_policy?: {
    available_remedies: readonly ('additional_delivery' | 'credit' | 'invoice_adjustment')[];
  };
}

export interface PurrProductConfig {
  product_id: string;
  name: string;
  description: string;
  network_code: string;
  channel: 'display';
  format_ids: readonly string[];
  ad_unit_ids: readonly string[];
  min_cpm: number;
  currency: string;
  min_spend: number;
  estimated_impressions_per_month: number;
  allowed_actions?: readonly ProductAllowedAction[];
  measurement_terms?: PurrProductMeasurementTerms;
  /** Optional pricing_option_id override. When set, getProducts uses this
   * exact ID instead of the auto-generated cpm_fixed_<price> from
   * buildProduct. Used by comply seed.pricing_option to inject the
   * fixture's `pricing_option_id` (e.g. `cpm_auction` for the
   * sales-non-guaranteed specialism storyboard). */
  pricing_option_id?: string;
  /** Optional pricing model override. Auction-based specialisms (e.g.
   * sales-non-guaranteed) seed `cpm` but expect `floor_price` semantics
   * instead of `fixed_price`. Tracking the model lets getProducts emit
   * either shape depending on the comply fixture. */
  pricing_kind?: 'fixed' | 'floor';
  /** Optional creative_policy override. AAO comply 3.1
   * provenance_enforcement seeds a product with creative_policy declaring
   * provenance_required/requirements/accepted_verifiers; getProducts
   * surfaces it verbatim so the storyboard's policy-discovery phase
   * passes. When unset, getProducts emits the default hardcoded policy. */
  creative_policy?: Record<string, unknown>;
  /** Optional multi-currency pricing_options. Storyboards (3.1
   * pricing_currency_filter) seed two pricing_option rows per product —
   * one USD, one EUR — and assert get_products with
   * filters.pricing_currencies prunes to the requested set. When present,
   * getProducts emits this array verbatim via buildPricingOption and the
   * filter logic operates on it. When absent, the legacy
   * single-pricing-option shape (min_cpm + currency + pricing_option_id)
   * stays canonical. */
  pricing_options?: ReadonlyArray<{
    pricing_option_id: string;
    pricing_model: string;
    currency: string;
    fixed_price?: number;
    floor_price?: number;
  }>;
  /** Optional signal targeting. pricing_currency_filter seeds two
   * variants — `selection_mode: optional` (skippable) and
   * `selection_mode: fixed` (mandatory). When fixed and the signal's
   * pricing_options have NO entry in a requested currency, the product
   * is excluded from filter results. Stored verbatim from the comply
   * fixture for round-trip echoing on get_products. */
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
  /** 3.1 canonical_formats — dual-emission format declarations.
   * Stored verbatim from comply seed.product; getProducts surfaces both
   * legacy format_ids and canonical format_options so buyers can pick
   * either migration shape. */
  format_options?: ReadonlyArray<Record<string, unknown>>;
  /** 3.1 canonical_formats fixture also seeds publisher_properties[],
   * delivery_type override, and a vendor_metric specific to the test
   * (used by filters.required_vendor_metrics to isolate the seeded
   * product among the global catalog). */
  publisher_properties?: ReadonlyArray<Record<string, unknown>>;
  delivery_type?: string;
  vendor_metrics?: ReadonlyArray<{
    vendor: { domain: string };
    metric_id: string;
  }>;
}

export const PRODUCTS: readonly PurrProductConfig[] = [
  {
    product_id: 'purr_result_card_v1',
    name: 'Purrsonality result page slot',
    description: 'Display ad on the result page directly after a user completes the cat-personality quiz. High-context, post-engagement placement with strong cat-owner intent.',
    network_code: 'purrsonality',
    channel: 'display',
    format_ids: ['display_300x250', 'display_responsive'],
    ad_unit_ids: ['purrsonality/result_page'],
    min_cpm: 1.5,
    currency: 'USD',
    min_spend: 100,
    estimated_impressions_per_month: 100_000,
    // Seller-default billing measurement + makegood terms. Declares
    // `attentionvendor.example` as the billing vendor (matching the
    // attention_score entry in reporting_capabilities.vendor_metrics)
    // with a 10% variance ceiling and post-SIVT reconciliation window.
    // Buyers may propose alternate measurement_terms on create_media_buy;
    // aggressive proposals (required_panels, post_click_days > 30,
    // max_variance < 5%, max_variance_percent < 1%, measurement_window
    // beyond c7) are rejected with TERMS_REJECTED — see
    // detectAggressiveTerms in inventory/purrsonality.ts. Required by
    // media_buy_seller/measurement_terms_rejected/discover_products.
    measurement_terms: {
      billing_measurement: {
        vendor: { domain: 'attentionvendor.example' },
        max_variance_percent: 10,
        measurement_window: 'post_sivt',
      },
      makegood_policy: {
        available_remedies: ['additional_delivery', 'credit'],
      },
    },
  },
] as const;

export const FORMATS = [
  { format_id: 'display_300x250',  name: 'Medium rectangle',       width: 300, height: 250 },
  { format_id: 'display_responsive', name: 'Responsive display', width: 0,   height: 0   },
] as const;

export const PUBLISHER = {
  network_code: 'purrsonality',
  display_name: 'Purrsonality',
  adcp_publisher: 'purrsonality.rocketscience.pl',
} as const;

export function formatAgentUrl(env: Env): string {
  return `${env.PUBLIC_BASE_URL}/.well-known/formats`;
}
