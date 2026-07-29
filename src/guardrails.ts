import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOrderMethod } from './registry.js';

/**
 * Safety gate for every fund-moving SDK method routed through poly_call.
 *
 * Default posture: readOnly until the owner explicitly configures guardrails
 * via set_guardrails, even once (to `{}`). This matters because this server
 * ships to strangers with no setup wizard — a freshly cloned/installed
 * server pointed at a funded key must not let a connected agent place real
 * orders before anyone has opted in.
 */
export type Guardrails = {
  readOnly?: boolean;
  maxOrderSizeUsd?: number;
  maxPriceDeviationFromMid?: number;
  allowedTokenIds?: string[];
  maxOpenOrdersTotal?: number;
  allowedTransferAddresses?: string[];
};

const STORE_PATH = join(process.cwd(), 'guardrails.json');

let configured = false;
let current: Guardrails = { readOnly: true };

function load(): void {
  if (!existsSync(STORE_PATH)) return;
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    configured = true;
    current = sanitize(raw);
  } catch {
    /* corrupt file — fail closed, stay at readOnly default */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(current, null, 2));
  } catch {
    /* best-effort; in-memory value still applies for this process */
  }
}

function sanitize(raw: unknown): Guardrails {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { readOnly: true };
  const g = raw as Partial<Guardrails>;
  return {
    readOnly: typeof g.readOnly === 'boolean' ? g.readOnly : true,
    maxOrderSizeUsd: typeof g.maxOrderSizeUsd === 'number' && g.maxOrderSizeUsd > 0 ? g.maxOrderSizeUsd : undefined,
    maxPriceDeviationFromMid:
      typeof g.maxPriceDeviationFromMid === 'number' && g.maxPriceDeviationFromMid > 0 ? g.maxPriceDeviationFromMid : undefined,
    allowedTokenIds: Array.isArray(g.allowedTokenIds) ? g.allowedTokenIds.filter((x): x is string => typeof x === 'string') : undefined,
    maxOpenOrdersTotal: typeof g.maxOpenOrdersTotal === 'number' && g.maxOpenOrdersTotal >= 0 ? g.maxOpenOrdersTotal : undefined,
    allowedTransferAddresses: Array.isArray(g.allowedTransferAddresses)
      ? g.allowedTransferAddresses.filter((x): x is string => typeof x === 'string')
      : undefined,
  };
}

load();

export function getGuardrails(): Guardrails {
  return configured ? current : { readOnly: true };
}

export function setGuardrails(patch: Guardrails): Guardrails {
  configured = true;
  current = sanitize({ ...current, ...patch });
  persist();
  return current;
}

export type GuardrailResult = { ok: true } | { ok: false; reason: string };

/**
 * Checks a fund-moving poly_call before it reaches the SDK.
 * `params` is whatever the caller passed for that method; `context` carries
 * best-effort extras (currentMid, openOrderCount) fetched by the caller.
 */
export function checkGuardrails(
  method: string,
  params: Record<string, unknown> | undefined,
  context: { currentMid?: number; openOrderCount?: number } = {}
): GuardrailResult {
  const g = getGuardrails();

  if (g.readOnly) {
    return {
      ok: false,
      reason: `readOnly guardrail is set — no fund-moving actions may run. Call set_guardrails({ readOnly: false }) to allow "${method}".`,
    };
  }

  if (method === 'transferErc20') {
    const to = params?.recipientAddress ?? params?.to;
    if (g.allowedTransferAddresses?.length && typeof to === 'string') {
      const allowed = g.allowedTransferAddresses.some((a) => a.toLowerCase() === to.toLowerCase());
      if (!allowed) {
        return { ok: false, reason: `recipient ${to} not in allowedTransferAddresses allowlist.` };
      }
    }
    return { ok: true };
  }

  if (!isOrderMethod(method)) {
    return { ok: true };
  }

  const tokenId = params?.tokenId;
  if (g.allowedTokenIds?.length && typeof tokenId === 'string' && !g.allowedTokenIds.includes(tokenId)) {
    return { ok: false, reason: `tokenId ${tokenId} not in allowedTokenIds allowlist.` };
  }

  const price = Number(params?.price);
  const size = Number(params?.size);
  if (g.maxOrderSizeUsd != null && Number.isFinite(price) && Number.isFinite(size)) {
    const notional = price * size;
    if (notional > g.maxOrderSizeUsd) {
      return { ok: false, reason: `Order notional $${notional.toFixed(2)} exceeds maxOrderSizeUsd $${g.maxOrderSizeUsd}.` };
    }
  }

  if (g.maxPriceDeviationFromMid != null && context.currentMid != null && Number.isFinite(price) && context.currentMid > 0) {
    const dev = Math.abs(price - context.currentMid) / context.currentMid;
    if (dev > g.maxPriceDeviationFromMid) {
      return {
        ok: false,
        reason: `Price deviates ${(dev * 100).toFixed(1)}% from mid, exceeds ${(g.maxPriceDeviationFromMid * 100).toFixed(1)}% limit.`,
      };
    }
  }

  if (g.maxOpenOrdersTotal != null && (context.openOrderCount ?? 0) >= g.maxOpenOrdersTotal) {
    return { ok: false, reason: `Open order count at limit (${g.maxOpenOrdersTotal}).` };
  }

  return { ok: true };
}
