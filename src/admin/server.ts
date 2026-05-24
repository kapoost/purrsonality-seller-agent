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

      // Protected: metrics snapshot
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
        return Response.json(metrics.snapshot(), { headers: corsHeaders });
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
