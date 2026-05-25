# purrsonality-seller-agent

A production-grade reference implementation of an **AdCP sales agent** in Bun + TypeScript, deployed to Fly.io with Postgres on Neon. Built for [purrsonality.pages.dev](https://purrsonality.pages.dev) — a cat-personality quiz that sells one display slot on the result page — and intentionally minimal so it can be read end-to-end.

- **AdCP protocol:** 3.0.12 (via [`@adcp/sdk`](https://www.npmjs.com/package/@adcp/sdk) 7.11.0)
- **Runtime:** Bun 1.3 on Alpine
- **Persistence:** Postgres (Neon), with in-memory fallback for dev
- **Hosting:** Fly.io, scale-to-zero, region `fra` (co-located with Neon `eu-central-1`)
- **Storyboard compliance:** 131 passed / 1 failed / 53 skipped (baseline gated in CI)

If you are building an AdCP seller agent and want to see how the pieces fit together — handler shape, SDK wiring, sandbox vs live separation, dashboard observability — this repo is meant to read like a guided example.

---

## What this agent does

Exposes a single MCP endpoint (`POST /mcp`) that implements the AdCP `sales-non-guaranteed` specialism. Buyers can:

- discover the inventory (`get_products`, `list_creative_formats`),
- submit creatives (`sync_creatives`, `list_creatives`),
- create and manage media buys (`create_media_buy`, `update_media_buy`, `get_media_buys`, `get_media_buy_delivery`),
- list seller accounts (`list_accounts`),
- run conformance tests against a sandbox (`comply_test_controller`).

Inventory is a single product: a 300×250 (or responsive) display slot rendered after the user completes the cat-personality quiz. CPM floor $1.50, channel `display`, publisher `purrsonality.pages.dev`.

---

## Quick start (local dev)

```bash
git clone https://github.com/kapoost/purrsonality-seller-agent.git
cd purrsonality-seller-agent
bun install

cp .env.example .env.local
# Edit .env.local — at minimum set:
#   ADCP_AUTH_TOKEN=<openssl rand -hex 32>
# DATABASE_URL is optional (in-memory fallback if unset)

bun run dev   # http://127.0.0.1:3001/mcp
```

Smoke test from a second terminal:

```bash
TOKEN=$(grep ADCP_AUTH_TOKEN .env.local | cut -d= -f2)
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The admin dashboard runs on `PORT + 1` (default 3002):

```bash
open http://localhost:3002/
# paste the same ADCP_AUTH_TOKEN in the TOKEN field
```

---

## Architecture

```
src/
├── index.ts            Boot: env, migrations, observability, MCP serve
├── env.ts              Zod-validated env schema
├── platform.ts         SalesPlatform composition
├── handlers/
│   └── sales.ts        10 tool handlers (get_products, create_media_buy, …)
├── stores/             Postgres + in-memory store adapters (via @adcp/sdk)
├── db/
│   ├── pool.ts         pg.Pool factory
│   └── migrations.ts   AdCP SDK migrations + custom metrics_events table
├── observability/
│   ├── logger.ts       Structured JSON logs (one object per line)
│   ├── metrics.ts      In-memory counters + reservoir histograms
│   ├── metrics-store.ts  Buffered writes to Postgres (5s / 100 events)
│   ├── wrap.ts         instrumentHandlers(prefix, obj) → wraps every async method
│   └── heartbeat.ts    60s snapshot log + daily prune
├── admin/
│   ├── server.ts       Bun.serve on ADMIN_PORT, bearer-auth admin API
│   └── index.html      Single-page dashboard (vanilla JS, dark/light)
├── config/             Account fixtures (Purrsonality publisher)
└── upstream/           Pinned upstream SDK types we depend on
```

Three ports run side by side:

- `PORT` (default 3001) — public Bun.serve proxy: serves `/.well-known/agent.json` (A2A Agent Card discovery), `/.well-known/healthz`, and forwards everything else to the SDK on `PORT + 100`. Exposed via Fly `http_service`.
- `PORT + 100` (default 3101) — SDK's `serve()` MCP endpoint with auth (internal only — never exposed externally).
- `ADMIN_PORT` (default `PORT + 1`) — internal-only admin dashboard, **not** exposed externally on Fly. Reach it via `flyctl proxy 8081:8081 -a <app>`.

The proxy lets us advertise an A2A Agent Card on the same origin without forking the SDK — the SDK's `serve()` only owns `/mcp` and `/.well-known/oauth-protected-resource/mcp`. Everything else needs an outer router.

---

## Observability

Three layers, each addresses what the previous one cannot:

| Layer | What it covers | Where it lives |
|---|---|---|
| **T1** structured logs | per-call event with tool, duration, error class | stdout, scraped by Fly log shipper |
| **T2** in-memory metrics | uptime, memory, counters since boot | `/api/metrics` → admin dashboard `process` panel |
| **T3** persistent metrics | tool counters, latencies, errors per window (1h/24h/7d) | `metrics_events` table → admin dashboard `tools` + `errors` panels |

T3 is what lets the dashboard survive scale-to-zero — every tool call writes one row asynchronously, the dashboard aggregates on demand with `PERCENTILE_DISC` for p50/p95/p99.

Retention is 30 days, pruned daily from the heartbeat. At 10K calls/day that's ~300K rows and a few MB on Neon.

---

## Deployment (Fly.io)

```bash
flyctl secrets set \
  ADCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  DATABASE_URL='postgresql://...neon...' \
  -a <your-app>

flyctl deploy --remote-only
```

`fly.toml` defines:

- `primary_region = "fra"` (Frankfurt, co-located with Neon `eu-central-1`)
- `auto_stop_machines = "stop"`, `min_machines_running = 0` — scale to zero between requests
- `internal_port = 8080` — only the MCP port is exposed externally

For production, bump `min_machines_running = 1` to avoid cold starts on the first request after idle.

---

## Sandbox vs live

The agent uses a sandbox-authority gate: `account.mode === 'sandbox'` is decided from the authenticated principal (not from a buyer-supplied wire claim). The `comply_test_controller` tool is only available to sandbox callers; live callers see it as an absent tool. See `src/handlers/sales.ts` for the gate and `src/comply.ts` for the controller.

---

## Compliance

Storyboard suite (from the official AdCP test kit) runs on every push. The CI guard rejects any drop below the current baseline (`131 passed / 2 failed`). See `.github/workflows/ci.yml`.

Known protocol gaps tracked upstream:

- [adcontextprotocol/adcp#4914](https://github.com/adcontextprotocol/adcp/issues/4914) — `pagination_integrity_list_accounts` is structurally unsatisfiable for single-publisher first-party sellers. Closed COMPLETED upstream; the storyboard step still fails in the suite, which is the single known failure in this repo's baseline.
- [adcontextprotocol/adcp-client#1917](https://github.com/adcontextprotocol/adcp-client/issues/1917) — schema cache path bug (`schemas/cache/` vs `dist/lib/schemas-data/`). Still open as of SDK 7.11.0; workaround in `scripts/postinstall.sh` symlinks the expected path.

---

## Contributing

This is primarily a reference implementation for the Purrsonality deployment, but bug reports and SDK-version bumps are welcome via GitHub issues. For protocol changes that affect this agent, file against [adcontextprotocol/adcp](https://github.com/adcontextprotocol/adcp) — that's where the spec lives.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
