import { stopSeller } from './fixtures/seller.ts';

export default async function globalTeardown(): Promise<void> {
  await stopSeller();
}
