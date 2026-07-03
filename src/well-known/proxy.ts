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
  /** Bearer accepted on /api/creatives — same token operators use against the
   * internal admin port. Re-exposing the endpoints on the public port so the
   * Abzu GUI's Operator tab can proxy to them without an SSH tunnel. */
  reviewAuthToken: string;
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

/**
 * Off-protocol audience routing tag. Buyer stores the full signal id
 * (e.g. purr_persona_hunter, signal-stack.io/adventure_seekers) on
 * assets.image.audience_tag when uploading a creative that should serve
 * only to that audience segment; live-slot reads it to bias creative
 * selection when the impression request carries a matching ?audience=<slug>.
 * AdCP schema allows additionalProperties on creative.assets.image, so
 * this is a legit extension surface. Legacy `persona_tag` is honored as a
 * fallback so pre-rename buys continue to route correctly. Returns the
 * full signal id when present, empty string otherwise.
 */
function pickAudienceTag(assets: Record<string, unknown> | null | undefined): string {
  if (!assets || typeof assets !== 'object') return '';
  const image = (assets as Record<string, unknown>)['image'];
  if (!image || typeof image !== 'object') return '';
  const tag = (image as Record<string, unknown>)['audience_tag']
    ?? (image as Record<string, unknown>)['persona_tag'];
  return typeof tag === 'string' ? tag : '';
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

      // ── Creative review API (public-port mirror of admin server) ──────
      // Mirrors GET /api/creatives and POST /api/creatives/<id>/{approve,reject}
      // from src/admin/server.ts onto the public port so an external operator
      // panel (Abzu GUI's Operator tab) can reach them without an SSH tunnel.
      // Bearer auth is the same ADCP_AUTH_TOKEN used by the admin server.
      if (url.pathname === '/api/creatives' || url.pathname.startsWith('/api/creatives/')) {
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type',
        };
        if (req.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        const auth = req.headers.get('authorization');
        const tokenFromQuery = url.searchParams.get('token');
        const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : tokenFromQuery;
        if (provided !== opts.reviewAuthToken) {
          return Response.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders });
        }

        if (url.pathname === '/api/creatives' && req.method === 'GET') {
          const statusParam = url.searchParams.get('status') ?? undefined;
          const validStatuses = ['processing', 'pending_review', 'approved', 'rejected', 'archived'] as const;
          const status = (validStatuses as readonly string[]).includes(statusParam ?? '')
            ? (statusParam as (typeof validStatuses)[number])
            : undefined;
          const limitStr = url.searchParams.get('limit');
          const limit = limitStr ? Math.min(500, Number.parseInt(limitStr, 10)) : 100;
          try {
            const rows = await creativesStore.list({
              ...(status && { status }),
              limit,
            });
            const stats = await impressionsStore.statsForCreatives(
              rows.map((r) => r.creative_id),
            );
            const enriched = rows.map((r) => ({
              ...r,
              stats: stats[r.creative_id] ?? { impressions: 0, clicks: 0, last_at: null },
            }));
            return Response.json({ creatives: enriched }, { headers: corsHeaders });
          } catch (err) {
            return Response.json(
              { error: 'query_failed', message: (err as Error).message?.slice(0, 200) },
              { status: 500, headers: corsHeaders },
            );
          }
        }

        const match = url.pathname.match(/^\/api\/creatives\/([^/]+)\/(approve|reject)$/);
        if (match && req.method === 'POST') {
          const creativeId = decodeURIComponent(match[1]!);
          const action = match[2] as 'approve' | 'reject';
          let body: { note?: string } = {};
          try {
            const raw = await req.text();
            if (raw) body = JSON.parse(raw);
          } catch {
            return Response.json({ error: 'invalid_json' }, { status: 400, headers: corsHeaders });
          }
          const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;
          if (action === 'reject' && !note) {
            return Response.json(
              { error: 'note_required', message: 'reject must include a non-empty note' },
              { status: 400, headers: corsHeaders },
            );
          }
          try {
            const updated = await creativesStore.setStatus(
              creativeId,
              action === 'approve' ? 'approved' : 'rejected',
              note,
            );
            if (!updated) {
              return Response.json(
                { error: 'not_found', creative_id: creativeId },
                { status: 404, headers: corsHeaders },
              );
            }
            log.info('creative_review', { creative_id: creativeId, action, has_note: note !== null });
            return Response.json({ creative: updated }, { headers: corsHeaders });
          } catch (err) {
            return Response.json(
              { error: 'update_failed', message: (err as Error).message?.slice(0, 200) },
              { status: 500, headers: corsHeaders },
            );
          }
        }

        return Response.json({ error: 'not_found' }, { status: 404, headers: corsHeaders });
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

      // ── Agent-crafted creative fallback ──────────────────────────────
      // Returned as the assets.image.url on a sync_creatives call when the
      // buyer did not upload a bitmap. Server renders an SVG with the
      // brand + product context so live slots have SOMETHING labeled as an
      // AdCP creative to serve, distinct from the house-generic fallback
      // (which fires when no AdCP creative is approved at all). Public,
      // no auth, no impression side-effect — the impression is recorded
      // by the /live/*-slot handler that embeds this SVG.
      if (req.method === 'GET' && url.pathname === '/generated/agent-creative.svg') {
        const brand = (url.searchParams.get('brand') ?? 'Advertiser').slice(0, 60);
        const product = (url.searchParams.get('product') ?? '').slice(0, 80);
        const sizeParam = url.searchParams.get('size') ?? '300x250';
        const sizeMatch = sizeParam.match(/^(\d{2,4})x(\d{2,4})$/);
        const w = sizeMatch ? Math.min(2048, Math.max(50, Number(sizeMatch[1]))) : 300;
        const h = sizeMatch ? Math.min(2048, Math.max(30, Number(sizeMatch[2]))) : 250;
        const brandEsc = escapeHtmlAttr(brand);
        const productLabel = product
          ? product.replace(/^purr_/, '').replace(/_v\d+$/i, '').replace(/_/g, ' ')
          : 'AdCP creative';
        const productEsc = escapeHtmlAttr(productLabel);
        // Simple deterministic hue derived from the brand string so the
        // banner picks a consistent color per advertiser across placements.
        let hash = 0;
        for (let i = 0; i < brand.length; i++) hash = (hash * 31 + brand.charCodeAt(i)) & 0xffff;
        const hue = hash % 360;
        const isLandscape = w / h > 3;
        const brandFont = Math.round(Math.min(w / (brand.length * 0.55 + 2), h * (isLandscape ? 0.5 : 0.28)));
        const productFont = Math.max(9, Math.round(brandFont * 0.35));
        const badgeFont = Math.max(8, Math.round(brandFont * 0.25));
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${brandEsc} — ${productEsc}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},60%,32%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 40) % 360},60%,18%)"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="rgba(255,255,255,0.14)"/>
      <stop offset="60%" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#sheen)"/>
  <g font-family="system-ui,-apple-system,'Segoe UI',sans-serif" fill="#fff">
    <text x="50%" y="${h * 0.5}" font-size="${brandFont}" font-weight="700" text-anchor="middle" dominant-baseline="middle" letter-spacing="0.02em">${brandEsc}</text>
    <text x="50%" y="${h * 0.5 + brandFont * 0.85}" font-size="${productFont}" fill="rgba(255,255,255,0.72)" text-anchor="middle" dominant-baseline="middle" letter-spacing="0.06em" text-transform="uppercase">${productEsc}</text>
  </g>
  <g transform="translate(${w - 8},${h - 8})" font-family="system-ui,-apple-system,sans-serif" text-anchor="end">
    <rect x="${-badgeFont * 8}" y="${-badgeFont * 1.6}" width="${badgeFont * 8}" height="${badgeFont * 1.6}" rx="3" fill="rgba(0,0,0,0.35)"/>
    <text x="${-badgeFont * 0.4}" y="${-badgeFont * 0.4}" font-size="${badgeFont}" fill="rgba(255,255,255,0.85)" letter-spacing="0.08em">AGENT-CRAFTED</text>
  </g>
</svg>`;
        return new Response(svg, {
          status: 200,
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // ── Phase B: live slots for purrsonality.rocketscience.pl ────────
      // Real-user serve endpoints embedded as iframes on the site (see
      // cats/src/components/AdSlot.astro). Two placements:
      //   /live/landing-slot  → purr_landing_rectangle_v1 (300x250)
      //   /live/result-slot   → purr_result_card_v1 (300x250)
      // Each picks the latest approved creative bound to a buy of the
      // matching product; falls back to a house-generic banner when no
      // AdCP creative is live for that placement. Badge distinguishes
      // "AdCP protocol" (violet) from "generic campaign" (grey).
      const liveSlotMatch = req.method === 'GET'
        && url.pathname.match(/^\/live\/(landing|result)-slot$/);
      if (liveSlotMatch) {
        const placement = liveSlotMatch[1] as 'landing' | 'result';
        const productId = placement === 'landing'
          ? 'purr_landing_rectangle_v1'
          : 'purr_result_card_v1';
        const fallbackMediaBuyId = `live-${placement}-slot`;

        // Audience-conditional selection (result-slot only for now — landing
        // has no quiz result yet). Cats frontend appends ?persona=<slug> to
        // the iframe src on /r/[persona]; buyers using AdCP audience routing
        // send ?audience=<slug>. Both accepted; we treat cats slugs as cat
        // persona segments and prefix with purr_persona_ to match the signal
        // id published by signals.purrsonality.rocketscience.pl.
        // Tag convention: creative.assets.image.audience_tag holds the full
        // signal id (e.g. "purr_persona_trickster", "signal-stack.io/…"). If
        // a request carries an audience and any approved creative advertises
        // that tag, the matching creatives take precedence over the
        // format-only bucket. Untagged creatives keep working as universal
        // fallbacks — no regression for buys that never opted into audience
        // routing. Legacy ?persona= query + persona_tag on assets are still
        // read for backwards compatibility.
        const requestedAudienceSlug = placement === 'result'
          ? (url.searchParams.get('audience') ?? url.searchParams.get('persona') ?? '')
              .trim()
              .toLowerCase()
          : '';
        const requestedAudienceSignal = requestedAudienceSlug
          ? (requestedAudienceSlug.includes('_') || requestedAudienceSlug.includes('/')
              ? requestedAudienceSlug
              : `purr_persona_${requestedAudienceSlug}`)
          : '';

        // Placement's declared format determines which creatives fit this
        // slot. Also try to find the matching media_buy for attribution.
        // Selection order:
        //   0) audience-tag matches + format matches   → tightest (audience-routed buy)
        //   1) order-linked + product_id matches      → best (buy served)
        //   2) format_id matches this placement       → still correct dim
        //   3) order-linked to something else, wrong format → skip
        //   4) format-agnostic order-less approved    → last-resort fallback
        // Case 2 covers the demo path where the seller was restarted after
        // sync_creatives (orders live in memory, creatives in Postgres,
        // so the assignment link disappears but the creative is still
        // approved with the right dimensions).
        // Both placements are 300x250 rectangles — the landing product
        // used to be a 728x90 leaderboard but overflowed the mobile-first
        // landing layout, so we standardised on the rectangle for both.
        // The format_id used to distinguish "which slot serves what" is
        // now identical, so this line is retained only for parity with
        // the earlier scan structure and any future re-differentiation.
        const placementFormatId = 'display_300x250';
        const approved = await creativesStore.list({ status: 'approved', limit: 100 });
        // Bucket every approved creative by how well it matches THIS
        // placement, then pick uniformly at random from the best-populated
        // bucket. Rotating instead of always serving the latest lets every
        // active buyer's creative get airtime — otherwise the demo shows the
        // same one banner over and over until a newer one comes in.
        const audienceMatches: typeof approved = [];
        const bestMatches: typeof approved = [];
        const formatMatches: typeof approved = [];
        const looseFallbacks: typeof approved = [];
        for (const c of approved) {
          const cFormatId = (c.format_id as { id?: string } | undefined)?.id;
          const formatOk = cFormatId === placementFormatId;
          const order = mockUpstream.findOrderByCreativeId(c.creative_id);
          // Off-protocol convention: assets.image.audience_tag on the
          // creative carries the full signal id (e.g. purr_persona_hunter,
          // signal-stack.io/adventure_seekers). Only counts as an audience
          // match when the placement had an ?audience= (or legacy ?persona=)
          // query AND the request's audience signal matches the tag AND the
          // creative still fits the placement dimensions.
          const cAudienceTag = pickAudienceTag(c.assets);
          if (requestedAudienceSignal && formatOk && cAudienceTag === requestedAudienceSignal) {
            audienceMatches.push(c);
            continue;
          }
          if (order?.product_ids.includes(productId)) {
            bestMatches.push(c);
          } else if (formatOk) {
            formatMatches.push(c);
          } else if (!order) {
            looseFallbacks.push(c);
          }
        }
        const pickBucket = audienceMatches.length > 0
          ? audienceMatches
          : bestMatches.length > 0
            ? bestMatches
            : formatMatches.length > 0
              ? formatMatches
              : looseFallbacks;
        const creative = pickBucket.length > 0
          ? pickBucket[Math.floor(Math.random() * pickBucket.length)]!
          : null;
        // Attribution reads from the persistent creatives.assigned_media_
        // buy_id column (populated by update_media_buy). Falls back to the
        // in-memory order lookup only for legacy creatives from before the
        // migration. Nothing here relies on mockUpstream surviving a
        // seller restart.
        const attributedMediaBuyId = creative
          ? (creative.assigned_media_buy_id
              ?? mockUpstream.findOrderByCreativeId(creative.creative_id)?.order_id
              ?? fallbackMediaBuyId)
          : fallbackMediaBuyId;

        const isAdcp = creative != null;
        const badgeLabel = isAdcp ? 'AdCP protocol' : 'generic campaign';
        const badgeColor = isAdcp ? '#7c3aed' : '#525252';

        let imageUrl: string;
        let altText: string;
        let clickHref: string;
        let creativeIdForLog: string;

        if (creative) {
          const assets = (creative.assets ?? {}) as Record<string, unknown>;
          imageUrl = pickAssetUrl(assets['image']);
          altText =
            pickAssetField(assets['image'], 'alt_text') ??
            creative.name ??
            creative.creative_id ??
            '';
          clickHref = `/click/live-${placement}-slot?creative_id=${encodeURIComponent(creative.creative_id)}`;
          creativeIdForLog = creative.creative_id;
        } else {
          imageUrl = 'https://purrsonality.pages.dev/og/default.png';
          altText = 'Purrsonality — discover your cat persona';
          clickHref = 'https://purrsonality.rocketscience.pl/';
          creativeIdForLog = `house-generic-${placement}`;
        }

        await impressionsStore.record({
          media_buy_id: attributedMediaBuyId,
          creative_id: creativeIdForLog,
          event_type: 'impression',
          account_id_hash: creative?.account_id_hash ?? 'house',
          user_agent: req.headers.get('user-agent'),
          referrer: req.headers.get('referer'),
        });

        // The image must fit inside the iframe's declared frame regardless
        // of its intrinsic aspect ratio — falls back to default.png which
        // is a 1200x630 OG image; naive `width:100%; height:auto` clipped
        // it to the iframe's top slice and looked like "no banner served".
        // object-fit: contain scales the image within the box while
        // preserving proportions; the flex centering keeps the letterboxed
        // area balanced against the transparent iframe background.
        const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Purrsonality ad slot</title>
<meta name="robots" content="noindex">
<style>html,body{margin:0;padding:0;background:transparent;font-family:system-ui,-apple-system,sans-serif;}
html,body,.slot{width:100%;height:100%;}
.slot{position:relative;display:flex;align-items:center;justify-content:center;text-decoration:none;}
.slot img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;border:0;}
.badge{position:absolute;top:6px;right:6px;padding:2px 6px;font-size:9px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:${badgeColor};border-radius:3px;pointer-events:none;box-shadow:0 1px 2px rgba(0,0,0,.25);z-index:1;}</style>
</head><body><a class="slot" href="${escapeHtmlAttr(clickHref)}" target="_top" rel="noopener"><img src="${escapeHtmlAttr(imageUrl)}" alt="${escapeHtmlAttr(altText)}"><span class="badge">${escapeHtmlAttr(badgeLabel)}</span></a></body></html>`;

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
