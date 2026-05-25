// Sandbox delivery simulator — synthesises impressions/clicks/spend for a
// media buy so buyer agents can integration-test the full create→deliver
// →report loop without real impressions being served. Inspired by
// adcontextprotocol/salesagent's src/services/delivery_simulator.py but
// kept pure and deterministic.
//
// Determinism: a hash of media_buy_id + ISO date is used as a per-day RNG
// seed. Calling the simulator multiple times for the same media buy and
// reporting period returns identical numbers — buyer assertions don't
// flake across retries.
//
// Pacing model:
//   - daily budget = total_budget / flight_days
//   - daily impressions = daily_budget * 1000 / CPM
//   - CTR is per-media-buy (0.5–2.5%), drawn from the seed
//   - cumulative spend ramps linearly inside a day, no cliff at midnight
//   - if the period ends mid-flight, partial-day pro-rata is applied
//   - if the period covers the full flight, totals never exceed budget
//
// Pacing index reported to the buyer = actual_spend / expected_spend
//   over the reporting period (1.0 = on track, <1 underdelivering,
//   >1 ahead-of-pace). Mock always returns 1.0 — no over/underpacing
//   scenarios yet. Add jitter when buyers start exercising the metric.

const ASSUMED_CPM = 1.5;
const CLICKS_PER_THOUSAND_IMPRESSIONS_MIN = 5; // 0.5% CTR
const CLICKS_PER_THOUSAND_IMPRESSIONS_MAX = 25; // 2.5% CTR

interface SimulateInput {
  mediaBuyId: string;
  budget: number;
  currency: string;
  flightStart?: string;
  flightEnd?: string;
  status: 'pending_creatives' | 'pending_start' | 'confirmed' | 'delivering' | 'paused' | 'completed' | 'canceled' | 'rejected';
  periodStart: string;
  periodEnd: string;
}

interface SimulatedDelivery {
  impressions: number;
  clicks: number;
  spend: number;
  currency: string;
  pacing_index: number;
}

/** djb2-style hash that's stable cross-run. Returns 32-bit unsigned int. */
function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/** Map a hash to a number in [min, max]. */
function hashToRange(seed: string, min: number, max: number): number {
  const h = hash32(seed);
  const u = (h % 100_000) / 100_000;
  return min + u * (max - min);
}

export function simulateDelivery(input: SimulateInput): SimulatedDelivery {
  // Terminal states or no budget → zero delivery
  if (
    input.budget <= 0 ||
    input.status === 'canceled' ||
    input.status === 'rejected' ||
    input.status === 'pending_creatives' ||
    input.status === 'pending_start'
  ) {
    return {
      impressions: 0,
      clicks: 0,
      spend: 0,
      currency: input.currency,
      pacing_index: 1.0,
    };
  }

  // Flight bounds — default to "started 1 day before period, ends 7 days
  // after period" so a getDelivery query without explicit dates still gets
  // meaningful numbers.
  const periodStartMs = Date.parse(input.periodStart);
  const periodEndMs = Date.parse(input.periodEnd);
  const flightStartMs = input.flightStart ? Date.parse(input.flightStart) : periodStartMs - 86_400_000;
  const flightEndMs = input.flightEnd ? Date.parse(input.flightEnd) : periodEndMs + 7 * 86_400_000;

  const flightDurationMs = Math.max(86_400_000, flightEndMs - flightStartMs);
  const flightDays = Math.max(1, flightDurationMs / 86_400_000);

  // Daily budget and daily impressions assuming the floor CPM
  const dailyBudget = input.budget / flightDays;
  const dailyImpressions = (dailyBudget * 1000) / ASSUMED_CPM;

  // Active overlap between flight and reporting period (ms)
  const overlapStartMs = Math.max(flightStartMs, periodStartMs);
  const overlapEndMs = Math.min(flightEndMs, periodEndMs);
  if (overlapEndMs <= overlapStartMs) {
    return {
      impressions: 0,
      clicks: 0,
      spend: 0,
      currency: input.currency,
      pacing_index: 1.0,
    };
  }
  const overlapDays = (overlapEndMs - overlapStartMs) / 86_400_000;

  let impressions = Math.round(dailyImpressions * overlapDays);
  let spend = +(dailyBudget * overlapDays).toFixed(2);

  // Paused buys: keep accumulated delivery up to pause, no growth after.
  // For the mock, treat 'paused' as "delivery froze at 60% of overlap".
  if (input.status === 'paused') {
    impressions = Math.round(impressions * 0.6);
    spend = +(spend * 0.6).toFixed(2);
  }

  // CTR drawn deterministically from media_buy_id
  const ctrSeed = `${input.mediaBuyId}:ctr`;
  const clicksPerThousand = hashToRange(
    ctrSeed,
    CLICKS_PER_THOUSAND_IMPRESSIONS_MIN,
    CLICKS_PER_THOUSAND_IMPRESSIONS_MAX,
  );
  const clicks = Math.round((impressions / 1000) * clicksPerThousand);

  return {
    impressions,
    clicks,
    spend,
    currency: input.currency,
    pacing_index: 1.0,
  };
}
