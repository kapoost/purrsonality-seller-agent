import { definePlatform } from '@adcp/sdk/server';
import { accountStore, type PurrAccountMeta } from './handlers/accounts.ts';
import { sales } from './handlers/sales.ts';
import { signals } from './handlers/signals.ts';

export const platform = definePlatform<null, PurrAccountMeta>({
  capabilities: {
    specialisms: ['sales-non-guaranteed', 'signal-owned'] as const,
    channels: ['display'] as const,
    pricingModels: ['cpm'] as const,
    config: null,
    compliance_testing: {
      scenarios: [
        'force_media_buy_status',
        'simulate_delivery',
      ] as const,
    },
  },
  accounts: accountStore,
  sales,
  signals,
});
