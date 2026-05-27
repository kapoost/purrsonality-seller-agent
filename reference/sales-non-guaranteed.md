# Specialism: sales-non-guaranteed

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-non-guaranteed`.

Storyboard: `sales_non_guaranteed`. The specialism hinges on `bid_price` and `update_media_buy`, neither of which the baseline example shows.

**Fork target**: [`examples/hello_seller_adapter_non_guaranteed.ts`](../../../examples/hello_seller_adapter_non_guaranteed.ts) is the worked, passing reference adapter for this specialism. CI gates strict tsc + storyboard pass + upstream-traffic façade.

The adapter demonstrates the auction-mode deltas vs `sales-guaranteed`:

- **Sync confirmation** — `createMediaBuy` returns `media_buy_id` immediately with `status: 'active'` (or `pending_creatives` until creatives attach). No `ctx.handoffToTask`, no IO poll, no task envelope. Auction inventory clears at request time.
- **Floor pricing** — `pricing_options[].fixed_price` projected from upstream `min_cpm`; `min_spend` and `target_cpm` flow through to the wire when the upstream sets them. Reject `bid_price` below `floor_price` with `INVALID_REQUEST`.
- **Spend-only forecast** — `forecast_range_unit: 'spend'`; no `availability` unit because non-guaranteed inventory isn't pre-committed. See [Delivery Forecasts § Budget Curve](https://adcontextprotocol.org/docs/media-buy/product-discovery/media-products#budget-curve) for the wire shape.
- **Pacing propagation** — `even` / `asap` / `front_loaded` forwarded to upstream order; reflected in delivery curve. Validate raw input — reject typos rather than silently passing them through.
- **`update_media_buy`** — bid/budget changes apply in-flight without re-issuing the order. Two action surfaces coexist on the response:
  - `valid_actions[]` — legacy 3.x string list (`pause`, `update_bid`, `get_delivery`, …); framework auto-populates by `status`. Still emitted during the 3.x deprecation window.
  - `available_actions[]` — AdCP 3.1 authoritative surface (`{action, mode, sla, terms_ref?}` per entry, resolved from the product's `allowed_actions[]` and filtered by current buy status). Mutations that aren't in `available_actions[]` with `mode: self_serve` and a matching status scope MUST reject with `ACTION_NOT_ALLOWED` carrying `details.{attempted_action, reason, currently_available_actions[]}`. See `src/inventory/actions.ts` for the resolve/enforce helpers and `media_buy_seller/available_actions` (upstream PR #5036) for the contract.

Auction mode is the deletion-fork of the guaranteed sibling. If your backend has HITL approval, fork [`hello_seller_adapter_guaranteed.ts`](../../../examples/hello_seller_adapter_guaranteed.ts) instead. Replace the `// SWAP:` markers with calls to your real backend.
