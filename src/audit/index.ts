// Public entrypoint for handlers that want to attach audit_anchor to
// a media-buy wire response.
//
// One-call surface — `tryEmitAuditAnchor()`. Returns the anchor object
// to merge into the response, or null when audit is not configured.
// Handlers do NOT need to know whether Veles is reachable, the chain
// state, or the JWS plumbing; that's all behind this function.

import { canEmit, emitEvent, type EmittedAnchor } from './emitter.ts';

interface RuntimeConfig {
  velesURL: string;
  bearer?: string;
  agentURL: string;
}

let cachedCfg: RuntimeConfig | null | undefined;

function getRuntimeConfig(): RuntimeConfig | null {
  if (cachedCfg !== undefined) return cachedCfg;
  const velesURL = process.env.VELES_URL;
  const agentURL = process.env.PUBLIC_BASE_URL;
  if (!velesURL || !agentURL) {
    cachedCfg = null;
    return null;
  }
  cachedCfg = {
    velesURL,
    bearer: process.env.VELES_SUBMIT_TOKEN || undefined,
    // The agent_url field in the canonical event MUST equal the seller's
    // own MCP base URL (the one buyers send create_media_buy to). For
    // the seller's deployment, that's PUBLIC_BASE_URL + /mcp.
    agentURL: agentURL.endsWith('/mcp') ? agentURL : `${agentURL.replace(/\/+$/, '')}/mcp`,
  };
  return cachedCfg;
}

export interface AuditAnchorInput {
  eventType: 'create_media_buy' | 'update_media_buy';
  mediaBuyId: string;
  accountId: string;
  committedBudgetMajor: number; // major units (e.g. dollars); we convert to minor here
  currency: string;
}

export interface AuditAnchorOutput {
  attestor_url: string;
  event_commitment: string;
  proof_id: string;
}

/**
 * Build → sign → submit one audit event. Returns the anchor to embed
 * in the wire response, or null if the audit emitter is unconfigured
 * (no key, no Veles URL, etc.).
 *
 * Never throws into the buyer hot path. Errors are logged and the
 * caller ships the response without an audit_anchor field.
 */
export async function tryEmitAuditAnchor(input: AuditAnchorInput): Promise<AuditAnchorOutput | null> {
  if (!canEmit()) return null;
  const cfg = getRuntimeConfig();
  if (!cfg) return null;

  try {
    // Spec field `committed_budget` is in minor units (e.g. cents).
    // Convention here: multiply major×100. Currencies without minor
    // units (JPY) are tracked at their canonical integer — the demo
    // does not currently exercise JPY through this path, but if it
    // did, the value would be off by 100× and noted on the spec card.
    const committedBudget = Math.round(input.committedBudgetMajor * 100);

    const anchor: EmittedAnchor = await emitEvent(cfg, {
      eventType: input.eventType,
      mediaBuyId: input.mediaBuyId,
      accountId: input.accountId,
      committedBudget,
      currency: input.currency,
    });
    return {
      attestor_url: anchor.attestor_url,
      event_commitment: anchor.event_commitment,
      proof_id: anchor.proof_id,
    };
  } catch (err: unknown) {
    console.error('[audit] emit failed; shipping response without audit_anchor:', err);
    return null;
  }
}
