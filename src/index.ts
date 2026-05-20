import { createAdcpServerFromPlatform, serve, verifyApiKey } from '@adcp/sdk/server';
import { complyTest } from './comply.ts';
import { loadEnv } from './env.ts';
import { platform } from './platform.ts';
import { idempotencyStore, mediaBuyStore, stateStore, taskRegistry } from './stores/index.ts';

const env = loadEnv();

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
        'demo-acme-outdoor-v1': { principal: 'compliance-runner' },
      },
    }),
  },
);

console.log(`Purrsonality seller agent listening on ${env.PUBLIC_BASE_URL}/mcp`);
console.log(`Specialisms: sales-non-guaranteed, signal-marketplace`);
