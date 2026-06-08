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
