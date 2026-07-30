/**
 * Generic dispatcher core: every @polymarket/client SDK method is callable
 * by name through poly_call, discoverable through poly_methods. No 1:1
 * hand-written tool per method — new SDK methods are covered automatically.
 */

import { RateLimitError } from '@polymarket/client';
import { getPublicClient } from './config/client.js';

// ---- Fund-moving classification --------------------------------------------
//
// Gated by capability, not a frozen name list: a method is "fund-moving"
// (must go through poly_write + guardrails) whenever it ISN'T on the public
// (unauthenticated) client — i.e. it requires a signing key — unless it's on
// the small SAFE_AUTHENTICATED_READS denylist below. This means new SDK
// write methods are gated automatically the moment they appear on the
// secure client after an @polymarket/client bump, with no set to keep in
// sync. It also means every method actually reachable is dynamically
// discovered (poly_methods, listMethodNames) — this file classifies, it
// doesn't enumerate.
//
// Concretely fixes a real bug this replaces: cancelOrder/cancelOrders/
// cancelAll/cancelMarketOrders were never in the old hardcoded
// FUND_MOVING_METHODS list (a plain oversight — cancels change trading
// state exactly like placing an order does), so they were callable through
// poly_read, completely bypassing the readOnly guardrail gate. Under this
// rule they're gated correctly with no name added anywhere: they're
// secure-only and not on the denylist.

let publicMethodNamesCache: Set<string> | null = null;

/** Lazy + cached — getPublicClient() is a pure local construction (see config/client.ts), no network I/O, safe to call repeatedly. */
function publicMethodNames(): Set<string> {
  if (!publicMethodNamesCache) {
    publicMethodNamesCache = new Set(listMethodNames(getPublicClient()));
  }
  return publicMethodNamesCache;
}

/**
 * Authenticated-only methods that read account state but don't move funds,
 * approve access, or commit to a trade — carved out of the "secure-only =
 * gated" default above. Keep this short, and only ever remove from it: if
 * a new method's safety is unclear, leaving it gated (requiring
 * set_guardrails) is the safe default, not adding it here.
 */
const SAFE_AUTHENTICATED_READS = new Set([
  'listOpenOrders',
  'fetchOrder',
  'fetchOrderScoring',
  'fetchOrdersScoring',
  'fetchClosedOnlyMode',
  'fetchNotifications',
  // dropNotifications deliberately NOT here: it mutates notification state
  // (clears the inbox), so it stays gated per the "if unclear, don't
  // denylist" rule above — it was briefly listed and removed on review.
  'fetchRewardPercentages',
  'fetchTotalEarningsForUserForDay',
  'listUserEarningsForDay',
  'listUserEarningsAndMarketsConfig',
  'listAccountTrades',
  'waitForOrderFillSettlement',
]);

/** Subset of fund-moving methods with an order-shaped request, eligible for notional/deviation checks. */
export const ORDER_METHODS = new Set([
  'placeLimitOrder',
  'placeMarketOrder',
  'createLimitOrder',
  'createMarketOrder',
]);

/**
 * Market-order subset of ORDER_METHODS. Their request shape differs from
 * limit orders in exactly the way that matters for the notional guardrail
 * (verified against the SDK's own types): BUY takes `amount` — already the
 * desired USD notional, no conversion — and SELL takes `shares`
 * (human-readable outcome tokens, so USD notional ≈ shares × current mid).
 * Neither carries `price`/`size`, so the limit-order `price * size` check
 * silently never fired for these before this split.
 */
export const MARKET_ORDER_METHODS = new Set(['placeMarketOrder', 'createMarketOrder']);

export function isMarketOrderMethod(method: string): boolean {
  return MARKET_ORDER_METHODS.has(method);
}

/**
 * Subset of the fund-moving methods with a raw `amount: bigint | 'max'` request
 * field denominated in pUSD base units (confirmed against the SDK's own
 * types — e.g. DepositToPerpsRequest.amount doc: "Collateral amount in base
 * units" — and against pUSD's fixed 6 decimals, docs.polymarket.com/
 * concepts/pusd). Distinct from ORDER_METHODS, whose `size` field is already
 * human-readable outcome-token units per the SDK's own doc comment on
 * PrepareLimitOrderRequest.size — do not apply the same base-units
 * conversion there, it would be wrong by 10^6.
 *
 * redeemPositions, executeCollateralReturnPlan, and setupTradingApprovals
 * are fund-moving too (secure-only, not on SAFE_AUTHENTICATED_READS) but
 * carry no checkable amount (redeem always redeems the full winning
 * balance; the other two take no amount or an opaque pre-computed
 * plan/no request at all) — left out of this set deliberately, not an
 * oversight.
 */
export const COLLATERAL_AMOUNT_METHODS = new Set([
  'approveErc20',
  'splitPosition',
  'mergePositions',
  'depositToPerps',
  'withdrawFromPerps',
]);

export function isFundMoving(method: string): boolean {
  return !publicMethodNames().has(method) && !SAFE_AUTHENTICATED_READS.has(method);
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

/**
 * True for the SDK's TransactionHandle shape (returned by approveErc20,
 * splitPosition, mergePositions, depositToPerps, withdrawFromPerps, ...):
 * { transactionHash, transactionId, wait(): Promise<TransactionOutcome> }.
 * Detected structurally (has transactionHash + a wait function), not by a
 * method name list, for the same reason isDrivableWorkflow is.
 */
function isTransactionHandle(value: unknown): value is { wait: () => Promise<unknown> } {
  return !!value && typeof value === 'object' && 'transactionHash' in (value as any) && typeof (value as any).wait === 'function';
}

/**
 * Calls a method on the client by name. Handles both Promise-returning and
 * Paginated-returning SDK methods.
 *
 * Two dispatcher-only flags are read out of an object-shaped `params` and
 * never forwarded to the SDK:
 *  - `wait: false` — skip auto-awaiting a returned TransactionHandle's
 *    `.wait()`. Default is to wait: a one-shot MCP call has no way to hand
 *    a live handle back for a later poly_read, so returning only
 *    {transactionHash, transactionId: null} by default would leave the
 *    agent with no way to learn whether the transaction actually settled.
 *  - `raw: true` — skip trim() and return the SDK's response untouched
 *    (debugging escape hatch; default stays trimmed for token budget).
 * Array-shaped params (the SDK's own batch methods — fetchPrices,
 * fetchMidpoints, fetchOrderBooks, ...) pass through unchanged; these two
 * flags aren't supported there since there's no top-level object to read
 * them from.
 *
 * Pagination needs no special handling: SDK Paginated methods already
 * accept `cursor`/`pageSize` as ordinary request fields, and their
 * `Page<T>` result already carries `items`/`hasMore`/`nextCursor` straight
 * through trim() unchanged (verified live: passing a previous response's
 * nextCursor back as the next call's params.cursor advances the page).
 * An agent pages by doing exactly that.
 */
export async function callMethod(client: any, method: string, params: unknown): Promise<unknown> {
  const fn = client[method];
  if (typeof fn !== 'function') {
    throw new Error(`Unknown method "${method}". Call poly_methods to list what's available on the active client.`);
  }

  let raw = false;
  let skipWait = false;
  let forwarded = params;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const p = { ...(params as Record<string, unknown>) };
    if ('raw' in p) {
      raw = p.raw === true;
      delete p.raw;
    }
    if ('wait' in p) {
      skipWait = p.wait === false;
      delete p.wait;
    }
    forwarded = p;
  }

  const result = forwarded === undefined ? fn() : fn(forwarded);
  if (result && typeof result.firstPage === 'function') {
    // Paginated result (list_* style) — return the first page.
    const page = await result.firstPage();
    return raw ? page : trim(page);
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
  if (isTransactionHandle(resolved) && !skipWait) {
    const outcome = await resolved.wait();
    return raw ? outcome : trim(outcome);
  }
  return raw ? resolved : trim(resolved);
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
