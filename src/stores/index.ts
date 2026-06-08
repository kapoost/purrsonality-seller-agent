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
