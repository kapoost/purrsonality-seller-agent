// Demo seed creatives for /live/result-slot.
//
// `wipePersistentTestState()` truncates `creatives` on every startup so comply
// runs start clean. That breaks the live banner on purrsonality.rocketscience.pl
// because the slot endpoint serves the latest approved creative and the table
// is empty after each fly deploy. This seed re-inserts approved creatives
// AFTER the wipe so the banner survives deploys.
//
// Five persona-tagged variants (angel/hunter/tornado/trickster/tyrant) drive
// the persona-conditional demo: /live/result-slot?persona=<slug> picks the
// matching tagged creative when one exists. Without ?persona= they still land
// in the loose-fallback bucket and rotate normally.
//
// Gated on DEMO_SEED_CREATIVE=true so comply eval environments stay untouched.

import { creativesStore } from '../stores/creatives.ts';

const PERSONAS = ['angel', 'hunter', 'tornado', 'trickster', 'tyrant'] as const;

export async function seedDemoCreative(): Promise<{ seeded: boolean; count: number }> {
  if (process.env['DEMO_SEED_CREATIVE'] !== 'true') {
    return { seeded: false, count: 0 };
  }
  for (const p of PERSONAS) {
    await creativesStore.submit({
      creative_id: `demo-seed-persona-${p}`,
      account_id_hash: 'demo-seed',
      format_id: { agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250' },
      name: `Purrsonality demo banner — ${p}`,
      assets: {
        image: {
          url: `https://purrsonality.pages.dev/og/${p}.png`,
          width: 300,
          height: 250,
          alt_text: `${p} cat — Purrsonality demo`,
          persona_tag: `purr_persona_${p}`,
        },
      },
      autoApprove: true,
    });
  }
  return { seeded: true, count: PERSONAS.length };
}
