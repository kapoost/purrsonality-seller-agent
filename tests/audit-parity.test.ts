// Parity test — the 5 spec vectors MUST produce byte-identical
// canonical bytes and identical SHA-256 hashes in TypeScript and Go.
//
// Source of truth: veles/docs/event-commitment-spec.md.
// Go reference: veles/internal/audit/commitment_test.go.
//
// If this test fails, do NOT update the expected values to match the
// TS output — the Go side and the spec doc are authoritative. Fix the
// TS canonicalization until it matches.

import { test, expect } from 'bun:test';
import { canonical, commitment, ZERO_PREV, type Event } from '../src/audit/commitment.ts';

interface Vector {
  name: string;
  event: Event;
  wantCanonical: string;
  wantHash: string;
}

const VECTORS: Vector[] = [
  {
    name: 'minimal_create_media_buy_first_event',
    event: {
      event_type: 'create_media_buy',
      attestor_schema_ver: 1,
      agent_url: 'https://seller.example/mcp',
      agent_account_hash: '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      media_buy_id: 'mb_001',
      committed_budget: 100000,
      currency: 'USD',
      created_at: '2026-06-27T12:00:00Z',
      prev_event_hash: ZERO_PREV,
    },
    wantCanonical: '{"agent_account_hash":"0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","agent_url":"https://seller.example/mcp","attestor_schema_ver":1,"committed_budget":100000,"created_at":"2026-06-27T12:00:00Z","currency":"USD","event_type":"create_media_buy","media_buy_id":"mb_001","prev_event_hash":"0x0000000000000000000000000000000000000000000000000000000000000000"}',
    wantHash: '0x193f82d59afe77d7e90d7dc7828a2cae1fb0794c9de35785e0e06cdbb274bee3',
  },
  {
    name: 'update_media_buy_chained',
    event: {
      event_type: 'update_media_buy',
      attestor_schema_ver: 1,
      agent_url: 'https://seller.example/mcp',
      agent_account_hash: '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      media_buy_id: 'mb_001',
      committed_budget: 150000,
      currency: 'USD',
      created_at: '2026-06-27T13:00:00Z',
      prev_event_hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    },
    wantCanonical: '{"agent_account_hash":"0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","agent_url":"https://seller.example/mcp","attestor_schema_ver":1,"committed_budget":150000,"created_at":"2026-06-27T13:00:00Z","currency":"USD","event_type":"update_media_buy","media_buy_id":"mb_001","prev_event_hash":"0x1111111111111111111111111111111111111111111111111111111111111111"}',
    wantHash: '0xdbab5434d8c7c7de029fb4671bf8e5aee6e43d12d1f546090a902b623a796930',
  },
  {
    name: 'non_ascii_url_polish_chars',
    event: {
      event_type: 'create_media_buy',
      attestor_schema_ver: 1,
      agent_url: 'https://sprzedawca.pl/żwirek/mcp',
      agent_account_hash: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      media_buy_id: 'mb_ąęć_002',
      committed_budget: 5000,
      currency: 'PLN',
      created_at: '2026-06-28T09:30:45Z',
      prev_event_hash: ZERO_PREV,
    },
    wantCanonical: '{"agent_account_hash":"0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","agent_url":"https://sprzedawca.pl/żwirek/mcp","attestor_schema_ver":1,"committed_budget":5000,"created_at":"2026-06-28T09:30:45Z","currency":"PLN","event_type":"create_media_buy","media_buy_id":"mb_ąęć_002","prev_event_hash":"0x0000000000000000000000000000000000000000000000000000000000000000"}',
    wantHash: '0xbca7dd609236e2a5a7252c61ea4cbf8660978bed19ece5803cbfa405e8348396',
  },
  {
    name: 'large_budget_eur',
    event: {
      event_type: 'create_media_buy',
      attestor_schema_ver: 1,
      agent_url: 'https://eu-seller.example/mcp',
      agent_account_hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
      media_buy_id: 'mb_eu_xl_2026',
      committed_budget: 9999999999,
      currency: 'EUR',
      created_at: '2026-07-01T00:00:00Z',
      prev_event_hash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
    wantCanonical: '{"agent_account_hash":"0x1234567890123456789012345678901234567890123456789012345678901234","agent_url":"https://eu-seller.example/mcp","attestor_schema_ver":1,"committed_budget":9999999999,"created_at":"2026-07-01T00:00:00Z","currency":"EUR","event_type":"create_media_buy","media_buy_id":"mb_eu_xl_2026","prev_event_hash":"0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}',
    wantHash: '0x62276b4eec890f7622aa50b02627f401d5293fa469e17677428f352876c92840',
  },
  {
    name: 'zero_budget_jpy',
    event: {
      event_type: 'update_media_buy',
      attestor_schema_ver: 1,
      agent_url: 'https://jp-seller.example/mcp',
      agent_account_hash: '0x0000000000000000000000000000000000000000000000000000000000000001',
      media_buy_id: 'mb_jp_zeroed',
      committed_budget: 0,
      currency: 'JPY',
      created_at: '2026-12-31T23:59:59Z',
      prev_event_hash: '0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe',
    },
    wantCanonical: '{"agent_account_hash":"0x0000000000000000000000000000000000000000000000000000000000000001","agent_url":"https://jp-seller.example/mcp","attestor_schema_ver":1,"committed_budget":0,"created_at":"2026-12-31T23:59:59Z","currency":"JPY","event_type":"update_media_buy","media_buy_id":"mb_jp_zeroed","prev_event_hash":"0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe"}',
    wantHash: '0x80f067e1617ca2430c98a667918a1806fe3ce0faea1f13fda916b86c87383813',
  },
];

for (const v of VECTORS) {
  test(`parity: ${v.name} — canonical bytes`, () => {
    const got = new TextDecoder().decode(canonical(v.event));
    expect(got).toBe(v.wantCanonical);
  });

  test(`parity: ${v.name} — commitment hash`, () => {
    expect(commitment(v.event)).toBe(v.wantHash);
  });
}
