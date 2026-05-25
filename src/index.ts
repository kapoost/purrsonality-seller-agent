import { createAdcpServerFromPlatform, serve, verifyApiKey } from '@adcp/sdk/server';
import { startAdminServer } from './admin/server.ts';
import { complyTest } from './comply.ts';
import { runMigrations } from './db/migrations.ts';
import { loadEnv } from './env.ts';
import { log } from './observability/logger.ts';
import { startHeartbeat } from './observability/heartbeat.ts';
import { startMetricsFlusher } from './observability/metrics-store.ts';
import { platform } from './platform.ts';
import { idempotencyStore, mediaBuyStore, stateStore, taskRegistry } from './stores/index.ts';
import { buildAgentCard } from './well-known/agent-card.ts';
import { startWellKnownProxy } from './well-known/proxy.ts';

const env = loadEnv();
await runMigrations();
startMetricsFlusher();
startHeartbeat();
startAdminServer({
  port: env.ADMIN_PORT ?? env.PORT + 1,
  authToken: env.ADCP_AUTH_TOKEN,
  agentName: 'purrsonality-seller',
  agentVersion: '0.0.1',
  databaseBackend: env.DATABASE_URL ? 'postgres' : 'in-memory',
  nodeEnv: env.NODE_ENV,
});

// The SDK's `serve()` is a self-contained http.Server that only answers
// /mcp and /.well-known/oauth-protected-resource/mcp. To advertise an A2A
// Agent Card on the same origin we run the SDK on an internal port and
// front it with a Bun.serve proxy on env.PORT (see src/well-known/proxy.ts).
const sdkPort = env.PORT + 100;

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'purrsonality-seller',
      version: '0.0.1',
      taskStore,
      taskRegistry,
      stateStore,
      idempotency: idempotencyStore,
      mediaBuyStore,
      resolveIdempotencyPrincipal: (ctx) => {
        const ctxAny = ctx as {
          authInfo?: { clientId?: string };
          account?: { id?: string };
        };
        return ctxAny.authInfo?.clientId ?? ctxAny.account?.id ?? 'anonymous';
      },
      complyTest,
    }),
  {
    port: sdkPort,
    // Start the public proxy ONLY after the SDK is ready to receive forwarded
    // requests. Without this, proxy boots first and any request that arrives
    // during the ~50–200ms gap before SDK listen() returns gets a 502 from the
    // proxy's fetch(). CI storyboard runner hits security_baseline probes
    // immediately on connect, so the race was reliably reproducible there
    // even though local smoke (with a manual readiness wait) never saw it.
    onListening: () => {
      startWellKnownProxy({
        publicPort: env.PORT,
        sdkPort,
        agentCard: buildAgentCard({
          agentUrl: `${env.PUBLIC_BASE_URL}/mcp`,
          version: '0.0.1',
        }),
      });
    },
    authenticate: verifyApiKey({
      keys: {
        [env.ADCP_AUTH_TOKEN]: { principal: 'purrsonality-dev' },
        ...(env.ADCP_TEST_TOKEN && {
          [env.ADCP_TEST_TOKEN]: { principal: 'purrsonality-test' },
        }),
        'demo-acme-outdoor-v1': { principal: 'compliance-runner' },
        'demo-acme-outdoor-live-v1': { principal: 'compliance-runner-live' },
      },
    }),
  },
);

log.info('startup', {
  agent: 'purrsonality-seller',
  version: '0.0.1',
  listening_on: `${env.PUBLIC_BASE_URL}/mcp`,
  agent_card: `${env.PUBLIC_BASE_URL}/.well-known/agent.json`,
  specialisms: ['sales-non-guaranteed'],
  database: env.DATABASE_URL ? 'postgres' : 'in-memory',
  node_env: env.NODE_ENV,
});
