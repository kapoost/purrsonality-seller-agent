// Admin stats server — Bun.serve on a separate port from /mcp.
// Localhost-only on Fly (not exposed via http_service); access via:
//   flyctl proxy 3002:3002 -a purrsonality-seller
//   open http://localhost:3002/
//
// Routes:
//   GET /            — HTML dashboard
//   GET /api/info    — agent metadata (no auth)
//   GET /api/metrics — metrics snapshot JSON (bearer auth)
//
// HTML page handles auth client-side: prompts for token, stores in localStorage,
// sends as Bearer on api/metrics polls.

import { join } from 'node:path';
import type { AdcpServer } from '@adcp/sdk/server';
import { metrics } from '../observability/metrics.ts';
import { queryMetrics, queryAuditEvents } from '../observability/metrics-store.ts';
import { creativesStore, type CreativeStatus } from '../stores/creatives.ts';
import { impressionsStore } from '../stores/impressions.ts';
import { resetInMemoryTaskRegistry } from '../stores/index.ts';
import { getPool } from '../db/pool.ts';
import { log } from '../observability/logger.ts';
import { mockUpstream } from '../upstream/mock.ts';

interface AdminConfig {
  port: number;
  authToken: string;
  agentName: string;
  agentVersion: string;
  databaseBackend: string;
  nodeEnv: string;
  getAdcpServer?: () => AdcpServer | null;
}

let server: ReturnType<typeof Bun.serve> | null = null;

export function startAdminServer(cfg: AdminConfig): void {
  if (server) return;

  const startedAt = new Date().toISOString();
  const htmlPath = join(import.meta.dir, 'index.html');

  server = Bun.serve({
    port: cfg.port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      // CORS (admin UI may be loaded from a different origin in some workflows)
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      };
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

      // Public: agent identity (no secrets, no metrics)
      if (url.pathname === '/api/info') {
        return Response.json(
          {
            agent_name: cfg.agentName,
            agent_version: cfg.agentVersion,
            database_backend: cfg.databaseBackend,
            node_env: cfg.nodeEnv,
            started_at: startedAt,
          },
          { headers: corsHeaders },
        );
      }

      // Protected: hybrid metrics — process info (in-memory) + aggregated
      // window from Postgres (survives restarts). Window selectable via
      // ?window=1h|24h|7d (default 24h). No Postgres → persistent_disabled.
      if (url.pathname === '/api/metrics') {
        const auth = req.headers.get('authorization');
        const tokenFromQuery = url.searchParams.get('token');
        const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : tokenFromQuery;
        if (provided !== cfg.authToken) {
          return Response.json(
            { error: 'unauthorized' },
            { status: 401, headers: corsHeaders },
          );
        }

        const windowKey = url.searchParams.get('window') ?? '24h';
        const snap = metrics.snapshot();
        const processInfo = {
          uptime_s: snap.uptime_s,
          memory_mb: snap.memory_mb,
        };

        if (!getPool()) {
          return Response.json(
            {
              process: processInfo,
              persistent_disabled: true,
              persistent_disabled_reason: 'no_database_url',
            },
            { headers: corsHeaders },
          );
        }

        try {
          const persistent = await queryMetrics(windowKey);
          return Response.json(
            { process: processInfo, ...persistent },
            { headers: corsHeaders },
          );
        } catch (err) {
          return Response.json(
            {
              process: processInfo,
              persistent_error: (err as Error).message?.slice(0, 200),
            },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      // Protected: per-call audit log tail. Same persistence layer as
      // /api/metrics (Postgres metrics_events table) — this endpoint just
      // returns raw rows ordered by recency, with optional filters for
      // operator triage (which tool, errors only, last N).
      if (url.pathname === '/api/audit') {
        const auth = req.headers.get('authorization');
        const tokenFromQuery = url.searchParams.get('token');
        const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : tokenFromQuery;
        if (provided !== cfg.authToken) {
          return Response.json(
            { error: 'unauthorized' },
            { status: 401, headers: corsHeaders },
          );
        }
        if (!getPool()) {
          return Response.json(
            { events: [], persistent_disabled: true, persistent_disabled_reason: 'no_database_url' },
            { headers: corsHeaders },
          );
        }
        const windowKey = url.searchParams.get('window') ?? '24h';
        const tool = url.searchParams.get('tool') ?? undefined;
        const onlyErrors = url.searchParams.get('errors') === '1';
        const limitStr = url.searchParams.get('limit');
        const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
        try {
          const queryArgs: Parameters<typeof queryAuditEvents>[0] = { windowKey, onlyErrors };
          if (tool) queryArgs.tool = tool;
          if (typeof limit === 'number' && !Number.isNaN(limit)) queryArgs.limit = limit;
          const events = await queryAuditEvents(queryArgs);
          return Response.json(
            { window: windowKey, tool, only_errors: onlyErrors, events },
            { headers: corsHeaders },
          );
        } catch (err) {
          return Response.json(
            { error: 'query_failed', message: (err as Error).message?.slice(0, 200) },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      // Protected: creative review queue (operator side of the workflow).
      //   GET  /api/creatives?status=pending_review&limit=N
      //   POST /api/creatives/<id>/approve   body: {note?: string}
      //   POST /api/creatives/<id>/reject    body: {note: string}
      // Approve/reject set reviewed_at = NOW() and store the note. Buyers
      // observe the new status via list_creatives over MCP.
      if (url.pathname === '/api/creatives' || url.pathname.startsWith('/api/creatives/')) {
        const auth = req.headers.get('authorization');
        const tokenFromQuery = url.searchParams.get('token');
        const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : tokenFromQuery;
        if (provided !== cfg.authToken) {
          return Response.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders });
        }

        // GET /api/creatives — list
        if (url.pathname === '/api/creatives' && req.method === 'GET') {
          const statusParam = url.searchParams.get('status') ?? undefined;
          const validStatuses: CreativeStatus[] = ['processing', 'pending_review', 'approved', 'rejected', 'archived'];
          const status = validStatuses.includes(statusParam as CreativeStatus)
            ? (statusParam as CreativeStatus)
            : undefined;
          const limitStr = url.searchParams.get('limit');
          const limit = limitStr ? Math.min(500, Number.parseInt(limitStr, 10)) : 100;
          try {
            const rows = await creativesStore.list({
              ...(status && { status }),
              limit,
            });
            // Enrich with per-creative impression/click stats (Phase A adserver).
            // Cheap: one extra COUNT query for the whole page.
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

        // POST /api/creatives/<id>/approve | /reject
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
            log.info('creative_review', {
              creative_id: creativeId,
              action,
              has_note: note !== null,
            });
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

      // Protected: clear in-memory state between full-suite compliance runs.
      // Workaround for upstream adcp#5247 — the runner does not isolate
      // comply_test_controller state between storyboards, so seeds accumulate
      // across a full suite run. Re-running against the same process drops
      // baseline from 131/1/53 to 125/4/56 in our reproduction. This endpoint
      // restores the fresh-start baseline without a process restart.
      //
      // Calls SDK `server.compliance.reset()` (clears stateStore + idempotency)
      // and `mockUpstream.clearAll()` (clears the fake-upstream maps the
      // sales handlers read from).
      if (url.pathname === '/api/mock-state/reset' && req.method === 'POST') {
        const auth = req.headers.get('authorization');
        const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
        if (provided !== cfg.authToken) {
          return Response.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders });
        }
        const cleared: string[] = [];
        const adcpServer = cfg.getAdcpServer?.() ?? null;
        if (adcpServer) {
          try {
            await adcpServer.compliance.reset();
            cleared.push('sdk_state_and_idempotency');
          } catch (err) {
            return Response.json(
              { error: 'sdk_reset_failed', message: (err as Error).message?.slice(0, 300) },
              { status: 500, headers: corsHeaders },
            );
          }
        }
        mockUpstream.clearAll();
        cleared.push('mock_upstream');
        if (cfg.databaseBackend === 'in-memory') {
          creativesStore.clearInMemory();
          impressionsStore.clearInMemory();
          cleared.push('creatives_in_memory', 'impressions_in_memory');
          if (resetInMemoryTaskRegistry()) cleared.push('task_registry_in_memory');
        }
        log.info('mock_state_reset', { backend: cfg.databaseBackend, cleared });
        return Response.json({ success: true, cleared }, { headers: corsHeaders });
      }

      // Static dashboard HTML
      if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/index.html') {
        try {
          const file = Bun.file(htmlPath);
          return new Response(file, {
            headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
          });
        } catch (err) {
          return new Response(`Admin HTML missing: ${(err as Error).message}`, { status: 500 });
        }
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  log.info('admin_server_started', { port: cfg.port, dashboard_url: `http://localhost:${cfg.port}/` });
}
