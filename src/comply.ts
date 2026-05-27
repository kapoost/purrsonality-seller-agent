import type { ComplyControllerConfig } from '@adcp/sdk/testing';
import { mockUpstream } from './upstream/mock.ts';
import { PUBLISHER } from './config/purrsonality.ts';

function mockStatus(wire: string): 'confirmed' | 'delivering' | 'paused' | 'completed' {
  if (wire === 'paused') return 'paused';
  if (wire === 'completed' || wire === 'canceled' || wire === 'rejected') return 'completed';
  if (wire === 'pending_creatives' || wire === 'pending_start') return 'confirmed';
  return 'confirmed';
}

export const complyTest: ComplyControllerConfig = {
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
      };
      // Only keep format_ids that this seller actually surfaces in
      // list_creative_formats; otherwise storyboards that cross-walk
      // get_products → list_creative_formats trip on phantom IDs. Unknown
      // fixture format_ids (e.g. "video_30s" from generic test kits) are
      // dropped so the seeded product falls back to the publisher's default
      // format set.
      const knownFormats = new Set(['display_300x250', 'display_responsive']);
      const format_ids = Array.isArray(fixture.format_ids)
        ? fixture.format_ids
            .map((f) => (typeof f === 'string' ? f : f?.id))
            .filter((s): s is string => typeof s === 'string' && knownFormats.has(s))
        : undefined;
      mockUpstream.seedProduct(params.product_id, {
        ...(fixture.name !== undefined && { name: fixture.name }),
        ...(fixture.description !== undefined && { description: fixture.description }),
        ...(format_ids && format_ids.length > 0 && { format_ids }),
        ...(fixture.allowed_actions && { allowed_actions: fixture.allowed_actions }),
      });
    },
    pricing_option: async (params) => {
      const fixture = params.fixture as { fixed_price?: number; floor_price?: number; currency?: string };
      mockUpstream.seedProduct(params.product_id, {
        ...(fixture.fixed_price !== undefined && { min_cpm: fixture.fixed_price }),
        ...(fixture.floor_price !== undefined && { min_cpm: fixture.floor_price }),
        ...(fixture.currency !== undefined && { currency: fixture.currency }),
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
      };
      mockUpstream.seedOrder({
        media_buy_id: params.media_buy_id,
        network_code: PUBLISHER.network_code,
        advertiser_id: PUBLISHER.network_code,
        product_ids: fixture.product_ids ?? [],
        budget: fixture.budget ?? 0,
        currency: fixture.currency ?? 'USD',
        ...(fixture.status && { status: mockStatus(fixture.status) }),
      });
    },
  },

  force: {
    create_media_buy_arm: async (params) => {
      const accountId = `sandbox_${PUBLISHER.network_code}`;
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
  },
};
