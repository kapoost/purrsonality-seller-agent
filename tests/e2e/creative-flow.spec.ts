// End-to-end creative workflow: sync → operator review → buyer sees status.

import { test, expect, mcpCall, SERVER_URLS, TEST_ADMIN_TOKEN, TEST_AUTH_TOKEN, TEST_SANDBOX_TOKEN } from './fixtures/seller.ts';

interface SyncRow {
  creative_id: string;
  action: string;
  status: string;
}

async function syncOne(
  creativeId: string,
  token: string,
  extra: Record<string, unknown> = {},
): Promise<SyncRow> {
  const res = await mcpCall(
    'sync_creatives',
    {
      idempotency_key: `idem_${creativeId}_${Math.floor(Math.random() * 1_000_000)}`,
      account: { account_id: 'purrsonality' },
      creatives: [{
        creative_id: creativeId,
        name: `Test creative ${creativeId}`,
        format_id: { id: 'display_300x250', agent_url: `${SERVER_URLS.publicBase}/mcp` },
        assets: {
          image: { asset_type: 'image', url: 'https://example.com/x.png', width: 300, height: 250 },
          click_url: { asset_type: 'url', url: 'https://example.com/' },
        },
        ...extra,
      }],
    },
    token,
  ) as { rows?: SyncRow[]; creatives?: SyncRow[] };
  // SDK serializes the result rows under different keys depending on version;
  // accept either shape.
  const rows = res.rows ?? res.creatives ?? [];
  if (rows.length === 0) throw new Error(`No rows in sync_creatives response: ${JSON.stringify(res)}`);
  return rows[0]!;
}

test.describe('creative workflow', () => {
  test('sandbox principal → status approved (auto)', async () => {
    const id = `flow_sb_${Date.now()}`;
    const result = await syncOne(id, TEST_SANDBOX_TOKEN);
    expect(result.creative_id).toBe(id);
    expect(result.status).toBe('approved');
    expect(['created', 'updated']).toContain(result.action);
  });

  test('live principal → status pending_review', async () => {
    const id = `flow_live_${Date.now()}`;
    const result = await syncOne(id, TEST_AUTH_TOKEN);
    expect(result.creative_id).toBe(id);
    expect(result.status).toBe('pending_review');
  });

  test('operator approve transitions pending_review → approved', async () => {
    const id = `flow_approve_${Date.now()}`;
    await syncOne(id, TEST_AUTH_TOKEN);

    const res = await fetch(`${SERVER_URLS.adminBase}/api/creatives/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TEST_ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ note: 'E2E approval' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { creative: { status: string; review_note: string } };
    expect(body.creative.status).toBe('approved');
    expect(body.creative.review_note).toBe('E2E approval');
  });

  test('operator reject requires note, succeeds with note', async () => {
    const id = `flow_reject_${Date.now()}`;
    await syncOne(id, TEST_AUTH_TOKEN);

    // No note → 400
    const noNote = await fetch(`${SERVER_URLS.adminBase}/api/creatives/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noNote.status).toBe(400);

    // With note → 200
    const withNote = await fetch(`${SERVER_URLS.adminBase}/api/creatives/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Policy violation' }),
    });
    expect(withNote.status).toBe(200);
    const body = await withNote.json() as { creative: { status: string; review_note: string } };
    expect(body.creative.status).toBe('rejected');
    expect(body.creative.review_note).toBe('Policy violation');
  });

  test('resubmit (same creative_id) resets to pending_review and clears note', async () => {
    const id = `flow_resub_${Date.now()}`;
    await syncOne(id, TEST_AUTH_TOKEN);

    // Reject first
    await fetch(`${SERVER_URLS.adminBase}/api/creatives/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'first rejection' }),
    });

    // Resubmit with same id but different assets
    const second = await syncOne(id, TEST_AUTH_TOKEN, {
      assets: {
        image: { asset_type: 'image', url: 'https://example.com/v2.png', width: 300, height: 250 },
        click_url: { asset_type: 'url', url: 'https://example.com/' },
      },
    });
    expect(second.status).toBe('pending_review');

    // Verify review_note cleared
    const adminRes = await fetch(`${SERVER_URLS.adminBase}/api/creatives?status=pending_review&limit=50`, {
      headers: { 'Authorization': `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    const body = await adminRes.json() as { creatives: Array<{ creative_id: string; review_note: string | null }> };
    const match = body.creatives.find((c) => c.creative_id === id);
    expect(match, 'creative should be back in pending_review queue').toBeDefined();
    expect(match?.review_note).toBeNull();
  });

  test('admin /api/creatives unauthorized without token', async () => {
    const res = await fetch(`${SERVER_URLS.adminBase}/api/creatives`);
    expect(res.status).toBe(401);
  });

  test('admin /api/creatives unauthorized with wrong token', async () => {
    const res = await fetch(`${SERVER_URLS.adminBase}/api/creatives`, {
      headers: { 'Authorization': 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });
});
