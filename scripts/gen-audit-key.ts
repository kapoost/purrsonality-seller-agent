#!/usr/bin/env bun
// Generate a fresh Ed25519 keypair for the audit emitter.
//
// Outputs a PEM private key (PKCS#8) and the corresponding public JWK
// fragment to stdout. The PEM goes into the AUDIT_PRIVATE_KEY_PEM env
// var (Fly secret); the JWK is informational — the running seller
// builds it from the private key at startup via audit/jwks.ts.
//
// Usage:
//
//   bun run scripts/gen-audit-key.ts [kid]
//
// Example:
//
//   bun run scripts/gen-audit-key.ts audit-2026-06 > .audit.env
//   fly secrets set AUDIT_PRIVATE_KEY_PEM="$(cat audit.pem)"
//   fly secrets set AUDIT_KEY_ID=audit-2026-06
//
// The PEM is sensitive — write to a path that's not committed
// (.gitignore already covers *.pem).

import { generateKeyPairSync } from 'node:crypto';

const kid = process.argv[2] ?? `audit-${new Date().toISOString().slice(0, 7)}`;

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const spkiDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const publicRaw = spkiDer.subarray(spkiDer.length - 32);

const jwk = {
  kty: 'OKP',
  crv: 'Ed25519',
  alg: 'EdDSA',
  use: 'sig',
  kid,
  x: publicRaw.toString('base64url'),
};

process.stdout.write(`\n# Audit Ed25519 keypair (kid=${kid})\n`);
process.stdout.write(`# Add to env (Fly secret in prod):\n#\n`);
process.stdout.write(`#   AUDIT_KEY_ID=${kid}\n`);
process.stdout.write(`#   AUDIT_PRIVATE_KEY_PEM=<the PEM block below, all lines>\n\n`);
process.stdout.write(pem);
process.stdout.write(`\n# Public JWK (informational; seller derives this from the private key):\n`);
process.stdout.write(JSON.stringify(jwk, null, 2));
process.stdout.write('\n');
