#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the real MCP server over stdio exactly as an
 * agent host would, performs the MCP handshake, and checks:
 *   - the server starts (builder-integrity check doesn't kill it)
 *   - tools/list returns the expected lightweight tool set
 *   - poly_methods works (read-only, no credentials required)
 *   - a real live poly_read (list_markets-equivalent) round-trips
 *   - poly_write correctly rejects a read-only method (proves the split works)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke-test-client', version: '1.0.0' }, { capabilities: {} });

  console.log('Connecting over stdio (dist/index.js)...');
  await client.connect(transport);
  console.log('Handshake OK — builder-integrity check passed, server accepted the connection.');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`tools/list OK — ${tools.length} tools: ${names.join(', ')}`);
  for (const expected of ['poly_read', 'poly_write', 'poly_methods', 'poly_feed_read', 'refresh_polymarket_guide']) {
    if (!names.includes(expected)) throw new Error(`Missing expected tool: ${expected}`);
  }

  const methodsResult = await client.callTool({ name: 'poly_methods', arguments: { category: 'markets' } });
  const methodsText = methodsResult.content?.[0]?.text || '{}';
  const parsed = JSON.parse(methodsText);
  if (!Array.isArray(parsed.methods) || parsed.methods.length === 0) {
    throw new Error('poly_methods returned no methods');
  }
  console.log(`poly_methods OK — ${parsed.methods.length} market-category methods, authenticated=${parsed.authenticated}`);

  const { resources } = await client.listResources();
  console.log(`resources/list OK — ${resources.length} resources: ${resources.map((r) => r.uri).join(', ')}`);

  if (process.env.SMOKE_TEST_OFFLINE) {
    console.log('SMOKE_TEST_OFFLINE set — skipping live network calls.');
    await client.close();
    console.log('\nSMOKE TEST PASSED (offline mode).');
    return;
  }

  console.log('Calling poly_read({ method: "listMarkets" }) — requires network egress to Polymarket...');
  const callResult = await client.callTool({ name: 'poly_read', arguments: { method: 'listMarkets', params: { closed: false, pageSize: 2 } } });
  if (callResult.isError) {
    throw new Error(`poly_read errored: ${callResult.content?.[0]?.text}`);
  }
  const data = JSON.parse(callResult.content[0].text);
  if (!Array.isArray(data.items)) {
    throw new Error(`Unexpected poly_read shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (typeof data.hasMore !== 'boolean' || !('nextCursor' in data)) {
    throw new Error(`poly_read pagination fields missing: ${JSON.stringify(data).slice(0, 200)}`);
  }
  console.log(`poly_read OK — got ${data.items.length} live market(s), hasMore=${data.hasMore}.`);

  // Regression test: params used to be schema'd as object-only
  // (z.record), which rejected the SDK's array-shaped batch methods
  // (fetchMidpoints/fetchPrices/fetchOrderBooks/...) before the dispatcher
  // ever saw them. Uses a real tokenId from the listMarkets result above.
  const tokenId = data.items[0]?.outcomes?.yes?.tokenId;
  if (!tokenId) throw new Error('Could not extract a tokenId from listMarkets result for the batch-params check');
  console.log('Calling poly_read({ method: "fetchMidpoints", params: [ { tokenId } ] }) — array params must pass the schema...');
  const batchResult = await client.callTool({ name: 'poly_read', arguments: { method: 'fetchMidpoints', params: [{ tokenId }] } });
  if (batchResult.isError) {
    throw new Error(`array-params poly_read errored: ${batchResult.content?.[0]?.text}`);
  }
  console.log(`fetchMidpoints OK — ${batchResult.content[0].text.slice(0, 80)}…`);

  // Regression test for a real bug: Gamma search/listEvents on genuinely
  // distinct (non-duplicate) events blew past 400,000 characters even after
  // per-item trimming — each event duplicates most of its own fields once
  // per nested market, so trim()'s per-item/per-string caps alone never
  // bounded the aggregate. capTotalSize() in registry.ts is a second,
  // budget-aware pass that shrinks whichever array is largest until the
  // whole response fits — this checks it actually holds under a real query
  // that reproduced the original failure.
  console.log('Calling poly_read({ method: "search", params: { q: "fed rate" } }) — must stay under the size budget...');
  const searchResult = await client.callTool({ name: 'poly_read', arguments: { method: 'search', params: { q: 'fed rate' } } });
  if (searchResult.isError) {
    throw new Error(`search errored: ${searchResult.content?.[0]?.text}`);
  }
  const searchText = searchResult.content[0].text;
  if (searchText.length > 22_000) {
    throw new Error(`search response was ${searchText.length} chars — capTotalSize regression (budget is 20,000)`);
  }
  // Small is not enough: the original capTotalSize popped from the OUTER
  // items array first, so this exact check passed while search returned
  // events: [] for every query (verified live 2026-07-30 — the size assert
  // alone let a fully broken search ship). The response must be small AND
  // still contain results.
  const searchData = JSON.parse(searchText);
  if (!Array.isArray(searchData.items?.events) || searchData.items.events.length === 0) {
    throw new Error(`search returned no events — size-capping dropped all items: ${searchText.slice(0, 200)}`);
  }
  console.log(`search OK — ${searchText.length} chars, ${searchData.items.events.length} event(s) retained.`);

  // Same failure mode, other entry point: top-volume events are the largest
  // objects Gamma serves (20-30 nested markets each), so listEvents ordered
  // by volume is the worst case for the size cap. Must return a non-empty
  // page even at pageSize 1.
  console.log('Calling poly_read({ method: "listEvents", params: { order: "volume", ascending: false, pageSize: 1 } })...');
  const eventsResult = await client.callTool({
    name: 'poly_read',
    arguments: { method: 'listEvents', params: { order: 'volume', ascending: false, pageSize: 1 } },
  });
  if (eventsResult.isError) throw new Error(`listEvents errored: ${eventsResult.content?.[0]?.text}`);
  const eventsText = eventsResult.content[0].text;
  if (eventsText.length > 22_000) {
    throw new Error(`listEvents response was ${eventsText.length} chars — capTotalSize regression (budget is 20,000)`);
  }
  const eventsData = JSON.parse(eventsText);
  if (!Array.isArray(eventsData.items) || eventsData.items.length === 0) {
    throw new Error(`listEvents (by volume) returned no items — size-capping dropped the event: ${eventsText.slice(0, 200)}`);
  }
  console.log(`listEvents OK — ${eventsText.length} chars, top-volume event retained: "${eventsData.items[0]?.title}".`);

  // Regression test for a verified upstream SDK bug: fetchPerpsTicker is
  // implemented in @polymarket/client as fetchPerpsTickers + take-first,
  // and the API ignores the instrumentId query param — so every call
  // returned instrument 1 (SP500-USD) regardless of what was asked.
  // registry.ts now filters client-side; this checks the filter holds.
  console.log('Calling poly_read({ method: "fetchPerpsTicker", params: { instrumentId: 6 } }) — must return BTC, not SP500...');
  const tickerResult = await client.callTool({ name: 'poly_read', arguments: { method: 'fetchPerpsTicker', params: { instrumentId: 6 } } });
  if (tickerResult.isError) throw new Error(`fetchPerpsTicker errored: ${tickerResult.content?.[0]?.text}`);
  const ticker = JSON.parse(tickerResult.content[0].text);
  if (ticker.instrumentId !== 6) {
    throw new Error(`fetchPerpsTicker(6) returned instrumentId ${ticker.instrumentId} (${ticker.symbol}) — upstream take-first bug is back`);
  }
  console.log(`fetchPerpsTicker OK — instrumentId=6 (${ticker.symbol}).`);

  // subscribe cannot work through a one-shot dispatcher; it must be rejected
  // with a pointer to the live-feed resources, not leak SDK internals
  // ("r.map is not a function" was the pre-fix behavior).
  console.log('Verifying poly_read rejects subscribe with a live-feed-resources pointer...');
  const subResult = await client.callTool({ name: 'poly_read', arguments: { method: 'subscribe', params: {} } });
  if (!subResult.isError) throw new Error('poly_read should have rejected subscribe');
  if (!/live-feed MCP resources/.test(subResult.content?.[0]?.text || '')) {
    throw new Error(`subscribe rejection lacks the resources pointer: ${subResult.content?.[0]?.text}`);
  }
  console.log('subscribe correctly rejected with resources pointer.');

  // Unknown methods used to be misclassified as fund-moving ("moves
  // funds/state — call it via poly_write") because isFundMoving() is
  // "not on the public client", which is also true of typos.
  console.log('Verifying unknown method names get an honest error (not "use poly_write")...');
  const unknownResult = await client.callTool({ name: 'poly_read', arguments: { method: 'fetchFooBar', params: {} } });
  if (!unknownResult.isError) throw new Error('poly_read should have errored on an unknown method');
  const unknownText = unknownResult.content?.[0]?.text || '';
  if (/moves funds\/state/.test(unknownText)) {
    throw new Error(`unknown method still misclassified as fund-moving: ${unknownText}`);
  }
  console.log(`unknown-method error OK — ${unknownText.slice(0, 90)}…`);

  console.log('Verifying poly_write rejects a read-only method (proves the read/write split is enforced)...');
  const wrongTool = await client.callTool({ name: 'poly_write', arguments: { method: 'listMarkets', params: {} } });
  if (!wrongTool.isError) throw new Error('poly_write should have rejected a read-only method');
  console.log('poly_write correctly rejected listMarkets.');

  // Regression test for a real bug: cancelOrder/cancelOrders/cancelAll/
  // cancelMarketOrders were never in the old hardcoded FUND_MOVING_METHODS
  // list, so they were callable via poly_read — completely bypassing the
  // read/write split for a call that mutates trading state exactly like
  // placing an order does. Fixed by classifying fund-moving dynamically
  // (secure-only + not on a small safe-reads denylist) instead of a name
  // list that can silently miss new write methods.
  console.log('Verifying poly_read rejects cancelOrder (secure-only + mutating — must not bypass the read/write split)...');
  const cancelViaRead = await client.callTool({ name: 'poly_read', arguments: { method: 'cancelOrder', params: { orderID: 'x' } } });
  if (!cancelViaRead.isError) throw new Error('poly_read should have rejected cancelOrder as fund-moving');
  console.log('poly_read correctly rejected cancelOrder.');

  // Regression test for the live-feed reconnect fix: ensureAndRead() used to
  // return a bare events array; a dropped WebSocket froze it forever with no
  // signal. It now returns { events, status, lastEventAt } so an agent can
  // tell frozen data from live data. This only checks the happy path — a
  // real mid-stream drop isn't practically simulable here.
  console.log(`Reading polymarket://market/${tokenId}/book (live WebSocket subscribe)...`);
  const feed = await client.readResource({ uri: `polymarket://market/${tokenId}/book` });
  const feedData = JSON.parse(feed.contents?.[0]?.text || '{}');
  if (!('events' in feedData) || !('status' in feedData) || !('lastEventAt' in feedData)) {
    throw new Error(`Unexpected live-feed shape: ${JSON.stringify(feedData).slice(0, 200)}`);
  }
  if (feedData.status !== 'connected') {
    throw new Error(`Expected status 'connected' on first read, got '${feedData.status}'`);
  }
  console.log(`live-feed OK — status=${feedData.status}, ${feedData.events.length} buffered event(s).`);

  // poly_feed_read is the tool-only-host equivalent of the resource read above —
  // same URI, same underlying ensureAndRead(), just reachable without MCP
  // resource support. Must return the identical { events, status, lastEventAt } shape.
  console.log(`Calling poly_feed_read({ uri: "polymarket://market/${tokenId}/book" }) — tool-only equivalent of the resource read...`);
  const feedToolResult = await client.callTool({ name: 'poly_feed_read', arguments: { uri: `polymarket://market/${tokenId}/book` } });
  if (feedToolResult.isError) {
    throw new Error(`poly_feed_read errored: ${feedToolResult.content?.[0]?.text}`);
  }
  const feedToolData = JSON.parse(feedToolResult.content?.[0]?.text || '{}');
  if (!('events' in feedToolData) || !('status' in feedToolData) || !('lastEventAt' in feedToolData)) {
    throw new Error(`Unexpected poly_feed_read shape: ${JSON.stringify(feedToolData).slice(0, 200)}`);
  }
  console.log(`poly_feed_read OK — status=${feedToolData.status}, ${feedToolData.events.length} buffered event(s).`);

  console.log('Reading polymarket://docs/llms (live fetch from docs.polymarket.com)...');
  const doc = await client.readResource({ uri: 'polymarket://docs/llms' });
  if (!doc.contents?.[0]?.text?.length) {
    throw new Error('polymarket://docs/llms returned empty content');
  }
  console.log(`docs/llms OK — ${doc.contents[0].text.length} chars.`);

  await client.close();
  console.log('\nSMOKE TEST PASSED.');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err?.message || err);
  process.exit(1);
});
