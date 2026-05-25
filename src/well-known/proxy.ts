// Public-port reverse proxy that fronts the SDK's MCP server with A2A
// discovery routes.
//
// SDK `serve()` (from @adcp/sdk/server) is a self-contained http.Server that
// answers only `POST /mcp` and `GET /.well-known/oauth-protected-resource/mcp`.
// To advertise an A2A Agent Card at `/.well-known/agent.json` on the same
// origin without forking the SDK, we run the SDK on an internal port and put
// a Bun.serve proxy on the public port:
//
//   PUBLIC_PORT (Bun.serve)
//     ├─ GET  /.well-known/agent.json   → static A2A card
//     ├─ GET  /.well-known/healthz       → liveness probe (no auth)
//     └─ everything else                  → fetch() forward to SDK_PORT
//
// Latency cost: a single localhost RTT, sub-millisecond on Fly's loopback.
// Streaming: Bun's fetch() forwards request/response bodies as streams, so
// MCP's StreamableHTTP transport works unchanged.
//
// Auth: handled by the SDK behind us. The proxy is a dumb forwarder — it does
// not inspect Authorization headers.

import { log } from '../observability/logger.ts';

interface ProxyOptions {
  publicPort: number;
  sdkPort: number;
  agentCard: Record<string, unknown>;
}

let server: ReturnType<typeof Bun.serve> | null = null;

export function startWellKnownProxy(opts: ProxyOptions): void {
  if (server) return;

  const cardBody = JSON.stringify(opts.agentCard, null, 2);
  const startedAt = Date.now();

  server = Bun.serve({
    port: opts.publicPort,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      // Public A2A discovery
      if (req.method === 'GET' && url.pathname === '/.well-known/agent.json') {
        return new Response(cardBody, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }

      // Liveness probe (used by Fly health checks and any HTTP scanner). Cheap,
      // unauthenticated — never touches the SDK or DB.
      if (req.method === 'GET' && url.pathname === '/.well-known/healthz') {
        return Response.json(
          { ok: true, uptime_ms: Date.now() - startedAt },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }

      // Everything else: forward to the SDK on the internal port.
      const target = `http://127.0.0.1:${opts.sdkPort}${url.pathname}${url.search}`;

      // Strip hop-by-hop headers that fetch() will set fresh. Host must be
      // dropped or the upstream sees the public host (fine for SDK normally,
      // but we let the SDK's own host-resolution treat the call as localhost
      // and rely on PUBLIC_BASE_URL for any external advertisement).
      const fwdHeaders = new Headers(req.headers);
      fwdHeaders.delete('host');
      fwdHeaders.delete('connection');
      fwdHeaders.delete('content-length');

      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: fwdHeaders,
          body: req.body,
          // @ts-expect-error Bun-specific: duplex required when streaming a request body
          duplex: 'half',
        });
        // Pass upstream response straight through — preserves chunked encoding,
        // SSE events, error bodies, everything.
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        });
      } catch (err) {
        log.error('proxy_upstream_failed', {
          target,
          error: (err as Error).message?.slice(0, 200),
        });
        return Response.json(
          { error: 'upstream_unavailable' },
          { status: 502 },
        );
      }
    },
  });

  log.info('well_known_proxy_started', {
    public_port: opts.publicPort,
    sdk_port: opts.sdkPort,
    routes: ['/.well-known/agent.json', '/.well-known/healthz', '→ /mcp'],
  });
}
