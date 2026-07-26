/**
 * Local pre-execution guardrails for order placement.
 *
 * Purpose: Safety/scoping layer so a wallet owner can cap what an autonomous agent
 * (OpenClaw/Hermes/Grok etc.) may do, entirely via local config. No external services,
 * no keys, no gateway. Enforced inline inside the MCP process before any SDK mutation.
 *
 * Configuration: Use the existing strategy bag (update_strategy / get_strategies)
 * under the special composite key "guardrails:global".
 *
 * Default posture: if "guardrails:global" has never been set at all, the server
 * is treated as readOnly (no orders may be placed) until the wallet owner
 * explicitly configures it. This matters because this MCP ships to strangers
 * (npm install, arbitrary agent hosts) with no setup wizard — a freshly
 * cloned/installed server, pointed at a funded key, must not let a connected
 * agent start placing real orders before anyone has opted in. Once
 * "guardrails:global" has been set (even to `{}`), every individual field
 * goes back to "unset = no restriction on that field" — an owner who has
 * explicitly configured guardrails is trusted to mean what they configured.
 *
 * Persistence: Values live in strategyStore (in-memory) and are saved via
 * persistStrategiesToDisk() → logs/agent-strategy.json. Survives MCP restarts
 * regardless of which host reconnects.
 *
 * Enforcement points: place_limit_order, place_maker_reward_order, place_optimized_reward_order.
 * Checked after arg normalization / suggestion, before any createLimitOrder / postOrder / place* SDK call.
 *
 * Observability: Current config + block attempts surface in get_mcp_usage (as a dedicated block)
 * and in mcp_doctor (synthetic checks run on every report for live verification).
 *
 * This is the local equivalent of a "Bankr scoped key" — a ceiling the owner sets on their own agent.
 * It is advisory limits by the owner for their agent; not a multi-tenant auth system.
 */

export type Guardrails = {
  /** If true, all placement attempts are rejected with guidance to flip the flag. */
  readOnly?: boolean;
  /** Hard cap on price * size (USD notional) for any single order. */
  maxOrderSizeUsd?: number;
  /** Max allowed |price - mid| / mid (e.g. 0.05 = 5%). Skipped if no currentMid in context. */
  maxPriceDeviationFromMid?: number;
  /** If non-empty, only these tokenIds (clob hex) are allowed for placement. */
  allowedTokenIds?: string[];
  /** Max concurrent open orders (checked against list_open_orders count at check time). */
  maxOpenOrdersTotal?: number;
};

/**
 * Read the guardrails config for the special key "guardrails:global".
 *
 * - Never configured at all (store has no "guardrails:global" key): returns
 *   { readOnly: true } — safe-by-default until the owner opts in.
 * - Configured (even as {}): per-field unset = no restriction on that field,
 *   readOnly defaults to false since the owner has now explicitly engaged
 *   with this config.
 * - Invalid value (wrong type): treated the same as "never configured" —
 *   fail closed rather than silently ignoring a malformed config.
 *
 * Never throws.
 */
export function getGuardrails(store: Map<string, unknown>): Guardrails {
  if (!store.has('guardrails:global')) {
    return { readOnly: true };
  }
  const raw = store.get('guardrails:global');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const g = raw as Partial<Guardrails>;
    // Basic sanitization / defaults (numbers stay as-is; we validate at check time)
    return {
      readOnly: typeof g.readOnly === 'boolean' ? g.readOnly : false,
      maxOrderSizeUsd: typeof g.maxOrderSizeUsd === 'number' && g.maxOrderSizeUsd > 0 ? g.maxOrderSizeUsd : undefined,
      maxPriceDeviationFromMid:
        typeof g.maxPriceDeviationFromMid === 'number' && g.maxPriceDeviationFromMid > 0 ? g.maxPriceDeviationFromMid : undefined,
      allowedTokenIds: Array.isArray(g.allowedTokenIds) ? g.allowedTokenIds.filter((x): x is string => typeof x === 'string') : undefined,
      maxOpenOrdersTotal: typeof g.maxOpenOrdersTotal === 'number' && g.maxOpenOrdersTotal >= 0 ? g.maxOpenOrdersTotal : undefined,
    };
  }
  return { readOnly: true };
}

/**
 * Check a proposed order against the guardrails.
 * Returns { ok: true } on pass, or { ok: false, reason: string } on block.
 *
 * Rules (evaluated in this order):
 * 1. readOnly: true → always reject (with recovery instruction).
 * 2. allowedTokenIds (non-empty) → reject if tokenId not present.
 * 3. maxOrderSizeUsd → reject if (price * size) > limit.
 * 4. maxPriceDeviationFromMid → if context.currentMid provided, reject if |price - mid| / mid > limit.
 *    (If no mid in context, this rule is skipped — never fail-closed on missing mid.)
 * 5. maxOpenOrdersTotal → if context.openOrderCount provided and >= limit, reject.
 *
 * Context values are optional and fetched only when the corresponding guard is active
 * (see call sites in mcp.ts). Fetches are best-effort and cheap where possible.
 */
export function checkOrderAgainstGuardrails(
  args: { tokenId: string; price: number; size: number; side: string },
  guardrails: Guardrails,
  context: { currentMid?: number; openOrderCount?: number }
): { ok: true } | { ok: false; reason: string } {
  if (guardrails.readOnly) {
    return {
      ok: false,
      reason:
        'readOnly guardrail is set — no orders may be placed. ' +
        'update_strategy({ tokenId: "guardrails:global", readOnly: false }) to allow trading.',
    };
  }

  if (guardrails.allowedTokenIds?.length && !guardrails.allowedTokenIds.includes(args.tokenId)) {
    return {
      ok: false,
      reason: `tokenId ${args.tokenId} not in allowedTokenIds allowlist.`,
    };
  }

  const notional = Number(args.price) * Number(args.size);
  if (guardrails.maxOrderSizeUsd != null && notional > guardrails.maxOrderSizeUsd) {
    return {
      ok: false,
      reason: `Order notional $${notional.toFixed(2)} exceeds maxOrderSizeUsd $${guardrails.maxOrderSizeUsd}.`,
    };
  }

  if (guardrails.maxPriceDeviationFromMid != null && context.currentMid != null) {
    const mid = context.currentMid;
    if (mid > 0) {
      const dev = Math.abs(Number(args.price) - mid) / mid;
      if (dev > guardrails.maxPriceDeviationFromMid) {
        const pct = (dev * 100).toFixed(1);
        const lim = (guardrails.maxPriceDeviationFromMid * 100).toFixed(1);
        return {
          ok: false,
          reason: `Price deviates ${pct}% from mid, exceeds ${lim}% limit.`,
        };
      }
    }
  }

  if (guardrails.maxOpenOrdersTotal != null) {
    const count = context.openOrderCount ?? 0;
    if (count >= guardrails.maxOpenOrdersTotal) {
      return {
        ok: false,
        reason: `Open order count at limit (${guardrails.maxOpenOrdersTotal}).`,
      };
    }
  }

  return { ok: true };
}
