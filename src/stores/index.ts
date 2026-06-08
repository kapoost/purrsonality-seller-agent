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
import type { AdcpStateStore, TaskRegistry } from '@adcp/sdk/server';
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

// In-memory task registry has no exposed clear(), and the SDK uses
// undocumented runtime-only methods (e.g. `_registerBackground`) beyond the
// `TaskRegistry` interface — so an explicit forwarder misses them. Wrap in
// a Proxy that reflects every property access to the current inner instance,
// and expose a swap-the-inner reset. Workaround for upstream adcp#5247:
// storyboards reuse hardcoded task IDs and the second suite run hits
// "task_id already registered" without this reset.
let inMemoryTaskRegistryInner: TaskRegistry | null = usingPostgres ? null : createInMemoryTaskRegistry();

const inMemoryTaskRegistryProxy = usingPostgres
  ? null
  : (new Proxy({} as TaskRegistry, {
      get(_target, prop, receiver) {
        return Reflect.get(inMemoryTaskRegistryInner as object, prop, receiver);
      },
    }) as TaskRegistry);

export const taskRegistry: TaskRegistry = usingPostgres
  ? createPostgresTaskRegistry({ pool: pool! })
  : inMemoryTaskRegistryProxy!;

export function resetInMemoryTaskRegistry(): boolean {
  if (!inMemoryTaskRegistryProxy) return false;
  inMemoryTaskRegistryInner = createInMemoryTaskRegistry();
  return true;
}
