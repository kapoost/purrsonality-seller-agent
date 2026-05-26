// Spawns a seller agent in the background for the test suite and tears it
// down after all specs run. In-memory mode (no DATABASE_URL) keeps tests
// hermetic — no Postgres dependency in CI.

import { spawn, type ChildProcess } from 'node:child_process';
import { test as base, type Page } from '@playwright/test';

const PORT = Number.parseInt(process.env['SELLER_TEST_PORT'] ?? '3501', 10);
const ADMIN_PORT = PORT + 1;
const SDK_PORT = PORT + 100;

export const TEST_ADMIN_TOKEN = 'test-admin-token-32chars-min-padded-abc';
// TEST_AUTH_TOKEN === TEST_ADMIN_TOKEN: principal "purrsonality-dev" → live mode.
// SDK only registers ADCP_AUTH_TOKEN + ADCP_TEST_TOKEN keys; reusing the admin
// token here means both "live buyer" and "operator" share one credential, which
// is fine for tests (auth is not what these specs exercise).
export const TEST_AUTH_TOKEN = TEST_ADMIN_TOKEN;
export const TEST_SANDBOX_TOKEN = 'test-buyer-sandbox-token-32chars-pad';

export const SERVER_URLS = {
  publicBase: `http://127.0.0.1:${PORT}`,
  mcp: `http://127.0.0.1:${PORT}/mcp`,
  adminBase: `http://127.0.0.1:${ADMIN_PORT}`,
  agentCard: `http://127.0.0.1:${PORT}/.well-known/agent.json`,
  healthz: `http://127.0.0.1:${PORT}/.well-known/healthz`,
};

let proc: ChildProcess | null = null;

async function waitForHealthz(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(SERVER_URLS.healthz);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Seller did not become healthy on ${SERVER_URLS.healthz}`);
}

export async function startSeller(): Promise<void> {
  if (proc) return;
  proc = spawn('bun', ['run', 'src/index.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: '',
      ADCP_AUTH_TOKEN: TEST_ADMIN_TOKEN,
      ADCP_TEST_TOKEN: TEST_SANDBOX_TOKEN,
      PORT: String(PORT),
      ADMIN_PORT: String(ADMIN_PORT),
      PUBLIC_BASE_URL: SERVER_URLS.publicBase,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Forward child stderr to test stderr so boot failures surface in logs.
  proc.stderr?.on('data', (d) => process.stderr.write(`[seller] ${d}`));

  await waitForHealthz();
}

export async function stopSeller(): Promise<void> {
  if (!proc) return;
  const p = proc;
  proc = null;
  p.kill('SIGTERM');
  // Give it 2s to flush metrics buffer before forcing
  await new Promise((r) => setTimeout(r, 2_000));
  if (!p.killed) p.kill('SIGKILL');
}

/** Test-scoped helper: makes an MCP tools/call with bearer auth, returns parsed structuredContent. */
export async function mcpCall(
  method: string,
  args: Record<string, unknown>,
  token: string = TEST_ADMIN_TOKEN,
): Promise<Record<string, unknown>> {
  const res = await fetch(SERVER_URLS.mcp, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1_000_000),
      method: 'tools/call',
      params: { name: method, arguments: args },
    }),
  });
  const text = await res.text();
  // SSE-format response — parse data: line
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const env = JSON.parse(line.slice(6));
      return (env.result?.structuredContent ?? {}) as Record<string, unknown>;
    }
  }
  throw new Error(`No data: line in MCP response: ${text.slice(0, 300)}`);
}

export const test = base.extend<object>({});
export { expect } from '@playwright/test';
export { type Page };
