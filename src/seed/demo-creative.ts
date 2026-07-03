// Demo seed creatives for /live/result-slot.
//
// `wipePersistentTestState()` truncates `creatives` on every startup so comply
// runs start clean. That breaks the live banner on purrsonality.rocketscience.pl
// because the slot endpoint serves the latest approved creative and the table
// is empty after each fly deploy. This seed re-inserts approved creatives
// AFTER the wipe so the banner survives deploys.
//
// Five cat-persona-tagged variants (angel/hunter/tornado/trickster/tyrant)
// drive the audience-conditional demo: /live/result-slot?audience=<slug>
// picks the matching tagged creative when one exists. Without an ?audience=
// (or the legacy ?persona=) query they still land in the loose-fallback
// bucket and rotate normally.
//
// Gated on DEMO_SEED_CREATIVE=true so comply eval environments stay untouched.

import { creativesStore } from '../stores/creatives.ts';
import { getPool, withRetry } from '../db/pool.ts';

const AUDIENCE_SLUGS = ['angel', 'hunter', 'tornado', 'trickster', 'tyrant'] as const;

export async function seedDemoCreative(): Promise<{ seeded: boolean; count: number }> {
  if (process.env['DEMO_SEED_CREATIVE'] !== 'true') {
    return { seeded: false, count: 0 };
  }
  // Purge previous-schema seeds (demo-seed-persona-*, demo-seed-cat-banner).
  // Without this cleanup the rename left orphan rows tagged with persona_tag
  // in the creatives table — since we've dropped the legacy fallback in the
  // live-slot matcher, they'd never route to a persona query anymore but
  // would still show up in the loose-fallback bucket and rotate confusingly.
  const pool = getPool();
  if (pool) {
    await withRetry(async () => {
      await pool.query(
        `DELETE FROM creatives WHERE creative_id IN ('demo-seed-cat-banner') OR creative_id LIKE 'demo-seed-persona-%'`,
      );
    });
  }
  for (const slug of AUDIENCE_SLUGS) {
    await creativesStore.submit({
      creative_id: `demo-seed-audience-${slug}`,
      account_id_hash: 'demo-seed',
      format_id: { agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250' },
      name: `Purrsonality demo banner — ${slug}`,
      assets: {
        image: {
          url: `https://purrsonality.pages.dev/og/${slug}.png`,
          width: 300,
          height: 250,
          alt_text: `${slug} cat — Purrsonality demo`,
          audience_tag: `purr_persona_${slug}`,
        },
      },
      autoApprove: true,
    });
  }
  return { seeded: true, count: AUDIENCE_SLUGS.length };
}
