import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  ADMIN_PORT: z.coerce.number().int().positive().optional(),
  ADCP_AUTH_TOKEN: z.string().min(8),
  ADCP_TEST_TOKEN: z.string().min(8).optional(),
  ADCP_ADDIE_TOKEN: z.string().min(8).optional(),
  ADCP_PRIVATE_JWK: z.string().optional(),
  ADCP_KEY_ID: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:3001'),
  DATABASE_URL: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Veles audit attestor (Phase A). All four below must be set together
  // for the seller to attach audit_anchor to media-buy responses.
  // Generate the keypair via: bun run scripts/gen-audit-key.ts
  AUDIT_PRIVATE_KEY_PEM: z.string().optional(),
  AUDIT_KEY_ID: z.string().optional(),
  VELES_URL: z.string().url().optional(),
  VELES_SUBMIT_TOKEN: z.string().optional(),
  AUDIT_CHAIN_STATE_PATH: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Environment validation failed:');
    console.error(parsed.error.format());
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
