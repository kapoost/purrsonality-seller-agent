// Demo seed creative for /live/result-slot.
//
// `wipePersistentTestState()` truncates `creatives` on every startup so comply
// runs start clean. That breaks the live banner on purrsonality.rocketscience.pl
// because the slot endpoint serves the latest approved creative and the table
// is empty after each fly deploy. This seed re-inserts a single approved
// creative AFTER the wipe so the banner survives deploys.
//
// Gated on DEMO_SEED_CREATIVE=true so comply eval environments stay untouched.

import { creativesStore } from '../stores/creatives.ts';

const SEED_CREATIVE_ID = 'demo-seed-cat-banner';

export async function seedDemoCreative(): Promise<{ seeded: boolean }> {
  if (process.env['DEMO_SEED_CREATIVE'] !== 'true') {
    return { seeded: false };
  }
  await creativesStore.submit({
    creative_id: SEED_CREATIVE_ID,
    account_id_hash: 'demo-seed',
    format_id: { format_id: 'display_300x250', adcp_version: '3.1' },
    name: 'Purrsonality demo banner',
    assets: {
      image: {
        url: 'https://purrsonality.pages.dev/og/angel.png',
        width: 300,
        height: 250,
        alt_text: 'Angel cat — Purrsonality demo',
      },
    },
    autoApprove: true,
  });
  return { seeded: true };
}
