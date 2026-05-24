// Periodic metrics snapshot emitted as a structured log line, plus SIGUSR1
// handler for on-demand dumps. Started once at process boot from index.ts.

import { log } from './logger.ts';
import { metrics } from './metrics.ts';
import { pruneOld } from './metrics-store.ts';

const DEFAULT_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;  // daily

let timer: ReturnType<typeof setInterval> | null = null;
let lastPruneAt = 0;

export function startHeartbeat(interval_ms = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    log.info('metrics_snapshot', metrics.snapshot());
    // Once per day, prune old metrics_events rows
    const now = Date.now();
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      void pruneOld().then((deleted) => {
        if (deleted > 0) log.info('metrics_pruned', { deleted });
      });
    }
  }, interval_ms);
  // SIGUSR1: kill -USR1 <pid> to dump snapshot immediately
  process.on('SIGUSR1', () => {
    log.info('metrics_snapshot', { ...metrics.snapshot(), trigger: 'SIGUSR1' });
  });
  // Final snapshot on shutdown
  const shutdown = (signal: string): void => {
    log.info('metrics_snapshot', { ...metrics.snapshot(), trigger: `shutdown:${signal}` });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
