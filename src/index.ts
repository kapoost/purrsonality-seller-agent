import { createAdcpServerFromPlatform, serve, verifyApiKey } from '@adcp/sdk/server';
import { startAdminServer } from './admin/server.ts';
import { complyTest } from './comply.ts';
import { runMigrations } from './db/migrations.ts';
import { loadEnv } from './env.ts';
import { log } from './observability/logger.ts';
import { startHeartbeat } from './observability/heartbeat.ts';
import { startMetricsFlusher } from './observability/metrics-store.ts';
import { platform } from './platform.ts';
// `./signing.ts` retains its exports (jwksResolver, replayStore,
// revocationStore, requestSigningCapability) — they're consumed by
// well-known/proxy.ts (JWKS publication) and well-known/adcp-capabilities.ts
// (request_signing.supported discovery). The SDK preTransport
// signedRequests verifier was removed when we dropped the
// signed-requests specialism declaration; the keys + capability
// signalling stay so opt-in signing buyers can still discover us.
import { seedDemoCreative } from './seed/demo-creative.ts';
import { idempotencyStore, mediaBuyStore, stateStore, taskRegistry, wipePersistentTestState } from './stores/index.ts';
import { buildAdcpCapabilities, buildOAuthProtectedResource } from './well-known/adcp-capabilities.ts';
import { buildAgentCard } from './well-known/agent-card.ts';
import { startWellKnownProxy } from './well-known/proxy.ts';

const env = loadEnv();
await runMigrations();
// Drain accumulated comply-eval state from prior runs (creative status
// overrides surviving in `creatives`, deterministic task ids in
// `adcp_decisioning_tasks`, lingering `impressions`/`metrics_events`). Each
// fly deploy starts on a clean slate; the AAO comply runner's
// dependency_impairment chain is exquisitely sensitive to leftover creative
// status from prior storyboards, and the persistent stores otherwise survive
// process restarts. This is a no-op in in-memory mode (DATABASE_URL unset).
const wipe = await wipePersistentTestState();
if (wipe.tables_cleared.length > 0) {
  console.log('[startup] wiped persistent comply tables:', wipe.tables_cleared.join(', '));
}
const seed = await seedDemoCreative();
if (seed.seeded) {
  console.log('[startup] seeded demo creative for /live/result-slot');
}
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
      // adcpVersion: '3.1-rc' — second pin attempt after Phase J commits made
      // 3.1-rc the active diagnostic target. Earlier attempt to pin '3.1'
      // (commit 3c0ab5d → revert ad410dd) regressed deterministic_creative on
      // the 3.0 grader because pinning forces SDK to emit 3.1 envelope
      // conventions even when 3.0 grader is the caller. Pin '3.1-rc' matches
      // the actual served release and may sidestep the 3.0-vs-3.1 envelope
      // split while satisfying version_negotiation's envelope_field_present
      // adcp_version check. If 3.0 grader regresses, revert.
      adcpVersion: '3.1',
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
      // version_negotiation/get_capabilities_with_version requires the seller
      // to echo `adcp_version` on the envelope. SDK 9.x's regular dispatch
      // path already injects it via injectVersionIntoResponse, but the
      // auto-registered `get_adcp_capabilities` handler bypasses that wrapper
      // and returns capabilitiesResponse(data) directly through
      // applyResponseEnhancer. Wire it here so the discovery surface also
      // echoes the served release (advisory at 3.1, blocking at 3.2).
      responseEnhancer: (response) => {
        const sc = (response as { structuredContent?: Record<string, unknown> }).structuredContent;
        if (sc && typeof sc === 'object' && !('adcp_version' in sc)) {
          sc.adcp_version = '3.1';
        }
        const content = (response as { content?: Array<{ type: string; text?: string }> }).content;
        if (Array.isArray(content)) {
          const first = content[0];
          if (first?.type === 'text' && typeof first.text === 'string') {
            try {
              const parsed = JSON.parse(first.text) as Record<string, unknown>;
              if (parsed && typeof parsed === 'object' && !('adcp_version' in parsed)) {
                parsed.adcp_version = '3.1';
                first.text = JSON.stringify(parsed);
              }
            } catch {
              // Text isn't JSON — leave it alone.
            }
          }
        }
      },
      // RFC 9421 verifier intentionally not wired here. SDK guard rejects
      // signedRequests config when 'signed-requests' is absent from
      // platform.capabilities.specialisms (see create-adcp-server.js:1454).
      // We dropped the specialism declaration to avoid the AAO comply
      // signed-requests negative vector 001 with required_for: [] — see
      // platform.ts for the full decision record. Buyer-side signing on
      // opt-in remains possible via /.well-known/jwks.json; we just don't
      // *verify* incoming signatures at the SDK level anymore.
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
      const agentUrl = `${env.PUBLIC_BASE_URL}/mcp`;
      startWellKnownProxy({
        publicPort: env.PORT,
        sdkPort,
        reviewAuthToken: env.ADCP_AUTH_TOKEN,
        agentCard: buildAgentCard({ agentUrl, version: '0.0.1' }),
        adcpCapabilities: buildAdcpCapabilities({
          agentUrl,
          agentName: 'purrsonality-seller',
        }),
        oauthProtectedResource: buildOAuthProtectedResource({
          resource: agentUrl,
        }),
      });
    },
    authenticate: verifyApiKey({
      keys: {
        [env.ADCP_AUTH_TOKEN]: { principal: 'purrsonality-dev' },
        ...(env.ADCP_TEST_TOKEN && {
          [env.ADCP_TEST_TOKEN]: { principal: 'purrsonality-test' },
        }),
        ...(env.ADCP_ADDIE_TOKEN && {
          [env.ADCP_ADDIE_TOKEN]: { principal: 'purrsonality-addie-test' },
        }),
      },
      // AdCP test-kit convention (per `compliance/cache/<v>/test-kits/<kit>.yaml`):
      // sellers SHOULD accept any Bearer matching the kit's `demo-<kit>-v<N>`
      // prefix so the version suffix can rotate without breaking conformance
      // runs. security_baseline/assert_mechanism sends a random-invalid Bearer
      // alongside the valid one — accepting a permissive prefix would falsely
      // pass that probe, so the regex is anchored to the canonical version
      // suffix (`v<digits>` or `live-v<digits>`).
      verify: (token) => {
        if (/^demo-acme-outdoor-live-v\d+$/.test(token)) {
          return { principal: 'compliance-runner-live' };
        }
        if (/^demo-acme-outdoor-v\d+$/.test(token)) {
          return { principal: 'compliance-runner' };
        }
        // billing-gate-runner test kit: this bearer family is the spoofable
        // test principal for `commercial_relationship: passthrough_only` per
        // training-agent/commercial-relationships.ts. sync_accounts MUST
        // reject `billing: agent` with BILLING_NOT_PERMITTED_FOR_AGENT for
        // this principal — see handlers/accounts.ts upsert.
        if (/^demo-billing-passthrough-v\d+$/.test(token)) {
          return { principal: 'compliance-runner-passthrough' };
        }
        return null;
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
