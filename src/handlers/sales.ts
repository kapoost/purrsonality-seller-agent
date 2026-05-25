// Sales platform = inventory adapter handlers wrapped with observability.
//
// All business logic lives behind the InventoryAdapter interface in
// src/inventory/. This file is the thin wrapper that the SDK boot wires
// to MCP transport. Swapping the inventory source means changing the
// import here (or branching on tenant/host); no other code moves.

import type { SalesPlatform } from '@adcp/sdk/server';
import { instrumentHandlers } from '../observability/wrap.ts';
import { purrsonalityAdapter } from '../inventory/purrsonality.ts';
import type { PurrAccountMeta } from './accounts.ts';

export const sales: SalesPlatform<PurrAccountMeta> = instrumentHandlers(
  'sales',
  purrsonalityAdapter.handlers as unknown as Record<string, unknown>,
) as unknown as SalesPlatform<PurrAccountMeta>;
