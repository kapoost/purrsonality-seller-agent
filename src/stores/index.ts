import {
  createIdempotencyStore,
  memoryBackend,
  InMemoryStateStore,
  createMediaBuyStore,
  createInMemoryTaskRegistry,
  createPostgresTaskRegistry,
  PostgresStateStore,
} from '@adcp/sdk/server';
import { pgBackend } from '@adcp/sdk/server';
import type { AdcpStateStore } from '@adcp/sdk/server';
import { getPool } from '../db/pool.ts';

const pool = getPool();
const usingPostgres = pool !== null;

if (usingPostgres) {
  console.log('[stores] Using Postgres backend');
} else {
  console.log('[stores] Using in-memory backend (DATABASE_URL not set)');
}

export const idempotencyStore = usingPostgres
  ? createIdempotencyStore({ backend: pgBackend(pool!), ttlSeconds: 86_400 })
  : createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

export const stateStore: AdcpStateStore = usingPostgres
  ? new PostgresStateStore(pool!)
  : new InMemoryStateStore();

export const mediaBuyStore = createMediaBuyStore({ store: stateStore });

export const taskRegistry = usingPostgres
  ? createPostgresTaskRegistry({ pool: pool! })
  : createInMemoryTaskRegistry();

// Deterministic task_id collision dropper for the AAO comply runner.
// `media_buy_seller/create_media_buy_async/submitted_arm_response` registers
// a hardcoded task_id (e.g. `task_async_signed_io_q2`) via
// `force_create_media_buy_arm` and asserts the create_media_buy response
// echoes that exact id (`field_value: $context.forced_task_id`). The
// Postgres registry rejects re-registration with "task_id already
// registered"; the in-memory one only flushes via global clear(). To keep
// the directive deterministic across repeated eval runs, comply's force
// path deletes any prior row for that id before staging the directive.
export async function dropTaskRecord(taskId: string): Promise<void> {
  if (!usingPostgres) return; // in-memory: storyboard runs are isolated per process
  await pool!.query('DELETE FROM adcp_decisioning_tasks WHERE task_id = $1', [taskId]);
}
