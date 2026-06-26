import type { AccountStore, Account } from '@adcp/sdk/server';
import { PUBLISHER } from '../config/purrsonality.ts';

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
  // (sandbox/live differ only by mode). pagination_integrity_list_accounts/*
  // fails on this; see adcontextprotocol/adcp#4914 — runner gap, not impl bug.
  list: async (_filter, ctx) => {
    const account = accountForPrincipal(ctx?.authInfo?.clientId);
    return { items: [account] };
  },
  // sync_accounts surface — 3.1 measurement_accountability + delivery_reporting
  // storyboards drive setup through this before exercising the metrics-filter
  // assertions. Single-publisher reference impl has nothing to write upstream,
  // so we acknowledge each ref as `unchanged` (idempotent no-op) and echo the
  // resolved account back. The framework normalises the wire; we just need to
  // return a row per ref so the storyboard's `accounts[0].account_id` field
  // capture lands.
  upsert: async (refs, ctx) => {
    const account = accountForPrincipal(ctx?.authInfo?.clientId);
    return {
      accounts: refs.map(() => ({
        account: account as never,
        action: 'unchanged' as const,
      })),
    } as never;
  },
};
