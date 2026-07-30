import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { getActiveClient, hasCredentials } from './config/client.js';
import { trim } from './registry.js';

/**
 * Live feed manager backing MCP Resources. Every SDK websocket subscription
 * topic is declared once here (URI pattern + how to build its subscription
 * spec); index.ts loops over FEED_DEFS to register one resource template
 * per topic, so adding a new topic means adding one table row, not a new
 * hand-written resource block.
 */

type Vars = Record<string, string | string[]>;

export type FeedDef = {
  name: string;
  pattern: string;
  auth?: boolean;
  build: (vars: Vars) => Record<string, unknown>;
};

export const FEED_DEFS: FeedDef[] = [
  { name: 'market-book', pattern: 'polymarket://market/{tokenId}/book', build: (v) => ({ topic: 'market', tokenIds: [String(v.tokenId)] }) },
  { name: 'user-activity', pattern: 'polymarket://user/activity', auth: true, build: () => ({ topic: 'user' }) },
  { name: 'sports-events', pattern: 'polymarket://sports/events', build: () => ({ topic: 'sports' }) },
  {
    name: 'comments',
    pattern: 'polymarket://comments/{parentEntityType}/{parentEntityId}',
    build: (v) => ({ topic: 'comments', parentEntityType: String(v.parentEntityType), parentEntityId: Number(v.parentEntityId) }),
  },
  {
    name: 'crypto-binance',
    pattern: 'polymarket://prices/crypto/binance/{symbol}',
    build: (v) => ({ topic: 'prices.crypto.binance', symbols: [String(v.symbol)] }),
  },
  {
    name: 'crypto-chainlink',
    pattern: 'polymarket://prices/crypto/chainlink/{symbol}',
    build: (v) => ({ topic: 'prices.crypto.chainlink', symbols: [String(v.symbol)] }),
  },
  {
    name: 'equity-prices',
    pattern: 'polymarket://prices/equity/{symbol}',
    build: (v) => ({ topic: 'prices.equity.pyth', symbol: String(v.symbol) }),
  },
  { name: 'perps-trades', pattern: 'polymarket://perps/{instrumentId}/trades', build: (v) => ({ topic: 'perps.trades', instrumentId: String(v.instrumentId) }) },
  { name: 'perps-bbo', pattern: 'polymarket://perps/{instrumentId}/bbo', build: (v) => ({ topic: 'perps.bbo', instrumentId: String(v.instrumentId) }) },
  { name: 'perps-book', pattern: 'polymarket://perps/{instrumentId}/book', build: (v) => ({ topic: 'perps.book', instrumentId: String(v.instrumentId) }) },
  {
    name: 'perps-candles',
    pattern: 'polymarket://perps/{instrumentId}/candles/{interval}',
    build: (v) => ({ topic: 'perps.candles', instrumentId: String(v.instrumentId), interval: String(v.interval) }),
  },
  { name: 'perps-tickers', pattern: 'polymarket://perps/tickers', build: () => ({ topic: 'perps.tickers' }) },
  {
    name: 'perps-statistics',
    pattern: 'polymarket://perps/{instrumentId}/statistics',
    build: (v) => ({ topic: 'perps.statistics', instrumentId: String(v.instrumentId) }),
  },
];

const compiled = FEED_DEFS.map((def) => ({ def, template: new UriTemplate(def.pattern) }));

function matchFeed(uri: string): { def: FeedDef; vars: Vars } | null {
  for (const { def, template } of compiled) {
    const vars = template.match(uri);
    if (vars) return { def, vars };
  }
  return null;
}

export function isLiveFeedUri(uri: string): boolean {
  return matchFeed(uri) !== null;
}

type FeedStatus = 'connected' | 'reconnecting' | 'failed';
type FeedState = {
  latest: unknown[];
  closing: boolean;
  close?: () => Promise<void>;
  status: FeedStatus;
  lastEventAt: number | null;
};

// Keyed by in-flight/resolved start promise (not the resolved FeedState) so a
// synchronous check-then-set around the one `await` boundary in
// ensureAndRead can't interleave — two concurrent reads of the same URI must
// share one subscription, not open two.
const feeds = new Map<string, Promise<FeedState>>();
const MAX_BUFFERED_EVENTS = 20;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * Runs the subscription for as long as the feed is wanted, reconnecting with
 * capped exponential backoff on any drop. Without this, a WebSocket blip
 * (real over long-lived sessions) silently froze `state.latest` forever —
 * every future ensureAndRead() call for that URI kept replaying the same
 * stale buffer with no error and no signal it had gone stale, which is a
 * genuine risk for a trading tool if an agent treats frozen data as live.
 * `status`/`lastEventAt` on the returned state make staleness observable
 * instead of silent.
 */
async function runFeed(def: FeedDef, vars: Vars, state: FeedState, handle: { close(): Promise<void> } & AsyncIterable<unknown>, onUpdate: () => void): Promise<void> {
  let attempt = 0;
  let current = handle;
  while (!state.closing) {
    state.close = () => current.close();
    try {
      for await (const event of current) {
        if (state.closing) break;
        state.latest.push(trim(event));
        if (state.latest.length > MAX_BUFFERED_EVENTS) state.latest.shift();
        state.lastEventAt = Date.now();
        state.status = 'connected';
        attempt = 0;
        onUpdate();
      }
    } catch {
      /* iteration failed — fall through to reconnect below */
    }
    if (state.closing) return;

    attempt++;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      state.status = 'failed';
      onUpdate();
      return;
    }
    state.status = 'reconnecting';
    onUpdate();
    await new Promise((r) => setTimeout(r, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1)));
    if (state.closing) return;
    try {
      const client = await getActiveClient();
      current = await client.subscribe([def.build(vars)]);
    } catch {
      /* resubscribe failed — loop retries after the next backoff, up to MAX_RECONNECT_ATTEMPTS */
    }
  }
}

async function startFeed(def: FeedDef, vars: Vars, onUpdate: () => void): Promise<FeedState> {
  if (def.auth && !hasCredentials()) {
    throw new Error(`${def.pattern} requires PRIVATE_KEY (authenticated feed — your own account only).`);
  }
  const client = await getActiveClient();
  // First attempt happens here, outside runFeed, so a bad tokenId/instrumentId
  // still rejects this promise immediately instead of vanishing into a
  // background retry loop the caller never learns about.
  const handle = await client.subscribe([def.build(vars)]);
  const state: FeedState = { latest: [], closing: false, status: 'connected', lastEventAt: null };
  void runFeed(def, vars, state, handle, onUpdate);
  return state;
}

export type FeedSnapshot = { events: unknown[]; status: FeedStatus; lastEventAt: number | null };

/** Ensures a subscription for this URI is running; returns the latest buffered events plus connection health. */
export async function ensureAndRead(uri: string, onUpdate: () => void): Promise<FeedSnapshot> {
  const matched = matchFeed(uri);
  if (!matched) throw new Error(`Not a live-feed URI: ${uri}`);
  let statePromise = feeds.get(uri);
  if (!statePromise) {
    statePromise = startFeed(matched.def, matched.vars, onUpdate);
    feeds.set(uri, statePromise);
    // Don't leave a failed start cached — the next read should retry, not
    // keep replaying the same rejection forever.
    statePromise.catch(() => feeds.delete(uri));
  }
  const state = await statePromise;
  // Reconnection gave up (MAX_RECONNECT_ATTEMPTS exhausted) — evict so the
  // *next* read starts a fresh subscription instead of replaying 'failed'
  // forever. This read still returns the last known snapshot honestly.
  if (state.status === 'failed') feeds.delete(uri);
  return { events: state.latest, status: state.status, lastEventAt: state.lastEventAt };
}

export async function closeAllFeeds(): Promise<void> {
  for (const statePromise of feeds.values()) {
    try {
      const state = await statePromise;
      state.closing = true;
      await state.close?.();
    } catch {
      /* best-effort */
    }
  }
  feeds.clear();
}
