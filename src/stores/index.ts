import {
  createIdempotencyStore,
  memoryBackend,
  InMemoryStateStore,
  createMediaBuyStore,
  createInMemoryTaskRegistry,
} from '@adcp/sdk/server';

export const idempotencyStore = createIdempotencyStore({
  backend: memoryBackend(),
  ttlSeconds: 86_400,
});

export const stateStore = new InMemoryStateStore();

export const mediaBuyStore = createMediaBuyStore({ store: stateStore });

export const taskRegistry = createInMemoryTaskRegistry();
