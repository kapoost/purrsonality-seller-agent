import type { MediaBuyStatus } from '@adcp/sdk';
import type { ProductAllowedAction, PurrProductConfig } from '../config/purrsonality.ts';

export type MediaBuyActionMode = 'self_serve' | 'conditional_self_serve' | 'requires_approval';

export interface BuyAvailableAction {
  action: string;
  mode: MediaBuyActionMode;
  sla?: { response_max?: string; completion_max?: string };
  terms_ref?: string;
  allowed_statuses?: readonly string[];
}

export function productAllowedActionsToBuyAvailable(
  productAllowed: readonly ProductAllowedAction[],
): BuyAvailableAction[] {
  return productAllowed.map((pa) => ({
    action: pa.action,
    mode: (pa.modes[0] ?? 'self_serve') as MediaBuyActionMode,
    ...(pa.sla && { sla: pa.sla }),
    ...(pa.terms_ref !== undefined && { terms_ref: pa.terms_ref }),
    ...(pa.allowed_statuses && { allowed_statuses: pa.allowed_statuses }),
  }));
}

export function resolveBuyAvailableActions(
  productConfigs: readonly PurrProductConfig[],
): BuyAvailableAction[] {
  const byAction = new Map<string, BuyAvailableAction>();
  for (const p of productConfigs) {
    if (!p.allowed_actions) continue;
    for (const a of productAllowedActionsToBuyAvailable(p.allowed_actions)) {
      if (!byAction.has(a.action)) byAction.set(a.action, a);
    }
  }
  return [...byAction.values()];
}

export function filterByStatus(
  actions: readonly BuyAvailableAction[],
  status: MediaBuyStatus | string,
): BuyAvailableAction[] {
  return actions.filter((a) => !a.allowed_statuses || a.allowed_statuses.includes(status as string));
}

export interface AttemptedActionDetection {
  action: string;
}

export function detectAttemptedAction(
  patch: Record<string, unknown>,
  packageBudgets: Readonly<Record<string, number>> | undefined,
  orderId: string,
): AttemptedActionDetection | null {
  if (patch['canceled'] === true) return { action: 'cancel' };
  if (patch['paused'] === true) return { action: 'pause' };
  if (patch['paused'] === false) return { action: 'resume' };

  const newEnd = patch['end_time'];
  if (typeof newEnd === 'string') return { action: 'extend_flight' };

  const pkgs = patch['packages'];
  if (Array.isArray(pkgs)) {
    for (const pkg of pkgs) {
      const p = pkg as { package_id?: string; budget?: number };
      if (typeof p.budget !== 'number' || !p.package_id) continue;
      const productId = p.package_id.startsWith(`${orderId}_`)
        ? p.package_id.slice(`${orderId}_`.length)
        : p.package_id;
      const current = packageBudgets?.[productId];
      if (current === undefined) return { action: 'update_budget' };
      if (p.budget > current) return { action: 'increase_budget' };
      if (p.budget < current) return { action: 'decrease_budget' };
    }
  }

  return null;
}

export type ActionNotAllowedReason =
  | 'mode_mismatch'
  | 'wrong_status'
  | 'not_supported_on_product'
  | 'not_supported_on_buy';

export interface ActionEnforcementResult {
  ok: true;
  resolved: BuyAvailableAction;
}

export interface ActionEnforcementRejection {
  ok: false;
  attempted_action: string;
  reason: ActionNotAllowedReason;
  recovery: 'correctable' | 'terminal';
  currently_available_actions: BuyAvailableAction[];
}

export function enforceAttemptedAction(
  attempted: string,
  allActions: readonly BuyAvailableAction[],
  currentStatus: string,
): ActionEnforcementResult | ActionEnforcementRejection {
  const currentlyAvailable = filterByStatus(allActions, currentStatus);
  const match = allActions.find((a) => a.action === attempted);
  if (!match) {
    return {
      ok: false,
      attempted_action: attempted,
      reason: 'not_supported_on_product',
      recovery: 'terminal',
      currently_available_actions: currentlyAvailable,
    };
  }
  if (match.allowed_statuses && !match.allowed_statuses.includes(currentStatus)) {
    return {
      ok: false,
      attempted_action: attempted,
      reason: 'wrong_status',
      recovery: 'correctable',
      currently_available_actions: currentlyAvailable,
    };
  }
  if (match.mode !== 'self_serve') {
    return {
      ok: false,
      attempted_action: attempted,
      reason: 'mode_mismatch',
      recovery: 'correctable',
      currently_available_actions: currentlyAvailable,
    };
  }
  return { ok: true, resolved: match };
}
