// Phase A demo ad-server endpoints: /preview, /serve, /click.

import { test, expect, mcpCall, SERVER_URLS, TEST_ADMIN_TOKEN, TEST_SANDBOX_TOKEN } from './fixtures/seller.ts';

test.describe('demo serve endpoints', () => {
  test('agent.json + healthz public, no auth', async () => {
    const card = await fetch(SERVER_URLS.agentCard);
    expect(card.status).toBe(200);
    const cardJson = await card.json() as { name?: string; skills?: unknown[] };
    expect(cardJson.name).toBe('Purrsonality Seller');
    expect(Array.isArray(cardJson.skills)).toBe(true);

    const health = await fetch(SERVER_URLS.healthz);
    expect(health.status).toBe(200);
  });

  test('/preview/<nonexistent> returns 404', async () => {
    const res = await fetch(`${SERVER_URLS.publicBase}/preview/nope_does_not_exist_${Date.now()}`);
    expect(res.status).toBe(404);
  });

  test('/live/result-slot serves latest approved with embed-permissive CSP', async () => {
    // Seed an approved creative (sandbox auto-approves)
    const creativeId = `e2e_live_${Date.now()}`;
    await mcpCall(
      'sync_creatives',
      {
        idempotency_key: `idem-${creativeId}`,
        account: { account_id: 'purrsonality' },
        creatives: [{
          creative_id: creativeId,
          name: 'E2E live slot',
          format_id: { id: 'display_300x250', agent_url: `${SERVER_URLS.publicBase}/mcp` },
          assets: {
            image: { asset_type: 'image', url: 'https://example.com/banner.png', width: 300, height: 250 },
            click_url: { asset_type: 'url', url: 'https://example.com/landing' },
          },
          provenance: {
            digital_source_type: 'digital_capture',
            declared_by: { role: 'agency' },
            disclosure: { required: false },
          },
        }],
      },
      TEST_SANDBOX_TOKEN,
    );

    const res = await fetch(`${SERVER_URLS.publicBase}/live/result-slot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // CSP must allow embed from purrsonality.pages.dev
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('purrsonality.pages.dev');
    // Body has the banner image
    const html = await res.text();
    expect(html).toContain('<img');
    expect(html).toContain('example.com/banner.png');
    expect(html).toContain('/click/live-result-slot');
  });

  test('/preview/<sandbox-auto-approved> serves HTML with image', async () => {
    // sandbox principal → sync_creatives auto-approves
    const creativeId = `e2e_preview_${Date.now()}`;
    await mcpCall(
      'sync_creatives',
      {
        idempotency_key: `idem-${creativeId}`,
        account: { account_id: 'purrsonality' },
        creatives: [{
          creative_id: creativeId,
          name: 'E2E preview test',
          format_id: { id: 'display_300x250', agent_url: `${SERVER_URLS.publicBase}/mcp` },
          assets: {
            image: { asset_type: 'image', url: 'https://purrsonality.pages.dev/og/angel.png', width: 300, height: 250 },
            click_url: { asset_type: 'url', url: 'https://example.com/landing' },
          },
          provenance: {
            digital_source_type: 'digital_capture',
            declared_by: { role: 'agency' },
            disclosure: { required: false },
          },
        }],
      },
      TEST_SANDBOX_TOKEN,
    );

    const res = await fetch(`${SERVER_URLS.publicBase}/preview/${creativeId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<img');
    expect(html).toContain('purrsonality.pages.dev/og/angel.png');
    expect(html).toContain(creativeId);
  });

  test('impression counter increments per /preview hit', async () => {
    const creativeId = `e2e_count_${Date.now()}`;
    await mcpCall(
      'sync_creatives',
      {
        idempotency_key: `idem-${creativeId}`,
        account: { account_id: 'purrsonality' },
        creatives: [{
          creative_id: creativeId,
          name: 'E2E counter test',
          format_id: { id: 'display_300x250', agent_url: `${SERVER_URLS.publicBase}/mcp` },
          assets: {
            image: { asset_type: 'image', url: 'https://example.com/test.png', width: 300, height: 250 },
            click_url: { asset_type: 'url', url: 'https://example.com/landing' },
          },
          provenance: {
            digital_source_type: 'digital_capture',
            declared_by: { role: 'agency' },
            disclosure: { required: false },
          },
        }],
      },
      TEST_SANDBOX_TOKEN,
    );

    // 3 hits
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${SERVER_URLS.publicBase}/preview/${creativeId}`);
      expect(r.status).toBe(200);
    }

    // Admin endpoint exposes stats
    const adminRes = await fetch(`${SERVER_URLS.adminBase}/api/creatives?status=approved&limit=50`, {
      headers: { 'Authorization': `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(adminRes.status).toBe(200);
    const body = await adminRes.json() as { creatives: Array<{ creative_id: string; stats?: { impressions: number } }> };
    const match = body.creatives.find((c) => c.creative_id === creativeId);
    expect(match, 'creative should be present in admin /api/creatives').toBeDefined();
    expect(match?.stats?.impressions).toBe(3);
  });

  test('/click/<id> 302-redirects to assets.click_url + increments click counter', async () => {
    const creativeId = `e2e_click_${Date.now()}`;
    const landing = `https://example.com/landing-${Date.now()}`;
    await mcpCall(
      'sync_creatives',
      {
        idempotency_key: `idem-${creativeId}`,
        account: { account_id: 'purrsonality' },
        creatives: [{
          creative_id: creativeId,
          name: 'E2E click test',
          format_id: { id: 'display_300x250', agent_url: `${SERVER_URLS.publicBase}/mcp` },
          assets: {
            image: { asset_type: 'image', url: 'https://example.com/x.png', width: 300, height: 250 },
            click_url: { asset_type: 'url', url: landing },
          },
          provenance: {
            digital_source_type: 'digital_capture',
            declared_by: { role: 'agency' },
            disclosure: { required: false },
          },
        }],
      },
      TEST_SANDBOX_TOKEN,
    );

    const res = await fetch(`${SERVER_URLS.publicBase}/click/preview?creative_id=${encodeURIComponent(creativeId)}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(landing);

    // Click counter visible in admin stats
    const adminRes = await fetch(`${SERVER_URLS.adminBase}/api/creatives?status=approved&limit=50`, {
      headers: { 'Authorization': `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    const body = await adminRes.json() as { creatives: Array<{ creative_id: string; stats?: { clicks: number } }> };
    const match = body.creatives.find((c) => c.creative_id === creativeId);
    expect(match?.stats?.clicks).toBe(1);
  });
});
