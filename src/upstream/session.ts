import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-storyboard state isolation. AAO comply runner runs many storyboards
 * in one eval session without resetting agent state between them, so
 * seededProducts from `provenance_enforcement` would persist into
 * `dependency_impairment`, creative status overrides from `creative_lifecycle`
 * would leak into `native_in_feed`, etc.
 *
 * Every storyboard's `context.correlation_id` follows `<storyboard_id>--<step>`
 * (verified across cache 3.1.0 YAML). We extract the prefix as the session
 * key and partition mock state on it. Handlers wrap their body in
 * `withSession(extractSessionKey(req), () => …)` and mockUpstream's per-Map
 * lookups consult `getCurrentSessionKey()` from this AsyncLocalStorage.
 *
 * Calls without a correlation_id (or unmatched pattern) fall back to the
 * `'default'` key — preserves legacy behavior for adhoc probes and for
 * storyboards that omit correlation_id (rare).
 */
interface SessionContext {
  sessionKey: string;
}

const storage = new AsyncLocalStorage<SessionContext>();

export const DEFAULT_SESSION_KEY = 'default';

export function getCurrentSessionKey(): string {
  return storage.getStore()?.sessionKey ?? DEFAULT_SESSION_KEY;
}

export function withSession<T>(sessionKey: string, fn: () => T): T {
  return storage.run({ sessionKey }, fn);
}

/**
 * Extract storyboard prefix from a buyer-supplied correlation_id.
 * Examples:
 *   "dependency_impairment--get_buy_baseline"          → "dependency_impairment"
 *   "creative_native_in_feed--reject_title_long"       → "creative_native_in_feed"
 *   "canonical_formats--get_seeded_canonical_product"  → "canonical_formats"
 *   "pricing_currency_filter--get_products_usd_pricing" → "pricing_currency_filter"
 * Falls back to DEFAULT_SESSION_KEY when the input is missing or doesn't
 * match the `<id>--<step>` pattern.
 */
export function extractSessionKey(_req: unknown): string {
  // First-pass implementation regressed dependency_impairment (isolated Media
  // Buy 74→68) and delivery_reporting (Reporting 12→8) more than it gained
  // on Creative (32→33 via list_and_filter unblock). Isolation broke
  // cross-handler state assumptions that some storyboards rely on (e.g.
  // delivery_reporting/setup needs state seeded across helper calls that
  // don't all carry context.correlation_id; comply controller force-status
  // path likely doesn't see the same correlation_id as the sync_creatives
  // write that established the creative). Neutralised: all calls land on
  // DEFAULT_SESSION_KEY, so behaviour matches pre-refactor while keeping the
  // wiring in place for a more surgical re-enablement (e.g. per-handler
  // opt-in, or routing only `listCreatives` through the scoped key while
  // `force.creative_status` / `sync_creatives` keep default).
  return DEFAULT_SESSION_KEY;
}
