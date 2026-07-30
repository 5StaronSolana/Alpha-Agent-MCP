/**
 * Generic dispatcher core: every @polymarket/client SDK method is callable
 * by name through poly_call, discoverable through poly_methods. No 1:1
 * hand-written tool per method — new SDK methods are covered automatically.
 */

import { RateLimitError } from '@polymarket/client';

/** Methods that move funds, approve access, or commit to a trade — gated by guardrails. */
export const FUND_MOVING_METHODS = new Set([
  // order placement
  'placeLimitOrder',
  'placeMarketOrder',
  'createLimitOrder',
  'createMarketOrder',
  'postOrder',
  'postOrders',
  // approvals
  'approveErc20',
  'approveErc1155ForAll',
  'setupTradingApprovals',
  // on-chain position actions
  'splitPosition',
  'mergePositions',
  'redeemPositions',
  'executeCollateralReturnPlan',
  // transfers
  'transferErc20',
  // perps fund movement
  'depositToPerps',
  'withdrawFromPerps',
  // sessions that commit to trading
  'openPerpsSession',
  'openRfqSession',
]);

/** Subset of FUND_MOVING_METHODS with a {tokenId, price, size, side}-shaped request, eligible for notional/deviation checks. */
export const ORDER_METHODS = new Set([
  'placeLimitOrder',
  'placeMarketOrder',
  'createLimitOrder',
  'createMarketOrder',
]);

/**
 * Subset of FUND_MOVING_METHODS with a raw `amount: bigint | 'max'` request
 * field denominated in pUSD base units (confirmed against the SDK's own
 * types — e.g. DepositToPerpsRequest.amount doc: "Collateral amount in base
 * units" — and against pUSD's fixed 6 decimals, docs.polymarket.com/
 * concepts/pusd). Distinct from ORDER_METHODS, whose `size` field is already
 * human-readable outcome-token units per the SDK's own doc comment on
 * PrepareLimitOrderRequest.size — do not apply the same base-units
 * conversion there, it would be wrong by 10^6.
 *
 * redeemPositions, executeCollateralReturnPlan, setupTradingApprovals, and
 * approveErc1155ForAll are FUND_MOVING_METHODS too but carry no checkable
 * amount (redeem always redeems the full winning balance; the other two
 * take no amount or an opaque pre-computed plan/no request at all) — left
 * out of this set deliberately, not an oversight.
 */
export const COLLATERAL_AMOUNT_METHODS = new Set([
  'approveErc20',
  'splitPosition',
  'mergePositions',
  'depositToPerps',
  'withdrawFromPerps',
]);

export function isFundMoving(method: string): boolean {
  return FUND_MOVING_METHODS.has(method);
}

export function isOrderMethod(method: string): boolean {
  return ORDER_METHODS.has(method);
}

export function isCollateralAmountMethod(method: string): boolean {
  return COLLATERAL_AMOUNT_METHODS.has(method);
}

export function listMethodNames(client: object): string[] {
  return Object.keys(client).filter((k) => typeof (client as any)[k] === 'function').sort();
}

const CATEGORY_PATTERNS: Array<[string, RegExp]> = [
  ['trading', /^(place|create|cancel|post|prepare).*Order|OrderScoring|OpenOrders/i],
  ['markets', /Market|Event|Series|Tag|Search|Spread|Midpoint|Price|OrderBook/i],
  ['account', /Position|Portfolio|Activity|Balance|Allowance|Profile|Notification/i],
  ['rewards', /Reward|Earnings|Leaderboard|BuilderVolume|BuilderTrades|BuilderFeeRates/i],
  ['perps', /Perps/i],
  ['rfq', /Rfq/i],
  ['onchain', /Transfer|Approve|Split|Merge|Redeem|CollateralReturn|Wallet|Deploy/i],
  ['realtime', /^subscribe/i],
];

/** Derived from CATEGORY_PATTERNS (+ "other") so the poly_methods schema enum can't drift from the classifier. */
export const CATEGORIES = [...CATEGORY_PATTERNS.map(([cat]) => cat), 'other'] as const;

export function categoryFor(method: string): string {
  for (const [cat, re] of CATEGORY_PATTERNS) {
    if (re.test(method)) return cat;
  }
  return 'other';
}

/**
 * True for the ~19 SDK `prepare*` methods (prepareLimitOrder, prepareErc20Approval,
 * prepareSplitPosition, ...) that resolve to an AsyncGenerator-based signing workflow
 * instead of a plain result — the caller is meant to drive it step-by-step, exchanging
 * signatures across multiple turns. This one-shot dispatcher has no way to do that:
 * detected generically (not by name list, so it can't drift as the SDK adds more of
 * these) rather than assuming which methods return one.
 */
function isDrivableWorkflow(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as any)[Symbol.asyncIterator] === 'function' &&
    typeof (value as any).next === 'function'
  );
}

/** Calls a method on the client by name. Handles both Promise-returning and Paginated-returning SDK methods. */
export async function callMethod(client: any, method: string, params: unknown): Promise<unknown> {
  const fn = client[method];
  if (typeof fn !== 'function') {
    throw new Error(`Unknown method "${method}". Call poly_methods to list what's available on the active client.`);
  }
  const result = params === undefined ? fn() : fn(params);
  if (result && typeof result.firstPage === 'function') {
    // Paginated result (list_* style) — return the first page, trimmed.
    const page = await result.firstPage();
    return trim(page);
  }
  const resolved = await result;
  if (isDrivableWorkflow(resolved)) {
    throw new Error(
      `"${method}" returned a multi-step signing workflow (an AsyncGenerator), which this dispatcher can't drive — ` +
        `calling it does nothing (no signature exchanged, nothing submitted). Use the direct one-shot equivalent ` +
        `instead: placeLimitOrder/placeMarketOrder/postOrder(s) for orders, or the corresponding non-"prepare*" ` +
        `method for approvals/transfers/splits/merges/redemptions/perps-deposit.`
    );
  }
  return trim(resolved);
}

// ---- Rate-limit classification ---------------------------------------------
//
// Polymarket enforces three independent rate-limit regimes (general
// Cloudflare IP limits, CLOB per-signer order/cancel token buckets, and
// separate Perps IP/action/open-order buckets — see
// docs.polymarket.com/api-reference/rate-limits,
// /api-reference/trading-rate-limits, /api-reference/perps/rate-limits).
// None of that detail reaches this dispatcher, though: @polymarket/client's
// own HTTP layer throws a bare RateLimitError on any 429 — `throw new
// RateLimitError(\`Request to ${url} was rate limited\`)` — without reading
// the Retry-After header or response body first. The class itself carries no
// fields beyond the message (confirmed against the SDK's compiled source).
// So retryAfterSeconds/limitType/raw-body are NOT recoverable here no matter
// how this is wrapped — the only signal available is that message string,
// which does still embed the request URL, letting us guess *which* regime
// was hit from the hostname/path. Do not add a `retryAfterSeconds` field
// that just reads back as null/undefined — that would look like a real,
// checked value instead of an acknowledged gap.
const REGIME_HOST_PATTERNS: Array<[string, RegExp]> = [
  ['perps', /perpetuals\.polymarket\.com|\/perps\b/i],
  ['clob-trading', /clob\.polymarket\.com\/(order|orders|cancel)/i],
  ['clob', /clob\.polymarket\.com/i],
  ['gamma', /gamma-api\.polymarket\.com/i],
  ['data', /data-api\.polymarket\.com/i],
  ['bridge', /bridge\.polymarket\.com/i],
];

function guessRateLimitRegime(message: string): string {
  for (const [regime, re] of REGIME_HOST_PATTERNS) {
    if (re.test(message)) return regime;
  }
  return 'unknown';
}

export type RateLimitInfo = { rateLimited: true; regime: string; guidance: string };

/**
 * Classifies a caught error as a Polymarket rate limit or not. Returns null
 * for anything else, so callers can fall through to their normal
 * err.message handling.
 */
export function describeRateLimit(err: unknown): RateLimitInfo | null {
  if (!(err instanceof RateLimitError)) return null;
  const regime = guessRateLimitRegime(err.message);
  return {
    rateLimited: true,
    regime,
    guidance:
      regime === 'clob-trading'
        ? 'CLOB per-signer order/cancel token bucket (tiered by 30-day volume; live enforcement began rolling out 2026-07-24 after a 2-week warning-only period — this may still be a warning, not a real block). Back off and retry with growing delay; do not resend the same batch unchanged.'
        : regime === 'perps'
          ? 'Perps IP, account-action, or open-order bucket. Retry-After is not exposed by the SDK for this error — back off (e.g. 1s, 2s, 4s...) rather than retrying immediately.'
          : regime === 'clob' || regime === 'gamma' || regime === 'data' || regime === 'bridge'
            ? `General Cloudflare IP-based limit on the ${regime} API — these throttle/queue rather than hard-reject; a short backoff before retrying is usually enough.`
            : 'Rate limited by Polymarket; exact bucket unknown from this error alone. Back off with growing delay before retrying.',
  };
}

const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LEN = 2000;
const DEDUPE_MIN_LEN = 200;
const DEDUPE_MIN_REPEATS = 3;

/**
 * Polymarket events repeat the same long boilerplate (e.g. resolution `description`)
 * verbatim across every sibling market. Each copy passes the per-string MAX_STRING_LEN
 * check individually, so 10-15 near-identical copies still balloon the response —
 * this is what blows past token limits on fetchEvent/search. Collapse repeats in place.
 */
function dedupeSiblingStrings(items: unknown[]): unknown[] {
  if (items.length < DEDUPE_MIN_REPEATS || !items.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    return items;
  }
  const firstValueByKey = new Map<string, string>();
  const repeatCountByKey = new Map<string, number>();
  for (const item of items as Record<string, unknown>[]) {
    for (const [k, v] of Object.entries(item)) {
      if (typeof v !== 'string' || v.length < DEDUPE_MIN_LEN) continue;
      if (!firstValueByKey.has(k)) firstValueByKey.set(k, v);
      if (firstValueByKey.get(k) === v) repeatCountByKey.set(k, (repeatCountByKey.get(k) ?? 0) + 1);
    }
  }
  const dedupeKeys = [...repeatCountByKey.entries()].filter(([, c]) => c >= DEDUPE_MIN_REPEATS).map(([k]) => k);
  if (dedupeKeys.length === 0) return items;
  return (items as Record<string, unknown>[]).map((item, i) => {
    if (i === 0) return item;
    const out = { ...item };
    for (const k of dedupeKeys) {
      if (out[k] === firstValueByKey.get(k)) out[k] = `(same as item[0].${k})`;
    }
    return out;
  });
}

/** Trims oversized responses so agents get compact, cheap-to-read JSON. */
export function trim(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) {
    const deduped = dedupeSiblingStrings(value);
    const sliced = deduped.slice(0, MAX_ARRAY_ITEMS).map((v) => trim(v, depth + 1));
    return value.length > MAX_ARRAY_ITEMS ? [...sliced, `…${value.length - MAX_ARRAY_ITEMS} more items truncated`] : sliced;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) + '…' : value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = trim(v, depth + 1);
    }
    return out;
  }
  return value;
}
