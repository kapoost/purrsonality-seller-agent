import { createAdcpServerFromPlatform, serve, verifyApiKey } from '@adcp/sdk/server';
import { startAdminServer } from './admin/server.ts';
import { complyTest } from './comply.ts';
import { runMigrations } from './db/migrations.ts';
import { loadEnv } from './env.ts';
import { log } from './observability/logger.ts';
import { startHeartbeat } from './observability/heartbeat.ts';
import { platform } from './platform.ts';
import { idempotencyStore, mediaBuyStore, stateStore, taskRegistry } from './stores/index.ts';

const env = loadEnv();
await runMigrations();
startHeartbeat();
startAdminServer({
  port: env.ADMIN_PORT ?? env.PORT + 1,
  authToken: env.ADCP_AUTH_TOKEN,
  agentName: 'purrsonality-seller',
  agentVersion: '0.0.1',
  databaseBackend: env.DATABASE_URL ? 'postgres' : 'in-memory',
  nodeEnv: env.NODE_ENV,
});

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
    port: env.PORT,
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
  specialisms: ['sales-non-guaranteed'],
  database: env.DATABASE_URL ? 'postgres' : 'in-memory',
  node_env: env.NODE_ENV,
});
