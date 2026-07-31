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
// (must go through poly_write) whenever it ISN'T on the public
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
// poly_read, completely bypassing the read/write split. Under this
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
 * a new method's safety is unclear, leaving it gated (requiring PRIVATE_KEY
 * and routing through poly_write) is the safe default, not adding it here.
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

/** Subset of fund-moving methods with an order-shaped request — used to decide when to prime/return live-feed subscribe URIs after a write. */
export const ORDER_METHODS = new Set([
  'placeLimitOrder',
  'placeMarketOrder',
  'createLimitOrder',
  'createMarketOrder',
]);

export function isFundMoving(method: string): boolean {
  return !publicMethodNames().has(method) && !SAFE_AUTHENTICATED_READS.has(method);
}

export function isOrderMethod(method: string): boolean {
  return ORDER_METHODS.has(method);
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
  if (method === 'subscribe') {
    // The SDK's subscribe() opens a long-lived WebSocket and returns an async
    // iterator — a one-shot tool call can neither hold nor drive it, and
    // letting it dispatch surfaced raw internals ("r.map is not a function")
    // instead of anything actionable (verified live 2026-07-30).
    throw new Error(
      'subscribe opens a long-lived WebSocket this one-shot dispatcher cannot hold. Use the live-feed MCP resources ' +
        'instead (read once via resources/read, push updates via resources/subscribe): polymarket://market/{tokenId}/book, ' +
        'polymarket://sports/events, polymarket://comments/{parentEntityType}/{parentEntityId}, ' +
        'polymarket://prices/crypto/binance/{symbol}, polymarket://prices/crypto/chainlink/{symbol}, ' +
        'polymarket://prices/equity/{symbol}, polymarket://perps/{instrumentId}/trades|bbo|book|statistics, ' +
        'polymarket://perps/{instrumentId}/candles/{interval}, polymarket://perps/tickers, and ' +
        'polymarket://user/activity (requires PRIVATE_KEY).'
    );
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

  if (method === 'fetchPerpsTicker') {
    // Workaround for a verified upstream bug (@polymarket/client, checked
    // against its compiled source): the SDK implements fetchPerpsTicker as
    // "call fetchPerpsTickers with instrumentId as a query param, return the
    // FIRST element" — but /v1/info/tickers ignores that query param and
    // always returns the full unfiltered list, so callers always got
    // instrument 1 (SP500-USD) no matter what they asked for (verified live
    // 2026-07-30 with instrumentId 6 and 21). Filter client-side instead.
    // Remove once the SDK filters the result itself.
    const wanted = (forwarded as Record<string, unknown> | undefined)?.instrumentId;
    if (typeof wanted !== 'number') {
      throw new Error('fetchPerpsTicker requires { instrumentId: number } — get IDs from fetchPerpsInstruments.');
    }
    const all = await client.fetchPerpsTickers({});
    const hit = Array.isArray(all) ? all.find((t: any) => t?.instrumentId === wanted) : undefined;
    if (!hit) {
      throw new Error(`Perps ticker ${wanted} was not returned by the API — call fetchPerpsInstruments for valid instrument IDs.`);
    }
    return raw ? hit : capTotalSize(trim(hit));
  }

  const result = forwarded === undefined ? fn() : fn(forwarded);
  if (result && typeof result.firstPage === 'function') {
    // Paginated result (list_* style) — return the first page.
    const page = await result.firstPage();
    return raw ? page : capTotalSize(trim(page));
  }
  const resolved = await result;
  if (isTransactionHandle(resolved) && !skipWait) {
    const outcome = await resolved.wait();
    return raw ? outcome : capTotalSize(trim(outcome));
  }
  return raw ? resolved : capTotalSize(trim(resolved));
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

const MAX_TOTAL_CHARS = 20_000;

/**
 * When shrinking, don't bother descending into a nested array once it's
 * already smaller than this — at that point its parent's items are compact
 * and popping the parent is the honest next step.
 */
const NESTED_ARRAY_FLOOR_CHARS = 1_500;

type ArrayNode = { arr: unknown[]; descendants: unknown[][] };

/** Collects every array in the tree with its (transitive) descendant arrays, so capTotalSize can shrink innermost bloat before dropping whole items. */
function collectArrayNodes(value: unknown, nodes: ArrayNode[]): unknown[][] {
  if (Array.isArray(value)) {
    const descendants: unknown[][] = [];
    for (const v of value) descendants.push(...collectArrayNodes(v, nodes));
    nodes.push({ arr: value, descendants });
    return [value, ...descendants];
  }
  if (value && typeof value === 'object') {
    const found: unknown[][] = [];
    for (const v of Object.values(value as Record<string, unknown>)) found.push(...collectArrayNodes(v, nodes));
    return found;
  }
  return [];
}

/**
 * trim() bounds each array/string independently (per-item, per-field), but
 * verified live against Polymarket's Gamma search/listEvents: a handful of
 * genuinely distinct events (not near-duplicates dedupeSiblingStrings can
 * collapse) still serialized past 400,000 characters — each event object
 * duplicates most of its own fields once per nested market, so per-item caps
 * alone don't bound the aggregate. This is a second, budget-aware pass with
 * no assumption about *which* field holds the bloat.
 *
 * Shrink order matters and is innermost-first: the earlier version popped
 * from whichever array was largest overall, which for `{ items: [event] }`
 * is always the OUTER items array (it contains everything) — so a single
 * oversized event (top-volume events carry 20-30 nested markets) was thrown
 * away whole, and search/listEvents returned `items: []` with hasMore: true
 * even at pageSize 1 (verified live 2026-07-30: search totalCount said 1,
 * items came back empty). Now, when the largest array's own bulk lives in a
 * sizable nested array (an event's `markets`, a comment's `reactions`), we
 * descend and pop from that innermost array instead, so top-level items
 * survive in shortened form. Works identically for `{ items: [...] }`
 * pagination shapes and search's nested
 * `{ items: { events: [...], profiles: [...], tags: [...] } }` shape.
 */
export function capTotalSize(value: unknown, maxChars = MAX_TOTAL_CHARS): unknown {
  let serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) return value;
  const nodes: ArrayNode[] = [];
  collectArrayNodes(value, nodes);
  const nodeByArr = new Map<unknown[], ArrayNode>(nodes.map((n) => [n.arr, n]));
  let truncated = false;
  let guard = 0;
  while (serialized.length > maxChars && guard++ < 5000) {
    nodes.sort((a, b) => JSON.stringify(b.arr).length - JSON.stringify(a.arr).length);
    let node = nodes.find((n) => n.arr.length > 0);
    if (!node) break;
    // Descend to the innermost still-sizable array before popping anything.
    for (;;) {
      const child: unknown[] | undefined = node.descendants
        .filter((d) => d.length > 0 && JSON.stringify(d).length > NESTED_ARRAY_FLOOR_CHARS)
        .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
      if (!child) break;
      node = nodeByArr.get(child)!;
    }
    node.arr.pop();
    truncated = true;
    serialized = JSON.stringify(value);
  }
  if (!truncated) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      ...(value as object),
      _sizeCapped:
        'Response was too large even after per-item trimming, so nested lists (innermost first) were shortened to fit a safe size — counts inside items (e.g. an event\'s markets) and trailing items may be incomplete; narrow with pageSize/filters or paginate with cursor instead of relying on this response being complete.',
    };
  }
  return value;
}
