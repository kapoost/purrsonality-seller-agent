import type { AccountStore, Account } from '@adcp/sdk/server';
import { PUBLISHER } from '../config/purrsonality.ts';
import { mockUpstream } from '../upstream/mock.ts';

export interface PurrAccountMeta {
  network_code: string;
}

const SANDBOX_ID_PREFIX = 'sandbox_';

// Principals authorized for sandbox routing. The SDK sandbox-authority gate
// (comply_test_controller) admits dispatch only when the resolved account
// carries `mode: 'sandbox'`. Wire-level `account.sandbox: true` is ignored
// per spec — resolver-wins, so a live principal can't forge sandbox routing
// by sending the claim on the wire.
// All authenticated principals route to sandbox on this reference seller.
// `purrsonality-seller` is a single-publisher demo brand-agent — there is no
// real-money production flow gated behind `mode: 'live'`. Single-mode keeps
// AAO comply_test_controller reachable from any saved bearer (the SDK gates
// the controller on `account.mode === 'sandbox' | 'mock'`) without forcing
// adopters of this reference impl to provision a separate ADCP_TEST_TOKEN
// and re-Authorize in the AAO dashboard.
//
// For sellers that DO need a live/sandbox distinction, the prior shape was:
//   const SANDBOX_PRINCIPALS = new Set(['purrsonality-test', 'compliance-runner']);
// gating only those principals to sandbox; everything else fell through to
// `mode: 'live'`. Restore that shape when real-money flow lands.
const SANDBOX_PRINCIPALS: ReadonlySet<string> = new Set([
  'purrsonality-dev',
  'purrsonality-test',
  'purrsonality-addie-test',
  'compliance-runner',
  'compliance-runner-live',
]);

function buildAccount(overrides?: Partial<Account<PurrAccountMeta>>): Account<PurrAccountMeta> {
  return {
    id: PUBLISHER.network_code,
    name: PUBLISHER.display_name,
    status: 'active',
    ctx_metadata: { network_code: PUBLISHER.network_code },
    ...overrides,
  };
}

function accountForPrincipal(principal: string | undefined): Account<PurrAccountMeta> {
  const isSandbox = principal !== undefined && SANDBOX_PRINCIPALS.has(principal);
  if (isSandbox) {
    return buildAccount({
      id: `${SANDBOX_ID_PREFIX}${PUBLISHER.network_code}`,
      name: `Sandbox: ${PUBLISHER.display_name}`,
      mode: 'sandbox',
    } as Partial<Account<PurrAccountMeta>>);
  }
  return buildAccount({ mode: 'live' } as Partial<Account<PurrAccountMeta>>);
}

// In-memory account-level notification_configs store, keyed by account_id.
// Lives for the lifetime of the process — single-publisher demo seller doesn't
// need durable subscriber state, but the 3.1 notification_config_lifecycle
// storyboard's phase-2 `replace_pause_and_clear` needs sync_accounts writes
// to survive at least until the next list_accounts read.
//
// Replace semantics per spec (notification_config_lifecycle): the seller
// stores the full submitted set keyed by `subscriber_id`. A re-send of the
// same `subscriber_id` REPLACES the entry in place (no duplicate). An empty
// `notification_configs: []` clears the account's subscriber set entirely.
interface PersistedNotificationConfig {
  subscriber_id: string;
  url: string;
  event_types: readonly string[];
  active: boolean;
}
const notificationConfigsByAccount: Map<string, PersistedNotificationConfig[]> = new Map();

// Per-account brand+operator, captured at provisioning time. Settings-update
// mode (`accounts[i].account.account_id`) doesn't carry brand/operator on the
// request — sync-accounts-response.json requires both on every echoed row, so
// the seller MUST look them up from the prior provisioning state. Without
// this lookup, the response per-row was `brand: undefined, operator: ""` and
// failed schema validation on the replace_pause_and_clear storyboard step.
const accountKeyByAccount: Map<string, { brand: { domain: string }; operator: string }> = new Map();

// 3.1 notification-type.json splits into two anchor surfaces:
//   - account-level: `creative.*`, `product.*`, `signal.*`,
//     `wholesale_feed.bulk_change`
//   - media-buy-level: `scheduled`, `final`, `delayed`, `adjusted`, `impairment`
// JSON Schema permits the full enum on every notification_configs[]; the
// rejection is semantic. Account-level notification_configs MUST reject
// media-buy-anchored types. We accept any `creative.`/`product.`/`signal.`
// prefix OR the canonical `wholesale_feed.bulk_change` literal.
const MEDIA_BUY_ANCHORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'scheduled', 'final', 'delayed', 'adjusted', 'impairment',
]);
function isMediaBuyAnchoredEvent(eventType: string): boolean {
  return MEDIA_BUY_ANCHORED_EVENT_TYPES.has(eventType);
}

export const accountStore: AccountStore<PurrAccountMeta> = {
  resolution: 'explicit',
  resolve: async (ref, ctx) => {
    const principal = ctx?.authInfo?.clientId;
    const isSandbox = principal !== undefined && SANDBOX_PRINCIPALS.has(principal);

    if (isSandbox) {
      const brand = (ref as { brand?: { domain?: string } } | undefined)?.brand;
      const operator = (ref as { operator?: string } | undefined)?.operator;
      return buildAccount({
        id: `${SANDBOX_ID_PREFIX}${PUBLISHER.network_code}`,
        name: `Sandbox: ${PUBLISHER.display_name}`,
        mode: 'sandbox',
        ...(operator !== undefined && { operator }),
        ...(brand?.domain !== undefined && { brand: { domain: brand.domain } }),
      } as Partial<Account<PurrAccountMeta>>);
    }

    return buildAccount({ mode: 'live' } as Partial<Account<PurrAccountMeta>>);
  },
  // Single-publisher first-party model: each principal resolves to one account
  // (sandbox/live differ only by mode). 3.1 pagination_integrity_list_accounts
  // requires multi-account list — we surface comply-seeded sandbox accounts
  // alongside the primary singleton so the storyboard's max_results=2 +
  // continuation walk has the three accounts it needs.
  list: async (filter, ctx) => {
    const primary = accountForPrincipal(ctx?.authInfo?.clientId);
    // Echo any persisted notification_configs for this account so the
    // notification_config_lifecycle storyboard's list_accounts step sees what
    // sync_accounts just wrote. Cast to never because the SDK's typed
    // Account<TCtxMeta> doesn't include the wire AccountLite extras —
    // framework projector passes through unknown keys.
    const primaryConfigs = notificationConfigsByAccount.get(primary.id);
    const primaryWithConfigs = primaryConfigs !== undefined
      ? ({ ...primary, notification_configs: primaryConfigs } as unknown as Account<PurrAccountMeta>)
      : primary;
    const sandbox = mockUpstream.listSeededAccounts().map((fixture) => {
      const fx = fixture as { account_id?: string; brand?: { domain?: string }; operator?: string };
      const id = fx.account_id ?? `seeded_${Date.now()}`;
      const configs = notificationConfigsByAccount.get(id);
      return {
        id,
        name: fx.account_id ?? 'Seeded sandbox account',
        status: 'active' as const,
        ctx_metadata: { network_code: PUBLISHER.network_code },
        mode: 'sandbox',
        ...(fx.operator && { operator: fx.operator }),
        ...(fx.brand?.domain && { brand: { domain: fx.brand.domain } }),
        ...(configs !== undefined && { notification_configs: configs }),
      } as unknown as Account<PurrAccountMeta>;
    });
    const items = [primaryWithConfigs, ...sandbox];
    const filterAny = filter as { sandbox?: boolean; account?: { account_id?: string } } | undefined;
    let filtered = items;
    // `sandbox: true` → keep only mode==='sandbox' rows (primary is already
    // in sandbox mode for sandbox principals). Previously this only returned
    // seeded accounts, which excluded the primary even when its mode matched.
    // notification_config_lifecycle's list_accounts step gates on the primary
    // being returned.
    if (filterAny?.sandbox === true) {
      filtered = filtered.filter((a) => (a as { mode?: string }).mode === 'sandbox');
    }
    // Account-id filter: storyboard's list_accounts often targets a specific
    // account_id captured from a previous sync_accounts step. Without this,
    // the notification_config_lifecycle list step received the full list and
    // the field_value assertion on accounts[0].account_id failed when the
    // primary singleton wasn't the targeted ID.
    const targetAccountId = filterAny?.account?.account_id;
    if (typeof targetAccountId === 'string') {
      filtered = filtered.filter((a) => a.id === targetAccountId);
    }
    return { items: filtered };
  },
  // sync_accounts surface — 3.1 measurement_accountability + delivery_reporting
  // storyboards drive setup through this before exercising main assertions.
  // 3.1 notification_config_lifecycle additionally drives subscriber registration
  // through here: each wire account carries `notification_configs[]`, the seller
  // persists per (account_id, subscriber_id), and the response echoes the stored
  // bindings back. Single-publisher reference impl has nothing to write upstream,
  // so we acknowledge each ref as `unchanged` (idempotent no-op), thread any
  // notification_configs from the wire body (`ctx.input.accounts[i].notification_configs`),
  // and echo them verbatim on the per-account row.
  upsert: async (refs, ctx) => {
    const principal = ctx?.authInfo?.clientId;
    const account = accountForPrincipal(principal);
    // billing-gate-dispatch/per_agent_gate_reject: when the caller is the
    // passthrough-only test principal (demo-billing-passthrough-v1 →
    // 'compliance-runner-passthrough') and submits `billing: agent`, the
    // seller MUST reject per-account with BILLING_NOT_PERMITTED_FOR_AGENT
    // and an `error.details` shape limited to `rejected_billing` plus
    // optional `suggested_billing` (per
    // error-details/billing-not-permitted-for-agent.json — anything else
    // leaks per-agent commercial state and fails the storyboard's
    // additionalProperties: false assertion).
    const isPassthroughOnly = principal === 'compliance-runner-passthrough';
    // Read the full wire body — provisioning mode keeps `brand` / `operator`
    // at the entry root; settings-update mode wraps the ref in `entry.account`
    // and keeps `notification_configs` / `payment_terms` at the entry root.
    type WireEntry = {
      brand?: { domain?: string };
      operator?: string;
      account?: { account_id?: string };
      billing?: string;
      payment_terms?: string;
      notification_configs?: ReadonlyArray<{
        subscriber_id?: string;
        url?: string;
        event_types?: ReadonlyArray<string>;
        active?: boolean;
      }>;
    };
    const wireBody = ((ctx as unknown as { input?: { accounts?: WireEntry[] } } | undefined)?.input)?.accounts;
    return refs.map((ref, i) => {
      const wire = wireBody?.[i];
      const refAny = ref as { brand?: unknown; operator?: string; account_id?: string };
      // Settings-update mode keys via `entry.account.account_id`; provisioning
      // mode has no account_id (seller assigns one). Either resolves to our
      // singleton sandbox account underneath — single-publisher demo.
      const wireAccountId = wire?.account?.account_id;
      const accountId = wireAccountId ?? refAny.account_id ?? account.id;
      const isSettingsUpdate = wireAccountId !== undefined || refAny.account_id !== undefined;

      // Resolve brand + operator on the response. For provisioning mode they
      // come from the wire entry root; for settings-update they're absent on
      // the wire and we look them up from the stored provisioning state.
      // sync-accounts-response.json marks both as required on every echoed row.
      const wireBrand = (wire?.brand ?? (refAny.brand as { domain?: string } | undefined));
      const wireOperator = wire?.operator ?? refAny.operator;
      const stored = accountKeyByAccount.get(accountId);
      const brand = wireBrand?.domain ? wireBrand : stored?.brand;
      const operator = wireOperator ?? stored?.operator ?? 'unknown.example';
      if (wireBrand?.domain && wireOperator) {
        accountKeyByAccount.set(accountId, {
          brand: { domain: wireBrand.domain },
          operator: wireOperator,
        });
      }

      // Per-buyer-agent commercial gate: passthrough-only callers may only
      // submit billing: operator. Submit billing: agent → reject the entry
      // with BILLING_NOT_PERMITTED_FOR_AGENT carrying the clamped details
      // shape (rejected_billing + suggested_billing only). Capability-gate
      // (BILLING_NOT_SUPPORTED) is handled by the SDK's commercial-policy
      // enforcer based on supportedBillings — this branch catches the
      // per-agent gate that supportedBillings alone cannot express.
      if (isPassthroughOnly && wire?.billing === 'agent') {
        return {
          account_id: accountId,
          brand: brand as never,
          operator: operator,
          action: 'failed' as const,
          status: 'rejected' as const,
          errors: [{
            code: 'BILLING_NOT_PERMITTED_FOR_AGENT' as const,
            message: 'Billing value "agent" is not permitted for this buyer agent.',
            field: 'accounts[].billing',
            recovery: 'correctable' as const,
            details: {
              rejected_billing: 'agent',
              suggested_billing: 'operator',
            },
          }],
        } as never;
      }

      // Validate notification_configs[] semantics: subscriber_id uniqueness
      // (notification_config_rejections) and account-scope event_types
      // (notification_config_event_scope). Both surfaces report per-entry
      // validation failures inside a transport-level success — the per-account
      // entry gets `action: failed, status: rejected, errors: [...]`.
      const configs = wire?.notification_configs;
      if (Array.isArray(configs)) {
        const seen = new Set<string>();
        for (let j = 0; j < configs.length; j++) {
          const cfg = configs[j];
          if (cfg?.subscriber_id !== undefined) {
            if (seen.has(cfg.subscriber_id)) {
              return {
                account_id: accountId,
                brand: brand as never,
                operator: operator,
                action: 'failed' as const,
                status: 'rejected' as const,
                errors: [{
                  code: 'INVALID_REQUEST' as const,
                  message: `Duplicate subscriber_id "${cfg.subscriber_id}" in notification_configs[]`,
                  field: `notification_configs[${j}].subscriber_id`,
                  recovery: 'correctable' as const,
                }],
              } as never;
            }
            seen.add(cfg.subscriber_id);
          }
          // Account-level notification_configs MUST reject media-buy-anchored
          // event_types ('scheduled', 'final', 'delayed', 'adjusted',
          // 'impairment'). They belong on push_notification_config.
          if (Array.isArray(cfg?.event_types)) {
            for (let k = 0; k < cfg.event_types.length; k++) {
              const et = cfg.event_types[k];
              if (et !== undefined && isMediaBuyAnchoredEvent(et)) {
                return {
                  account_id: accountId,
                  brand: brand as never,
                  operator: operator,
                  action: 'failed' as const,
                  status: 'rejected' as const,
                  errors: [{
                    code: 'INVALID_REQUEST' as const,
                    message: `Event type "${et}" is media-buy-anchored and not permitted on account-level notification_configs[]; use push_notification_config on the buy instead.`,
                    field: `notification_configs[${j}].event_types[${k}]`,
                    recovery: 'correctable' as const,
                  }],
                } as never;
              }
            }
          }
        }
      }

      // Persist with replace-by-subscriber_id semantics. Empty array clears
      // (notification_config_lifecycle/sync_accounts_clear_subscribers). Omit
      // ⇒ no-op (preserve any existing state).
      if (Array.isArray(configs)) {
        if (configs.length === 0) {
          notificationConfigsByAccount.delete(accountId);
        } else {
          notificationConfigsByAccount.set(
            accountId,
            configs
              .filter((c): c is { subscriber_id: string; url: string; event_types: readonly string[]; active: boolean } =>
                typeof c?.subscriber_id === 'string' && typeof c.url === 'string'
                && Array.isArray(c.event_types) && typeof c.active === 'boolean')
              .map((c) => ({
                subscriber_id: c.subscriber_id,
                url: c.url,
                event_types: c.event_types,
                active: c.active,
              })),
          );
        }
      }
      const persisted = notificationConfigsByAccount.get(accountId);

      // No account_id on request ⇒ provisioning ⇒ 'created'.
      // account_id on request ⇒ settings-update ⇒ 'updated'.
      const action: 'created' | 'updated' = isSettingsUpdate ? 'updated' : 'created';

      return {
        account_id: accountId,
        brand: brand as never,
        operator: operator,
        name: account.name,
        action,
        status: 'active' as const,
        ...(wire?.billing && { billing: wire.billing as never }),
        ...(wire?.payment_terms && { payment_terms: wire.payment_terms as never }),
        ...(persisted !== undefined && { notification_configs: persisted as never }),
      };
    }) as never;
  },
};
