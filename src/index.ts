#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { verifyClientAnchor, BUILDER_CODE } from './config/builder-code.js';
import { getActiveClient, getPublicClient, hasCredentials } from './config/client.js';
import { listMethodNames, categoryFor, callMethod, isFundMoving, isOrderMethod, CATEGORIES, describeRateLimit } from './registry.js';
import { getGuide, refreshGuide } from './docs.js';
import { FEED_DEFS, ensureAndRead, closeAllFeeds, isLiveFeedUri } from './live-feeds.js';

// ---- Builder attribution integrity gate (see config/builder-code.ts + LICENSE) ----

const EXPECTED_BUILDER_FILE_HASH = 'a6e7789b7334b4facdc131291d1ca8dc159b54d95066158267d276ec65d6acea';

function assertBuilderIntegrity(): void {
  try {
    verifyClientAnchor();
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'config', 'builder-code.js'), 'utf8');
    const actualHash = createHash('sha256').update(source, 'utf8').digest('hex');
    if (actualHash !== EXPECTED_BUILDER_FILE_HASH) {
      throw new Error('FATAL: builder attribution code has been modified (config/builder-code.js hash mismatch).');
    }
  } catch (e: any) {
    console.error(e?.message || String(e));
    console.error('Refusing to start. See LICENSE.');
    process.exit(1);
  }
}

assertBuilderIntegrity();
console.error(`alpha-agent-mcp starting — builder code: ${BUILDER_CODE.slice(0, 10)}… (see LICENSE)`);

const server = new McpServer(
  { name: 'alpha-agent-mcp', version: '1.0.0' },
  {
    capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
    instructions:
      'Call poly_methods first — it reflects exactly what the active client (public or authenticated) can do ' +
      'right now, not a fixed list. poly_read for non-mutating calls, poly_write for mutating ones (orders, ' +
      'cancels, approvals, transfers, splits/merges/redeems, perps deposit/withdraw) — poly_write only works once ' +
      'PRIVATE_KEY is set; without it, fund-moving methods are absent from the client entirely. Paginated results are { items, hasMore, nextCursor }; pass nextCursor back ' +
      "as the next call's params.cursor to page. On-chain writes auto-wait for settlement by default — pass " +
      '{ wait: false } to skip, or { raw: true } to skip response trimming. A rate-limited call returns ' +
      '{ rateLimited, regime, guidance } — back off, do not retry immediately. poly_methods lists names only, ' +
      'not per-method field schemas — if unsure of a method\'s request shape, call it with {} (or a guessed ' +
      'shape) first: the SDK\'s own validation error lists exactly which fields are missing/invalid before it ' +
      'ever reaches the network. Live-feed resources return { events, status, lastEventAt } — status is ' +
      "'connected' | 'reconnecting' | 'failed'; treat non-'connected' as stale data, not an error to retry " +
      'yourself (the server reconnects with backoff on its own). Hosts without MCP resource support can read the ' +
      'same feeds via poly_feed_read({ uri }) — same URIs, same { events, status, lastEventAt } shape, no ' +
      'resources/subscribe required.',
  }
);

// ---- Tools -----------------------------------------------------------------
// Method/parameter reference: https://github.com/Polymarket/ts-sdk (also live at polymarket://docs/llms)

server.registerTool(
  'poly_methods',
  {
    title: 'List Polymarket methods',
    description: 'List/filter callable Polymarket SDK methods (see github.com/Polymarket/ts-sdk for full reference)',
    inputSchema: {
      category: z.enum(CATEGORIES).optional().describe('Restrict to one method category.'),
      query: z.string().optional().describe('Substring match on method name (case-insensitive).'),
      limit: z.number().int().min(1).max(500).default(100).describe('Max methods returned. Raise it or narrow category/query to see more.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ category, query, limit }) => {
    const client = await getActiveClient();
    const allNames = listMethodNames(client);
    let names = allNames;
    if (category) names = names.filter((n) => categoryFor(n) === category);
    if (query) names = names.filter((n) => n.toLowerCase().includes(query.toLowerCase()));
    const authenticated = hasCredentials();
    const totalMatched = names.length;
    // Computed over the full matched set (before slicing to limit), so an agent
    // that never raises limit/narrows still sees the true shape of what's
    // available — not just a hint that more exists.
    const categoryCounts: Record<string, number> = {};
    for (const n of names) {
      const cat = categoryFor(n);
      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    }
    const out = names.slice(0, limit).map((name) => ({
      method: name,
      category: categoryFor(name),
      fundMoving: isFundMoving(name),
    }));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            authenticated,
            count: out.length,
            totalMatched,
            totalAvailable: allNames.length,
            categoryCounts,
            ...(totalMatched > out.length
              ? { truncated: `Showing ${out.length} of ${totalMatched}. categoryCounts covers the full matched set; narrow category/query or raise limit to see individual methods.` }
              : {}),
            ...(!authenticated
              ? { note: 'Order-placement, cancel, approval, transfer, and other fund-moving methods require a signing key — set PRIVATE_KEY to authenticate and reveal them.' }
              : {}),
            methods: out,
          }),
        },
      ],
    };
  }
);

server.registerTool(
  'poly_read',
  {
    title: 'Read Polymarket data',
    description:
      'Call a read-only Polymarket SDK method by name (markets, prices, orderbooks, account/reward data). ' +
      'Never places orders or moves funds — use poly_write for that. Reference: github.com/Polymarket/ts-sdk',
    inputSchema: {
      method: z.string().describe('exact read-only method name from poly_methods'),
      params: z
        .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
        .optional()
        .describe('request object for this method — or an array for the SDK batch methods (fetchPrices, fetchMidpoints, fetchOrderBooks, ...)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ method, params }) => {
    try {
      const client = await getActiveClient();
      // Existence check BEFORE the fund-moving classification: isFundMoving()
      // is "not on the public client and not a known safe read", which is
      // also true of names that don't exist at all — so a typo'd method used
      // to get back "moves funds/state — call it via poly_write", sending the
      // agent to a tool that would fail it differently (verified live
      // 2026-07-30 with a nonsense method name).
      if (typeof (client as any)[method] !== 'function') {
        const text = hasCredentials()
          ? `Unknown method "${method}" — call poly_methods to list what's available.`
          : `"${method}" is not available on the public (unauthenticated) client — either it requires PRIVATE_KEY ` +
            '(fund-moving methods only appear once authenticated, and go through poly_write) or it does not exist. ' +
            'Call poly_methods to list what is callable right now.';
        return { isError: true, content: [{ type: 'text', text }] };
      }
      if (isFundMoving(method)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `"${method}" moves funds/state — call it via poly_write, not poly_read.` }],
        };
      }
      const result = await callMethod(client, method, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err: any) {
      const rateLimit = describeRateLimit(err);
      if (rateLimit) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ...rateLimit, message: err.message }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] };
    }
  }
);

server.registerTool(
  'poly_write',
  {
    title: 'Execute a Polymarket action',
    description:
      'Call a fund-moving Polymarket SDK method by name (place/cancel orders, transfers, approvals, ' +
      'split/merge/redeem positions, perps deposit/withdraw). Requires PRIVATE_KEY — absent that, fund-moving ' +
      'methods do not exist on the client at all. Reference: github.com/Polymarket/ts-sdk',
    inputSchema: {
      method: z.string().describe('exact fund-moving method name from poly_methods'),
      params: z
        .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
        .optional()
        .describe('request object for this method — or an array for the SDK batch methods (fetchPrices, fetchMidpoints, fetchOrderBooks, ...)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ method, params }) => {
    if (!isFundMoving(method)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `"${method}" is read-only — call it via poly_read, not poly_write.` }],
      };
    }
    // Without credentials every fund-moving name passes isFundMoving (they're
    // all "not on the public client"), including typos, and the SDK call
    // below would fail with something opaque either way. Say plainly that
    // there's no signing key at all rather than trying to distinguish typos
    // from real methods with no way to check.
    if (!hasCredentials()) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              'No signing key configured — the authenticated client is unavailable, so no fund-moving method can run ' +
              '(and unknown method names cannot be distinguished from real ones). Set PRIVATE_KEY and restart to enable poly_write.',
          },
        ],
      };
    }
    try {
      const client = await getActiveClient();
      if (typeof (client as any)[method] !== 'function') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown method "${method}" — call poly_methods to list what's available.` }],
        };
      }
      const result = await callMethod(client, method, params);

      if (!isOrderMethod(method)) {
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      // A position just opened/changed — make sure it's actually being watched
      // rather than relying on the agent to remember to ask. This primes both
      // feeds now (so their event buffers are warm) and tells the agent the
      // exact resource URIs to call resources/subscribe on to get pushed
      // updates (fills, cancels, resolution) until the position is closed.
      // Nested (not spread onto result): result's own shape is untouched no
      // matter what type it is (object, array, or primitive) — spreading it
      // would silently mangle an array or drop a primitive result.
      const uris: string[] = ['polymarket://user/activity'];
      if (typeof (params as any)?.tokenId === 'string') {
        uris.push(`polymarket://market/${(params as any).tokenId}/book`);
      }
      await Promise.all(uris.map((uri) => ensureAndRead(uri, () => notifyResourceUpdated(uri)).catch(() => {})));

      return {
        content: [{ type: 'text', text: JSON.stringify({ result, subscribeToTrackThisPosition: uris }) }],
      };
    } catch (err: any) {
      const rateLimit = describeRateLimit(err);
      if (rateLimit) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ...rateLimit, message: err.message }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] };
    }
  }
);

server.registerTool(
  'poly_feed_read',
  {
    title: 'Read a live Polymarket feed',
    description:
      'Read the current snapshot of a live-feed URI for hosts without MCP resource support — same feeds as the ' +
      'polymarket:// MCP resources, no resources/subscribe required: polymarket://market/{tokenId}/book, ' +
      'polymarket://user/activity (requires PRIVATE_KEY), polymarket://sports/events, ' +
      'polymarket://comments/{parentEntityType}/{parentEntityId}, polymarket://prices/crypto/binance/{symbol}, ' +
      'polymarket://prices/crypto/chainlink/{symbol}, polymarket://prices/equity/{symbol}, ' +
      'polymarket://perps/{instrumentId}/trades|bbo|book|statistics, polymarket://perps/{instrumentId}/candles/{interval}, ' +
      'polymarket://perps/tickers. Returns { events, status, lastEventAt } — call again for a fresh snapshot, this ' +
      "does not push updates (hosts with resource support should use resources/subscribe for that instead).",
    inputSchema: {
      uri: z.string().describe('exact polymarket:// live-feed URI, e.g. polymarket://market/{tokenId}/book'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ uri }) => {
    if (!isLiveFeedUri(uri)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `"${uri}" is not a recognized live-feed URI. Valid patterns: ` +
              FEED_DEFS.map((def) => def.pattern).join(', '),
          },
        ],
      };
    }
    try {
      const snapshot = await ensureAndRead(uri, () => notifyResourceUpdated(uri));
      return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] };
    }
  }
);

server.registerTool(
  'refresh_polymarket_guide',
  {
    title: 'Refresh Polymarket guide',
    description: 'Force refetch the live Polymarket agent guide (docs.polymarket.com/llms.txt)',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    const { text } = await refreshGuide();
    return { content: [{ type: 'text', text: `Refreshed (${text.length} chars).` }] };
  }
);

// ---- Resources ---------------------------------------------------------------

const subscribedUris = new Set<string>();

server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  subscribedUris.add(req.params.uri);
  return {};
});
server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  subscribedUris.delete(req.params.uri);
  return {};
});

function notifyResourceUpdated(uri: string): void {
  if (!subscribedUris.has(uri)) return;
  server.server.notification({ method: 'notifications/resources/updated', params: { uri } }).catch(() => {});
}

server.registerResource(
  'polymarket-docs',
  'polymarket://docs/llms',
  {
    // Honest framing on purpose: this is docs.polymarket.com's own sitemap
    // (a list of links), not inlined guidance — an escape hatch for the
    // long tail, not "the agent guide". No hand-maintained docs resource
    // exists in this server: the live client (poly_methods) and this
    // server's own error messages are the source of truth for what's
    // callable and how to use it; a second, hand-curated documentation
    // product would just be one more thing to keep in sync and let go stale.
    description: 'Live Polymarket doc sitemap (docs.polymarket.com/llms.txt, 5-min cache) — a link index to fetch further, not inlined content.',
    mimeType: 'text/plain',
  },
  async (uri) => {
    const { text, cachedAgeMs } = await getGuide();
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: `${text}\n\n[cached ${Math.round(cachedAgeMs / 1000)}s ago]` }] };
  }
);

// Full WebSocket topic coverage (market, user, sports, comments, crypto/equity
// prices, all perps streams) — one resource template per FEED_DEFS row, all
// backed by the same generic live-feeds.ts subscription manager.
for (const def of FEED_DEFS) {
  server.registerResource(
    def.name,
    new ResourceTemplate(def.pattern, { list: undefined }),
    {
      description: `Live WebSocket feed (push updates via resources/subscribe): ${def.pattern}${def.auth ? ' — requires PRIVATE_KEY' : ''}`,
      mimeType: 'application/json',
    },
    async (uri) => {
      // events are already trimmed per-push in live-feeds.ts; status/lastEventAt
      // let an agent tell frozen data from genuinely fresh data (see live-feeds.ts).
      const snapshot = await ensureAndRead(uri.href, () => notifyResourceUpdated(uri.href));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshot) }] };
    }
  );
}

// ---- Startup -------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    hasCredentials() ? 'alpha-agent-mcp ready (authenticated — trading enabled)' : 'alpha-agent-mcp ready (read-only — no PRIVATE_KEY set)'
  );
  if (hasCredentials()) {
    // Prime the position/fill feed at startup rather than waiting for an
    // agent to think to subscribe — so anything that happens between server
    // start and the agent's first resources/subscribe call is still buffered,
    // not missed. Best-effort: a startup network hiccup here shouldn't crash
    // the server; live-feeds.ts's own reconnect loop keeps retrying it.
    ensureAndRead('polymarket://user/activity', () => notifyResourceUpdated('polymarket://user/activity')).catch((err) =>
      console.error('warning: could not prime polymarket://user/activity at startup —', err?.message || err)
    );
  }
}

process.on('SIGINT', async () => {
  await closeAllFeeds();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await closeAllFeeds();
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
