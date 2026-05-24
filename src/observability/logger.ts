// Structured JSON logger — emits one JSON object per line to stdout.
// Fly.io aggregates stdout per-app, so JSON lines are searchable in Fly UI:
//   fly logs -a purrsonality-seller | grep '"tool":"get_products"' | jq
//
// Format:
//   { ts: ISO, level: "info"|"warn"|"error", event: "tool_call"|"snapshot"|...,
//     ...context fields }

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [k: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function emit(level: LogLevel, event: string, context: LogContext = {}): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...context,
  };
  // One-line JSON, no pretty-print — Fly tail + jq friendly
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (event: string, ctx?: LogContext) => emit('debug', event, ctx),
  info: (event: string, ctx?: LogContext) => emit('info', event, ctx),
  warn: (event: string, ctx?: LogContext) => emit('warn', event, ctx),
  error: (event: string, ctx?: LogContext) => emit('error', event, ctx),
};
