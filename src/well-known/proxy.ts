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
import { publicJwks } from '../signing.ts';
import { creativesStore } from '../stores/creatives.ts';
import { impressionsStore } from '../stores/impressions.ts';
import { mockUpstream } from '../upstream/mock.ts';

interface ProxyOptions {
  publicPort: number;
  sdkPort: number;
  agentCard: Record<string, unknown>;
  adcpCapabilities: Record<string, unknown>;
  oauthProtectedResource: Record<string, unknown>;
}

let server: ReturnType<typeof Bun.serve> | null = null;

/**
 * Pull a URL out of an AdCP asset value. Schema 3.0.12 wraps assets as
 * `{ asset_type: "image"|"url"|..., url: "...", ... }`; legacy fixtures may
 * still store a raw string. Return whichever is found, or empty string.
 */
function pickAssetUrl(asset: unknown): string {
  if (typeof asset === 'string') return asset;
  if (asset && typeof asset === 'object' && typeof (asset as { url?: unknown }).url === 'string') {
    return (asset as { url: string }).url;
  }
  return '';
}

function pickAssetField(asset: unknown, key: string): string | null {
  if (asset && typeof asset === 'object') {
    const v = (asset as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

function escapeHtmlAttr(s: string | undefined | null): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

export function startWellKnownProxy(opts: ProxyOptions): void {
  if (server) return;

  const cardBody = JSON.stringify(opts.agentCard, null, 2);
  const adcpCapsBody = JSON.stringify(opts.adcpCapabilities, null, 2);
  const oauthResourceBody = JSON.stringify(opts.oauthProtectedResource, null, 2);
  const jwksBody = JSON.stringify(publicJwks, null, 2);
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

      // Public AdCP-native discovery. Lets AdCP-aware clients (AAO comply
      // suite, buyer agents) pick storyboard tracks / match capabilities
      // without needing a successful `tools/list` over the bearer-walled
      // /mcp endpoint.
      if (req.method === 'GET' && url.pathname === '/.well-known/adcp-capabilities.json') {
        return new Response(adcpCapsBody, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }

      // RFC 9728 OAuth Protected Resource Metadata. SDK currently does NOT
      // serve this (verified by curl → 404), so we synthesise it here.
      // MCP clients that follow the spec poll this before /mcp to learn
      // bearer scheme + documentation URL.
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return new Response(oauthResourceBody, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }

      // Public JWKS for the signed-requests specialism. RFC 9421 buyers
      // resolving our keyids fetch this before signing — the SDK's
      // verifier consumes the same key set via StaticJwksResolver, so
      // wire-side public truth and verifier-side acceptance stay aligned.
      if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
        return new Response(jwksBody, {
          headers: {
            'Content-Type': 'application/jwk-set+json',
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

      // ── Demo ad-server routes (Phase A) ────────────────────────────────
      // PUBLIC — no auth. Anyone with a media_buy_id can hit /serve to
      // render the approved creative, /click to redirect via the landing.
      // Each hit writes one row to impressions table for delivery accounting.

      const serveMatch = req.method === 'GET' && url.pathname.match(/^\/serve\/([^/]+)$/);
      if (serveMatch) {
        const mediaBuyId = decodeURIComponent(serveMatch[1]!);
        const order = mockUpstream.getOrder(mediaBuyId);
        if (!order) {
          return new Response('media buy not found', { status: 404 });
        }
        // Pick the latest approved creative submitted by the same buyer.
        // Buyer can force a specific creative via ?creative_id=X.
        const requestedCreativeId = url.searchParams.get('creative_id');
        let creative;
        if (requestedCreativeId) {
          creative = await creativesStore.get(requestedCreativeId);
          if (!creative || creative.status !== 'approved') {
            return new Response('creative not approved', { status: 404 });
          }
        } else {
          // account_id_hash on the order side is not directly stored; for the
          // demo we just pull the most-recently approved creative regardless
          // of buyer (the order owns the media_buy_id, the buyer chose the
          // creative_id when they synced). Improve by stamping creative_id
          // on package_responses when create_media_buy fires — out of scope
          // for Phase A.
          const approved = await creativesStore.list({ status: 'approved', limit: 1 });
          creative = approved[0] ?? null;
          if (!creative) {
            return new Response('no approved creative available', { status: 404 });
          }
        }
        // AdCP 3.0.12: assets are typed objects { asset_type, url, ... }, not
        // raw strings. Tolerate the legacy string shape for pre-3.0.12 data
        // that may still live in seeded mockUpstream fixtures.
        const assets = (creative.assets ?? {}) as Record<string, unknown>;
        const imageUrl = pickAssetUrl(assets['image']);
        const altText: string =
          pickAssetField(assets['image'], 'alt_text') ??
          creative.name ??
          creative.creative_id ??
          '';
        const clickHref = `/click/${encodeURIComponent(mediaBuyId)}?creative_id=${encodeURIComponent(creative.creative_id)}`;

        await impressionsStore.record({
          media_buy_id: mediaBuyId,
          creative_id: creative.creative_id,
          event_type: 'impression',
          account_id_hash: creative.account_id_hash,
          user_agent: req.headers.get('user-agent'),
          referrer: req.headers.get('referer'),
        });

        const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtmlAttr(creative.name ?? creative.creative_id)}</title>
<style>html,body{margin:0;padding:0;background:transparent;}a{display:inline-block;}img{display:block;max-width:100%;border:0;}</style>
</head><body><a href="${escapeHtmlAttr(clickHref)}" target="_top" rel="noopener"><img src="${escapeHtmlAttr(imageUrl)}" alt="${escapeHtmlAttr(altText)}"></a></body></html>`;

        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
          },
        });
      }

      // ── Phase B: live slot for purrsonality.rocketscience.pl ─────────
      // Real-user serve endpoint embedded as an iframe on the quiz result
      // page (see cats/src/components/AdSlot.astro). Picks the latest
      // approved creative — operator's last Approve action automatically
      // becomes the live banner.
      //
      // Differs from /preview by:
      //   - frame-ancestors CSP allows both prod (rocketscience.pl) and dev (pages.dev) embeds
      //   - HTML is minimal (no chrome / metadata), pure banner
      //   - impression event records media_buy_id='live-result-slot'
      //   - 404 when no approved creative exists (operator hasn't reviewed any)
      if (req.method === 'GET' && url.pathname === '/live/result-slot') {
        const approved = await creativesStore.list({ status: 'approved', limit: 1 });
        const creative = approved[0] ?? null;
        if (!creative) {
          return new Response('no approved creative available', {
            status: 404,
            headers: {
              'Content-Security-Policy': "frame-ancestors 'self' https://purrsonality.rocketscience.pl https://purrsonality.pages.dev https://*.purrsonality.pages.dev",
              'Cache-Control': 'no-store',
            },
          });
        }
        const assets = (creative.assets ?? {}) as Record<string, unknown>;
        const imageUrl = pickAssetUrl(assets['image']);
        const altText: string =
          pickAssetField(assets['image'], 'alt_text') ??
          creative.name ??
          creative.creative_id ??
          '';
        const clickHref = `/click/live-result-slot?creative_id=${encodeURIComponent(creative.creative_id)}`;

        await impressionsStore.record({
          media_buy_id: 'live-result-slot',
          creative_id: creative.creative_id,
          event_type: 'impression',
          account_id_hash: creative.account_id_hash,
          user_agent: req.headers.get('user-agent'),
          referrer: req.headers.get('referer'),
        });

        const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Purrsonality ad slot</title>
<meta name="robots" content="noindex">
<style>html,body{margin:0;padding:0;background:transparent;font:0/0 a;}a{display:block;}img{display:block;width:100%;height:auto;border:0;}</style>
</head><body><a href="${escapeHtmlAttr(clickHref)}" target="_top" rel="noopener"><img src="${escapeHtmlAttr(imageUrl)}" alt="${escapeHtmlAttr(altText)}"></a></body></html>`;

        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            // Allow embedding on purrsonality.rocketscience.pl (prod) + purrsonality.pages.dev (dev) + CF preview deployments
            'Content-Security-Policy': "frame-ancestors 'self' https://purrsonality.rocketscience.pl https://purrsonality.pages.dev https://*.purrsonality.pages.dev",
            'X-Robots-Tag': 'noindex',
            'Referrer-Policy': 'no-referrer-when-downgrade',
          },
        });
      }

      // Operator-facing preview — render approved creative without binding
      // to a media buy. Used by admin UI's "View live banner" link.
      const previewMatch = req.method === 'GET' && url.pathname.match(/^\/preview\/([^/]+)$/);
      if (previewMatch) {
        const creativeId = decodeURIComponent(previewMatch[1]!);
        const creative = await creativesStore.get(creativeId);
        if (!creative || creative.status !== 'approved') {
          return new Response('creative not approved', { status: 404 });
        }
        const assets = (creative.assets ?? {}) as Record<string, unknown>;
        const imageUrl = pickAssetUrl(assets['image']);
        const altText: string =
          pickAssetField(assets['image'], 'alt_text') ??
          creative.name ??
          creative.creative_id ??
          '';
        const clickHref = `/click/preview?creative_id=${encodeURIComponent(creative.creative_id)}`;

        await impressionsStore.record({
          media_buy_id: 'preview',
          creative_id: creative.creative_id,
          event_type: 'impression',
          account_id_hash: creative.account_id_hash,
          user_agent: req.headers.get('user-agent'),
          referrer: req.headers.get('referer'),
        });

        const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Preview — ${escapeHtmlAttr(creative.name ?? creative.creative_id)}</title>
<style>html,body{margin:0;padding:0;background:#f5f5f5;font-family:system-ui,sans-serif;}
.wrap{padding:16px;}
.meta{font-size:11px;color:#666;margin-top:8px;}
a{display:inline-block;text-decoration:none;}
img{display:block;border:1px solid #ddd;background:#fff;}</style>
</head><body><div class="wrap">
<a href="${escapeHtmlAttr(clickHref)}" target="_top" rel="noopener"><img src="${escapeHtmlAttr(imageUrl)}" alt="${escapeHtmlAttr(altText)}"></a>
<div class="meta">creative_id: ${escapeHtmlAttr(creative.creative_id)} · format: ${escapeHtmlAttr((creative.format_id as { id?: string }).id ?? '?')} · click → ${escapeHtmlAttr(pickAssetUrl(assets['click_url']) || '(no click_url)')}</div>
</div></body></html>`;

        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      const clickMatch = req.method === 'GET' && url.pathname.match(/^\/click\/([^/]+)$/);
      if (clickMatch) {
        const mediaBuyId = decodeURIComponent(clickMatch[1]!);
        const requestedCreativeId = url.searchParams.get('creative_id');
        const creative = requestedCreativeId
          ? await creativesStore.get(requestedCreativeId)
          : (await creativesStore.list({ status: 'approved', limit: 1 }))[0] ?? null;
        if (!creative) return new Response('creative not found', { status: 404 });
        const clickUrl = pickAssetUrl(
          (creative.assets as Record<string, unknown> | null)?.['click_url'],
        );
        if (!clickUrl) return new Response('no click_url on creative', { status: 404 });

        await impressionsStore.record({
          media_buy_id: mediaBuyId,
          creative_id: creative.creative_id,
          event_type: 'click',
          account_id_hash: creative.account_id_hash,
          user_agent: req.headers.get('user-agent'),
          referrer: req.headers.get('referer'),
        });

        return new Response(null, { status: 302, headers: { Location: clickUrl } });
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

      // Only forward a request body for methods that semantically carry one.
      // Read body into an ArrayBuffer up-front instead of forwarding the
      // ReadableStream with `duplex: 'half'` — on Linux Bun fetch() the
      // streamed forward to localhost was making Node http.Server reject
      // the MCP initialize POST with 400 + null content-type, breaking
      // security_baseline/probe_api_key in CI even though macOS smoke
      // (same Bun 1.3.14) was fine. Buffering ≤ a few KB JSON-RPC bodies
      // costs nothing here and makes the request fully formed.
      const methodHasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const fetchInit: RequestInit = {
        method: req.method,
        headers: fwdHeaders,
      };
      if (methodHasBody) {
        const bodyBuf = await req.arrayBuffer();
        if (bodyBuf.byteLength > 0) {
          fetchInit.body = bodyBuf;
        }
      }

      try {
        const upstream = await fetch(target, fetchInit);
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
          method: req.method,
          path: url.pathname,
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
    routes: [
      '/.well-known/agent.json',
      '/.well-known/adcp-capabilities.json',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/jwks.json',
      '/.well-known/healthz',
      '→ /mcp',
    ],
  });
}
