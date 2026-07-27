/**
 * Generic dispatcher core: every @polymarket/client SDK method is callable
 * by name through poly_call, discoverable through poly_methods. No 1:1
 * hand-written tool per method — new SDK methods are covered automatically.
 */

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

export function isFundMoving(method: string): boolean {
  return FUND_MOVING_METHODS.has(method);
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
  return trim(await result);
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
