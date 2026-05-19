import { defineSignalsPlatform, type SignalsPlatform } from '@adcp/sdk/server';
import type {
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalSuccess,
  Deployment,
} from '@adcp/sdk';
import { SIGNALS, PUBLISHER } from '../config/purrsonality.ts';
import type { PurrAccountMeta } from './accounts.ts';

const DATA_PROVIDER_NAME = 'Purrsonality';
const DATA_PROVIDER_DOMAIN = PUBLISHER.adcp_publisher;
const INTERNAL_PLATFORM = 'purrsonality_internal';
const DEFAULT_PAGE_SIZE = 25;

const COVERAGE_PCT: Record<string, number> = {
  purr_cat_owner: 100,
  purr_persona_angel: 22,
  purr_persona_hunter: 18,
  purr_persona_tornado: 17,
  purr_persona_trickster: 23,
  purr_persona_tyrant: 20,
};

function buildDeployment(isLive = true): Deployment {
  return {
    type: 'platform',
    platform: INTERNAL_PLATFORM,
    is_live: isLive,
  };
}

function matchesSpec(spec: string, signalName: string, signalDesc: string): boolean {
  if (!spec) return true;
  const tokens = spec
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  const hay = `${signalName} ${signalDesc}`.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

function decodeCursor(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function encodeCursor(offset: number): string {
  return String(offset);
}

export const signals: SignalsPlatform<PurrAccountMeta> = defineSignalsPlatform<PurrAccountMeta>({
  async getSignals(req: GetSignalsRequest, _ctx): Promise<GetSignalsResponse> {
    const r = req as unknown as {
      signal_spec?: string;
      signal_ids?: Array<
        | { source: 'catalog'; data_provider_domain: string; id: string }
        | { source: 'agent'; agent_url: string; id: string }
      >;
      max_results?: number;
      pagination?: { max_results?: number; cursor?: string };
    };

    const idFilter = new Set(
      (r.signal_ids ?? [])
        .filter((ref) => ref.source !== 'catalog' || ref.data_provider_domain === DATA_PROVIDER_DOMAIN)
        .map((ref) => ref.id),
    );
    const spec = r.signal_spec ?? '';

    let filtered = SIGNALS.filter((s) => {
      if (idFilter.size > 0) return idFilter.has(s.id);
      return matchesSpec(spec, s.name, s.description);
    });

    if (filtered.length === 0 && idFilter.size === 0) {
      filtered = [...SIGNALS];
    }

    const pageSize = Math.max(
      1,
      Math.min(100, r.pagination?.max_results ?? r.max_results ?? DEFAULT_PAGE_SIZE),
    );
    const offset = decodeCursor(r.pagination?.cursor);
    const page = filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < filtered.length;

    return {
      pagination: {
        has_more: hasMore,
        ...(hasMore && { cursor: encodeCursor(nextOffset) }),
        total_count: filtered.length,
      },
      signals: page.map((s) => ({
        signal_id: {
          source: 'catalog' as const,
          data_provider_domain: DATA_PROVIDER_DOMAIN,
          id: s.id,
        },
        signal_agent_segment_id: s.id,
        name: s.name,
        description: s.description,
        value_type: 'binary' as const,
        signal_type: 'owned' as const,
        data_provider: DATA_PROVIDER_NAME,
        coverage_percentage: COVERAGE_PCT[s.id] ?? 50,
        deployments: [buildDeployment(true)],
        pricing_options: [
          {
            pricing_option_id: 'po_cpm_default',
            model: 'cpm' as const,
            cpm: 0.5,
            currency: 'USD',
          },
        ],
      })),
    };
  },

  async activateSignal(_req: ActivateSignalRequest, _ctx): Promise<ActivateSignalSuccess> {
    return {
      deployments: [buildDeployment(true)],
    };
  },
});
