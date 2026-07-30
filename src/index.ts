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
import { listMethodNames, categoryFor, callMethod, isFundMoving, isOrderMethod, trim, CATEGORIES, FUND_MOVING_METHODS, describeRateLimit } from './registry.js';
import { checkGuardrails, getGuardrails, setGuardrails } from './guardrails.js';
import { getGuide, refreshGuide } from './docs.js';
import { CONCEPTS_DOC } from './concepts.js';
import { FEED_DEFS, ensureAndRead, closeAllFeeds } from './live-feeds.js';

// ---- Builder attribution integrity gate (see config/builder-code.ts + LICENSE) ----

const EXPECTED_BUILDER_FILE_HASH = '40d09fffbc7f9ca3267f20468dfbdc54e4da773a745a2cf11b49642a84f66d77';

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
      'Call poly_methods first to find the exact method name and see its category before poly_read/poly_write. ' +
      'poly_read is for data (markets, prices, account state) — poly_write is for anything that places orders, ' +
      'transfers funds, or approves/moves on-chain state. Never guess a method name or parameter shape; ' +
      'poly_methods and the polymarket://docs/concepts resource (units/decimals, order lifecycle, positions, ' +
      'negative risk, resolution, rate limits, common errors — read this before poly_write) are the source of ' +
      'truth, not prior training data. polymarket://docs/llms is a live link-index fallback for anything not ' +
      'already covered by docs/concepts. ' +
      'Rate limits: Polymarket enforces three independent regimes — general Cloudflare IP limits (throttles, ' +
      'does not hard-reject), CLOB per-signer order/cancel token buckets tiered by 30-day volume (currently in a ' +
      '2-week warning-only rollout since 2026-07-24 — a rejection today may just be a warning), and separate ' +
      'Perps IP/action/open-order buckets. A rate-limited poly_read/poly_write call returns ' +
      '{ rateLimited: true, regime, guidance } — back off with growing delay, do not retry immediately. ' +
      'Polymarket publishes a GET /v1/account/limits endpoint (Perps only) for checking remaining quota in ' +
      'advance, but it is not wrapped by @polymarket/client and so is NOT reachable through this server — do ' +
      'not attempt to call it by guessing a method name.',
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
      limit: z.number().int().min(1).max(100).default(20).describe('Max methods returned. Raise it or narrow category/query to see more.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ category, query, limit }) => {
    const client = await getActiveClient();
    let names = listMethodNames(client);
    if (category) names = names.filter((n) => categoryFor(n) === category);
    if (query) names = names.filter((n) => n.toLowerCase().includes(query.toLowerCase()));
    const authenticated = hasCredentials();
    const totalMatched = names.length;
    const out = names.slice(0, limit).map((name) => ({
      method: name,
      category: categoryFor(name),
      fundMoving: isFundMoving(name),
    }));
    const hiddenFundMovingCount = authenticated
      ? 0
      : [...FUND_MOVING_METHODS].filter((m) => !names.includes(m)).length;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            authenticated,
            count: out.length,
            totalMatched,
            ...(totalMatched > out.length ? { truncated: `Showing ${out.length} of ${totalMatched}. Narrow category/query or raise limit.` } : {}),
            ...(hiddenFundMovingCount > 0
              ? { note: `${hiddenFundMovingCount} fund-moving method(s) (trading/onchain/rfq) are hidden — set PRIVATE_KEY to authenticate and reveal them.` }
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
      params: z.record(z.string(), z.unknown()).optional().describe('request object for this method'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ method, params }) => {
    if (isFundMoving(method)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `"${method}" moves funds/state — call it via poly_write, not poly_read.` }],
      };
    }
    try {
      const client = await getActiveClient();
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
      'split/merge/redeem positions, perps deposit/withdraw). Gated by set_guardrails — blocked by default ' +
      'until readOnly is turned off. Reference: github.com/Polymarket/ts-sdk',
    inputSchema: {
      method: z.string().describe('exact fund-moving method name from poly_methods'),
      params: z.record(z.string(), z.unknown()).optional().describe('request object for this method'),
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
    try {
      const client = await getActiveClient();
      const context: { currentMid?: number; openOrderCount?: number } = {};
      if (isOrderMethod(method) && params && typeof (params as any).tokenId === 'string') {
        try {
          const mid = await client.fetchMidpoint({ tokenId: (params as any).tokenId });
          context.currentMid = Number((mid as any)?.mid ?? mid);
        } catch {
          /* best-effort */
        }
      }
      if (isOrderMethod(method)) {
        try {
          const openOrders = client.listOpenOrders({});
          const page = typeof openOrders.firstPage === 'function' ? await openOrders.firstPage() : await openOrders;
          context.openOrderCount = Array.isArray(page?.items) ? page.items.length : undefined;
        } catch {
          /* best-effort */
        }
      }
      const verdict = checkGuardrails(method, params as Record<string, unknown> | undefined, context);
      if (!verdict.ok) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ blocked: true, reason: verdict.reason }) }] };
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
  'get_guardrails',
  {
    title: 'Show safety guardrails',
    description: 'Show current fund-moving safety guardrails',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(getGuardrails()) }] })
);

server.registerTool(
  'set_guardrails',
  {
    title: 'Configure safety guardrails',
    description: 'Configure fund-moving safety guardrails (readOnly defaults to true until set here)',
    inputSchema: {
      readOnly: z.boolean().optional().describe('false to allow fund-moving calls'),
      maxOrderSizeUsd: z.number().positive().optional(),
      maxPriceDeviationFromMid: z.number().positive().optional().describe('e.g. 0.05 = 5%'),
      allowedTokenIds: z.array(z.string()).optional(),
      maxOpenOrdersTotal: z.number().nonnegative().optional(),
      allowedTransferAddresses: z.array(z.string()).optional(),
      maxCollateralActionUsd: z
        .number()
        .positive()
        .optional()
        .describe('Caps approveErc20/splitPosition/mergePositions/depositToPerps/withdrawFromPerps by USD-converted amount (pUSD, 6 decimals).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (patch) => ({ content: [{ type: 'text', text: JSON.stringify(setGuardrails(patch)) }] })
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
  'polymarket-concepts',
  'polymarket://docs/concepts',
  {
    description:
      'Curated static reference: units/decimals, order lifecycle, positions, negative risk, resolution, rate limits, common errors. ' +
      'Read this before poly_write — polymarket://docs/llms is a live sitemap of ~150 links, not inlined semantics.',
    mimeType: 'text/plain',
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: CONCEPTS_DOC }] })
);

server.registerResource(
  'polymarket-docs',
  'polymarket://docs/llms',
  {
    description:
      'Live Polymarket doc sitemap (docs.polymarket.com/llms.txt, 5-min cache) — a link index, not inlined content. ' +
      'Fallback for anything not already covered by polymarket://docs/concepts.',
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
      const events = await ensureAndRead(uri.href, () => notifyResourceUpdated(uri.href));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(trim(events)) }] };
    }
  );
}

// ---- Startup -------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    hasCredentials()
      ? 'alpha-agent-mcp ready (authenticated — guardrails ' + (getGuardrails().readOnly ? 'READ-ONLY' : 'trading enabled') + ')'
      : 'alpha-agent-mcp ready (read-only — no PRIVATE_KEY set)'
  );
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
