// Creative library — persistent store for sync_creatives / list_creatives
// + operator review workflow. Backs the AdCP creative-status lifecycle:
//   processing → pending_review → approved | rejected | archived
//
// Workflow split by account mode:
//   sandbox principals → submit() returns status='approved' immediately
//                        (storyboards expect this; review would block tests)
//   live principals    → submit() returns status='pending_review'
//                        admin operator approves/rejects via /api/creatives
//
// Resubmit semantics: sync_creatives with an existing creative_id resets
// status to pending_review (live) / approved (sandbox) and clears the
// previous review_note. Matches the spec note that "rejected is not
// terminal — buyer may fix and resubmit."
//
// Persistence: Postgres when DATABASE_URL set. Falls back to an in-memory
// Map when not set (dev with no DB) — operator review still works during
// the process lifetime; gone on restart.

import { getPool, withRetry } from '../db/pool.ts';

export type CreativeStatus = 'processing' | 'pending_review' | 'approved' | 'rejected' | 'archived';

export interface CreativeRow {
  creative_id: string;
  account_id_hash: string | null;
  format_id: Record<string, unknown>;
  name: string | null;
  assets: Record<string, unknown> | null;
  status: CreativeStatus;
  submitted_at: string;
  reviewed_at: string | null;
  review_note: string | null;
  /** Set by update_media_buy(creative_assignments). Impression attribution
   * reads this so live-slot writes land under the caller's media_buy_id
   * even after a seller restart (mockUpstream orders are in-memory). */
  assigned_media_buy_id: string | null;
}

export interface SubmitInput {
  creative_id: string;
  account_id_hash: string | null;
  format_id: Record<string, unknown>;
  name?: string | null;
  assets?: Record<string, unknown> | null;
  /** When true (sandbox principals), bypass review queue. */
  autoApprove: boolean;
}

export interface SubmitResult {
  creative_id: string;
  status: CreativeStatus;
  /** AdCP sync_creatives action — created on first submit, updated on resubmit. */
  action: 'created' | 'updated';
}

export interface ListFilter {
  accountIdHash?: string | null;
  status?: CreativeStatus;
  limit?: number;
}

// -------- in-memory fallback --------

const memory = new Map<string, CreativeRow>();

function memorySubmit(input: SubmitInput): SubmitResult {
  const existing = memory.get(input.creative_id);
  const status: CreativeStatus = input.autoApprove ? 'approved' : 'pending_review';
  const now = new Date().toISOString();
  const row: CreativeRow = {
    creative_id: input.creative_id,
    account_id_hash: input.account_id_hash,
    format_id: input.format_id,
    name: input.name ?? null,
    assets: input.assets ?? null,
    status,
    submitted_at: existing?.submitted_at ?? now,
    reviewed_at: input.autoApprove ? now : null,
    review_note: null,
    assigned_media_buy_id: existing?.assigned_media_buy_id ?? null,
  };
  memory.set(input.creative_id, row);
  return {
    creative_id: input.creative_id,
    status,
    action: existing ? 'updated' : 'created',
  };
}

function memoryList(filter: ListFilter): CreativeRow[] {
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
  let rows = [...memory.values()];
  if (filter.accountIdHash !== undefined && filter.accountIdHash !== null) {
    rows = rows.filter((r) => r.account_id_hash === filter.accountIdHash);
  }
  if (filter.status) {
    rows = rows.filter((r) => r.status === filter.status);
  }
  rows.sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
  return rows.slice(0, limit);
}

function memorySetStatus(
  id: string,
  status: CreativeStatus,
  note: string | null,
): CreativeRow | null {
  const row = memory.get(id);
  if (!row) return null;
  const updated: CreativeRow = {
    ...row,
    status,
    reviewed_at: new Date().toISOString(),
    review_note: note,
  };
  memory.set(id, updated);
  return updated;
}

function memoryGet(id: string): CreativeRow | null {
  return memory.get(id) ?? null;
}

// -------- Postgres path --------

function rowFromPg(r: Record<string, unknown>): CreativeRow {
  return {
    creative_id: String(r['creative_id']),
    account_id_hash: r['account_id_hash'] == null ? null : String(r['account_id_hash']),
    format_id: (r['format_id'] ?? {}) as Record<string, unknown>,
    name: r['name'] == null ? null : String(r['name']),
    assets: (r['assets'] ?? null) as Record<string, unknown> | null,
    status: String(r['status']) as CreativeStatus,
    submitted_at:
      r['submitted_at'] instanceof Date
        ? (r['submitted_at'] as Date).toISOString()
        : String(r['submitted_at']),
    reviewed_at:
      r['reviewed_at'] == null
        ? null
        : r['reviewed_at'] instanceof Date
          ? (r['reviewed_at'] as Date).toISOString()
          : String(r['reviewed_at']),
    review_note: r['review_note'] == null ? null : String(r['review_note']),
    assigned_media_buy_id: r['assigned_media_buy_id'] == null ? null : String(r['assigned_media_buy_id']),
  };
}

// -------- public API --------

export const creativesStore = {
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const pool = getPool();
    if (!pool) return memorySubmit(input);

    const status: CreativeStatus = input.autoApprove ? 'approved' : 'pending_review';
    const reviewedAt = input.autoApprove ? new Date() : null;

    // UPSERT: insert on first submit, on conflict reset to fresh review state.
    // The previous review_note is cleared because a resubmit is a buyer-side
    // correction — operator should review the new bytes fresh.
    const sql = `
      INSERT INTO creatives (creative_id, account_id_hash, format_id, name, assets, status, reviewed_at, review_note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
      ON CONFLICT (creative_id) DO UPDATE SET
        account_id_hash = EXCLUDED.account_id_hash,
        format_id = EXCLUDED.format_id,
        name = EXCLUDED.name,
        assets = EXCLUDED.assets,
        status = EXCLUDED.status,
        reviewed_at = EXCLUDED.reviewed_at,
        review_note = NULL
      RETURNING (xmax = 0) AS inserted
    `;
    const res = await pool.query(sql, [
      input.creative_id,
      input.account_id_hash,
      input.format_id,
      input.name ?? null,
      input.assets ?? null,
      status,
      reviewedAt,
    ]);
    const inserted = Boolean(res.rows[0]?.inserted);
    return {
      creative_id: input.creative_id,
      status,
      action: inserted ? 'created' : 'updated',
    };
  },

  async list(filter: ListFilter): Promise<CreativeRow[]> {
    return withRetry(async () => {
      const pool = getPool();
      if (!pool) return memoryList(filter);

      const conds: string[] = [];
      const params: unknown[] = [];
      if (filter.accountIdHash !== undefined && filter.accountIdHash !== null) {
        params.push(filter.accountIdHash);
        conds.push(`account_id_hash = $${params.length}`);
      }
      if (filter.status) {
        params.push(filter.status);
        conds.push(`status = $${params.length}`);
      }
      const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
      params.push(limit);
      const sql = `
        SELECT creative_id, account_id_hash, format_id, name, assets, status,
               submitted_at, reviewed_at, review_note, assigned_media_buy_id
        FROM creatives
        ${conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : ''}
        ORDER BY submitted_at DESC
        LIMIT $${params.length}
      `;
      const res = await pool.query(sql, params);
      return res.rows.map(rowFromPg);
    });
  },

  async setStatus(
    id: string,
    status: CreativeStatus,
    note: string | null,
  ): Promise<CreativeRow | null> {
    const pool = getPool();
    if (!pool) return memorySetStatus(id, status, note);

    const sql = `
      UPDATE creatives
      SET status = $2, reviewed_at = NOW(), review_note = $3
      WHERE creative_id = $1
      RETURNING creative_id, account_id_hash, format_id, name, assets, status,
                submitted_at, reviewed_at, review_note, assigned_media_buy_id
    `;
    const res = await pool.query(sql, [id, status, note]);
    return res.rows[0] ? rowFromPg(res.rows[0]) : null;
  },

  async get(id: string): Promise<CreativeRow | null> {
    return withRetry(async () => {
      const pool = getPool();
      if (!pool) return memoryGet(id);

      const sql = `
        SELECT creative_id, account_id_hash, format_id, name, assets, status,
               submitted_at, reviewed_at, review_note, assigned_media_buy_id
        FROM creatives WHERE creative_id = $1
      `;
      const res = await pool.query(sql, [id]);
      return res.rows[0] ? rowFromPg(res.rows[0]) : null;
    });
  },

  /* Persist the creative→media_buy link written by update_media_buy(
   * creative_assignments). Survives seller restarts so /live/*-slot
   * impression writes stay attached to the caller's buy even after
   * mockUpstream's in-memory orders vanish. */
  async setAssignedMediaBuyId(creativeId: string, mediaBuyId: string): Promise<void> {
    const pool = getPool();
    if (!pool) {
      const row = memory.get(creativeId);
      if (row) memory.set(creativeId, { ...row, assigned_media_buy_id: mediaBuyId });
      return;
    }
    await pool.query(
      `UPDATE creatives SET assigned_media_buy_id = $2 WHERE creative_id = $1`,
      [creativeId, mediaBuyId],
    );
  },
};
