// Playwright config — E2E tests for the seller agent.
//
// Each spec spins up the seller (Bun process) on its own port via the
// fixture in tests/e2e/fixtures/seller.ts, then runs HTTP/UI assertions
// against it. Tests use the in-memory store path (DATABASE_URL='') so
// they're hermetic and don't need Postgres in CI.

import { defineConfig, devices } from '@playwright/test';

const PORT = Number.parseInt(process.env['SELLER_TEST_PORT'] ?? '3501', 10);

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/fixtures/**', '**/global-*.ts'],
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,        // tests share a server instance; serialize
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,                  // single worker → single server
  timeout: 30_000,
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
