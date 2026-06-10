// Admin dashboard UI E2E — token gate, panel rendering, expand-row.
// Uses Playwright's browser to drive the dashboard HTML directly.

import { test, expect, mcpCall, SERVER_URLS, TEST_ADMIN_TOKEN, TEST_SANDBOX_TOKEN } from './fixtures/seller.ts';

test.describe('admin dashboard UI', () => {
  test('dashboard loads, agent meta renders from /api/info', async ({ page }) => {
    await page.goto(`${SERVER_URLS.adminBase}/`);
    // After page load, JS replaces the static "Purrsonality Seller" with the
    // agent_name field from /api/info (here: "purrsonality-seller"). Match
    // case-insensitively to tolerate both.
    await expect(page.locator('h1#agent-name')).toHaveText(/purrsonality/i);
    await expect(page.locator('#agent-meta')).toContainText('v0.0.1');
    // Process panel uptime gets populated only after /api/metrics auth — empty initially
    await expect(page.locator('#uptime')).toHaveText('—');
  });

  test('token entry + metrics load populates process panel', async ({ page }) => {
    await page.goto(`${SERVER_URLS.adminBase}/`);
    await page.fill('#token', TEST_ADMIN_TOKEN);
    await page.click('#refresh');
    // Uptime should be a positive number formatted as Ns / Nm Ns etc.
    await expect(page.locator('#uptime')).not.toHaveText('—', { timeout: 5_000 });
    await expect(page.locator('#health-badge')).toHaveText('OK');
  });

  test('wrong token → 401 badge', async ({ page }) => {
    await page.goto(`${SERVER_URLS.adminBase}/`);
    await page.fill('#token', 'wrong-token-value');
    await page.click('#refresh');
    await expect(page.locator('#health-badge')).toHaveText('401', { timeout: 5_000 });
  });

  test('creative review queue renders pending creatives + Approve flips status', async ({ page }) => {
    // Seed one pending_review creative via live MCP token
    const id = `ui_review_${Date.now()}`;
    await mcpCall(
      'sync_creatives',
      {
        idempotency_key: `idem_${id}`,
        account: { account_id: 'purrsonality' },
        creatives: [{
          creative_id: id,
          name: 'E2E UI review test',
          format_id: { id: 'display_300x250', agent_url: `${SERVER_URLS.publicBase}/mcp` },
          assets: {
            image: { asset_type: 'image', url: 'https://example.com/x.png', width: 300, height: 250 },
            click_url: { asset_type: 'url', url: 'https://example.com/' },
          },
          provenance: {
            digital_source_type: 'digital_capture',
            declared_by: { role: 'agency' },
            disclosure: { required: false },
            embedded_provenance: [{ method: 'provenance_markers', provider: 'Encypher', verify_agent: { agent_url: 'https://governance.encypher.seller.example', feature_id: 'encypher.markers_present_v2' } }],
          },
        }],
      },
      TEST_ADMIN_TOKEN,  // ADCP_AUTH_TOKEN principal = live (non-sandbox)
    );

    await page.goto(`${SERVER_URLS.adminBase}/`);
    await page.fill('#token', TEST_ADMIN_TOKEN);
    await page.click('#creative-load');
    // Pending queue should now contain our creative
    await expect(page.locator(`#creative-table tbody td`).filter({ hasText: id }).first()).toBeVisible({ timeout: 5_000 });

    // Stub window.prompt — Approve asks for optional note
    await page.evaluate(() => { (window as unknown as { prompt: () => string | null }).prompt = () => 'E2E approval'; });

    // Approve via the row's button (matches data-id)
    await page.locator(`button.creative-approve[data-id="${id}"]`).click();

    // After approve loadCreatives + loadApproved are called. Verify approved list reloaded by
    // clicking its reload and asserting presence.
    await page.click('#approved-load');
    await expect(page.locator(`#approved-table tbody td`).filter({ hasText: id }).first()).toBeVisible({ timeout: 5_000 });

    // The pending queue should no longer contain it
    await page.click('#creative-load');
    await expect(page.locator(`#creative-table tbody td`).filter({ hasText: id })).toHaveCount(0, { timeout: 5_000 });
  });

  test('expand-row toggles details with image preview block', async ({ page }) => {
    // Use a sandbox creative so it's directly approved
    const id = `ui_expand_${Date.now()}`;
    await mcpCall(
      'sync_creatives',
      {
        idempotency_key: `idem_${id}`,
        account: { account_id: 'purrsonality' },
        creatives: [{
          creative_id: id,
          name: 'E2E expand test',
          format_id: { id: 'display_300x250', agent_url: `${SERVER_URLS.publicBase}/mcp` },
          assets: {
            image: { asset_type: 'image', url: 'https://purrsonality.pages.dev/og/angel.png', width: 300, height: 250 },
            click_url: { asset_type: 'url', url: 'https://example.com/' },
          },
          provenance: {
            digital_source_type: 'digital_capture',
            declared_by: { role: 'agency' },
            disclosure: { required: false },
            embedded_provenance: [{ method: 'provenance_markers', provider: 'Encypher', verify_agent: { agent_url: 'https://governance.encypher.seller.example', feature_id: 'encypher.markers_present_v2' } }],
          },
        }],
      },
      TEST_SANDBOX_TOKEN,
    );

    await page.goto(`${SERVER_URLS.adminBase}/`);
    await page.fill('#token', TEST_ADMIN_TOKEN);
    await page.click('#approved-load');
    await expect(page.locator('#approved-table tbody td').filter({ hasText: id }).first()).toBeVisible({ timeout: 5_000 });

    // Find the row + its associated details (filter rows whose cells contain the id)
    const row = page.locator(`#approved-table tbody tr.approved-row`).filter({ has: page.locator('td', { hasText: id }) });
    const idx = await row.getAttribute('data-row-idx');
    const details = page.locator(`#approved-table tbody tr.approved-details[data-row-idx="${idx}"]`);

    // Initially hidden
    await expect(details).toBeHidden();

    // Click row → details visible + image preview img tag present
    await row.click();
    await expect(details).toBeVisible();
    await expect(details.locator('img')).toHaveAttribute('src', /purrsonality\.pages\.dev\/og\/angel\.png/);
    // And the demo serve URL link
    await expect(details.getByRole('link', { name: /\/preview\//i })).toBeVisible();

    // Click again to collapse
    await row.click();
    await expect(details).toBeHidden();
  });
});
