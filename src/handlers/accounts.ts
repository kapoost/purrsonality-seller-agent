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
const SANDBOX_PRINCIPALS: ReadonlySet<string> = new Set([
  'purrsonality-test',
  'compliance-runner',
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
  list: async (_filter, ctx) => {
    const account = accountForPrincipal(ctx?.authInfo?.clientId);
    return { items: [account] };
  },
};
