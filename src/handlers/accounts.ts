import type { AccountStore, Account } from '@adcp/sdk/server';
import { PUBLISHER } from '../config/purrsonality.ts';

export interface PurrAccountMeta {
  network_code: string;
}

const SANDBOX_ID_PREFIX = 'sandbox_';

function buildAccount(overrides?: Partial<Account<PurrAccountMeta>>): Account<PurrAccountMeta> {
  return {
    id: PUBLISHER.network_code,
    name: PUBLISHER.display_name,
    status: 'active',
    ctx_metadata: { network_code: PUBLISHER.network_code },
    ...overrides,
  };
}

export const accountStore: AccountStore<PurrAccountMeta> = {
  resolution: 'explicit',
  resolve: async (ref) => {
    if (ref && 'sandbox' in ref && ref.sandbox === true) {
      const brand = (ref as { brand?: { domain?: string } }).brand;
      const operator = (ref as { operator?: string }).operator;
      return buildAccount({
        id: `${SANDBOX_ID_PREFIX}${PUBLISHER.network_code}`,
        name: `Sandbox: ${PUBLISHER.display_name}`,
        mode: 'sandbox',
        ...(operator !== undefined && { operator }),
        ...(brand?.domain !== undefined && { brand: { domain: brand.domain } }),
      } as Partial<Account<PurrAccountMeta>>);
    }

    return buildAccount();
  },
};
