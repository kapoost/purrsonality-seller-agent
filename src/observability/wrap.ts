// withMonitoring — wraps an async handler with structured logging + metrics.
// Captures tool name, account_id (hashed), duration, error classification.
//
// Usage in handler definition:
//   getProducts: withMonitoring('get_products', async (req, ctx) => { ... })

import { createHash } from 'node:crypto';
import { log } from './logger.ts';
import { metrics } from './metrics.ts';

function hashAccountId(id: string | undefined | null): string {
  if (!id) return 'anonymous';
  // 8-char hex prefix — enough to distinguish, too short to reverse to a long id
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

interface CtxLike {
  account?: { id?: string } | null;
  authInfo?: { clientId?: string } | null;
}

/**
 * Wrap every async method on a handler object with `withMonitoring`. Method
 * names are converted camelCase → snake_case for the metric label
 * (`getProducts` → `get_products`).
 *
 * Non-function fields are passed through unchanged. Method `this` is preserved
 * via direct method reference (handlers in this codebase don't use `this`,
 * so no .bind() needed — closures over module-level imports).
 */
export function instrumentHandlers<T extends Record<string, unknown>>(
  prefix: string,
  handlers: T,
): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(handlers)) {
    const value = (handlers as Record<string, unknown>)[key];
    if (typeof value === 'function') {
      const snakeKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      const label = `${prefix}.${snakeKey}`;
      out[key] = withMonitoring(
        label,
        value as (...args: unknown[]) => Promise<unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export function withMonitoring<TArgs extends unknown[], TRet>(
  toolName: string,
  fn: (...args: TArgs) => Promise<TRet>,
): (...args: TArgs) => Promise<TRet> {
  return async (...args: TArgs): Promise<TRet> => {
    const started = Date.now();

    // Best-effort extract caller context from the second arg (handler ctx).
    // Handlers in seller follow the (req, ctx) pattern; we don't strictly require it.
    const ctxArg = args[1] as CtxLike | undefined;
    const accountHash = hashAccountId(ctxArg?.account?.id ?? ctxArg?.authInfo?.clientId);

    metrics.inc('tool_calls_total', toolName);

    try {
      const result = await fn(...args);
      const duration_ms = Date.now() - started;
      metrics.observe('tool_duration_ms', toolName, duration_ms);
      log.info('tool_call', {
        tool: toolName,
        account_hash: accountHash,
        duration_ms,
        status: 'ok',
      });
      return result;
    } catch (err) {
      const duration_ms = Date.now() - started;
      const error = err as { code?: string; name?: string; message?: string };
      const errClass = error.code ?? error.name ?? 'UnknownError';
      metrics.inc('tool_errors_total', `${toolName}|${errClass}`);
      metrics.observe('tool_duration_ms', toolName, duration_ms);
      log.error('tool_call', {
        tool: toolName,
        account_hash: accountHash,
        duration_ms,
        status: 'error',
        error_class: errClass,
        error_message: error.message?.slice(0, 200),
      });
      throw err;
    }
  };
}
