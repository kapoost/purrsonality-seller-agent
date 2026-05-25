// InventoryAdapter — pluggable wrapper around the SDK's SalesPlatform shape,
// inspired by adcontextprotocol/salesagent's src/adapters/base.py pattern but
// kept functional / TypeScript-idiomatic.
//
// Why a separate type wrapping SalesPlatform: handlers/sales.ts used to be
// THE implementation. With the adapter abstraction, the implementation lives
// in src/inventory/<name>.ts and sales.ts becomes a thin observability /
// auth-wrapping layer. Future inventory sources (a second publisher, a
// signal-as-inventory provider, an external ad-server adapter) can be added
// by exporting another InventoryAdapter and swapping at boot — no handler
// changes.
//
// The `name` field is informational (logs, dashboards). It does NOT enter
// the wire — buyers see only the SDK's SalesPlatform surface unchanged.

import type { SalesPlatform } from '@adcp/sdk/server';
import type { PurrAccountMeta } from '../handlers/accounts.ts';

export type SalesHandlers = SalesPlatform<PurrAccountMeta>;

export interface InventoryAdapter {
  /** Identifier for logs and operator metrics (e.g. "purrsonality", "broadstreet"). */
  readonly name: string;
  /** AdCP SDK sales handlers — exactly the shape `defineSalesPlatform` returns. */
  readonly handlers: SalesHandlers;
}
