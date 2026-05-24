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
import { metrics } from '../observability/metrics.ts';
import { queryMetrics } from '../observability/metrics-store.ts';
import { getPool } from '../db/pool.ts';
import { log } from '../observability/logger.ts';

interface AdminConfig {
  port: number;
  authToken: string;
  agentName: string;
  agentVersion: string;
  databaseBackend: string;
  nodeEnv: string;
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
