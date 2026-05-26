// Boot one seller process for the whole test run.
// Pair with global-teardown.ts.

import { startSeller } from './fixtures/seller.ts';

export default async function globalSetup(): Promise<void> {
  await startSeller();
}
