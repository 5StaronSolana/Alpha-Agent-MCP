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
  for (const expected of ['poly_read', 'poly_write', 'poly_methods', 'get_guardrails', 'set_guardrails', 'refresh_polymarket_guide']) {
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

  console.log('Verifying poly_write rejects a read-only method (proves the read/write split is enforced)...');
  const wrongTool = await client.callTool({ name: 'poly_write', arguments: { method: 'listMarkets', params: {} } });
  if (!wrongTool.isError) throw new Error('poly_write should have rejected a read-only method');
  console.log('poly_write correctly rejected listMarkets.');

  // Regression test for a real bug: cancelOrder/cancelOrders/cancelAll/
  // cancelMarketOrders were never in the old hardcoded FUND_MOVING_METHODS
  // list, so they were callable via poly_read — completely bypassing the
  // readOnly guardrail gate for a call that mutates trading state exactly
  // like placing an order does. Fixed by classifying fund-moving dynamically
  // (secure-only + not on a small safe-reads denylist) instead of a name
  // list that can silently miss new write methods.
  console.log('Verifying poly_read rejects cancelOrder (secure-only + mutating — must not bypass guardrails)...');
  const cancelViaRead = await client.callTool({ name: 'poly_read', arguments: { method: 'cancelOrder', params: { orderID: 'x' } } });
  if (!cancelViaRead.isError) throw new Error('poly_read should have rejected cancelOrder as fund-moving');
  console.log('poly_read correctly rejected cancelOrder.');

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
