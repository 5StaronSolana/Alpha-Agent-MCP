# alpha-agent-mcp

Lightweight MCP server exposing the full [`@polymarket/client`](https://github.com/Polymarket/ts-sdk)
SDK to any stdio-capable agent host — Claude Code, Claude Desktop, OpenClaw,
Grok Build, Hermes, or a custom agent loop. No custom REST calls, no
per-method hand-written tools: every SDK method is reachable generically.

## Setup

```bash
git clone https://github.com/5StaronSolana/Alpha-Agent-MCP.git
cd Alpha-Agent-MCP
npm install       # builds automatically via the prepare script
node dist/index.js  # stdio MCP server
```

Point your host's `mcpServers` config at it:

```json
{
  "mcpServers": {
    "polymarket": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/Alpha-Agent-MCP",
      "env": {
        "PRIVATE_KEY": "0x...",
        "WALLET_ADDRESS": "0x..."
      }
    }
  }
}
```

Both env vars are optional — omit them entirely to run read-only/discovery
tools with zero config. Trading and account tools need `PRIVATE_KEY` (and
`WALLET_ADDRESS`, derived from the key if omitted).

## Tools

| Tool | Purpose |
|------|---------|
| `poly_methods({ category?, query? })` | List/filter every callable SDK method (markets, trading, account, rewards, perps, rfq, onchain, realtime) |
| `poly_read({ method, params? })` | Call any read-only SDK method by name |
| `poly_write({ method, params? })` | Call any fund-moving SDK method by name (guardrail-gated) |
| `get_guardrails()` | Show current fund-moving safety config |
| `set_guardrails({ ... })` | Configure fund-moving safety config |
| `refresh_polymarket_guide()` | Force an immediate refetch of the live agent guide |

No per-method tool schemas to maintain — `poly_methods` is the discovery
step, `poly_read`/`poly_write` are the dispatch step. New SDK methods are
covered automatically on the next SDK bump. Read and write are separate
tools (not one tool doing both) so hosts can annotate/auto-approve them
differently — `poly_read` is `readOnlyHint: true`, `poly_write` is
`destructiveHint: true`.

## Safety — fund-moving calls are blocked until you opt in

By default, **every fund-moving method is rejected** (`readOnly`): order
placement, approvals, transfers, split/merge/redeem positions, perps
deposit/withdraw, and session-opening RFQ/Perps actions. Read-only methods
(discovery, prices, order books, account viewing) always work.

```json
set_guardrails({ "readOnly": false, "maxOrderSizeUsd": 50, "maxPriceDeviationFromMid": 0.05 })
```

Fields: `readOnly`, `maxOrderSizeUsd`, `maxPriceDeviationFromMid`,
`allowedTokenIds`, `maxOpenOrdersTotal`, `allowedTransferAddresses`. Config
persists to `guardrails.json` next to the server, so it survives restarts.
See `src/guardrails.ts`.

## Live data

- `polymarket://docs/llms` — the live Polymarket agent guide
  (`docs.polymarket.com/llms.txt`), cached 5 minutes, refetched
  automatically after that (or immediately via `refresh_polymarket_guide`).
  Never a committed `.md` file.
- Full WebSocket topic coverage as MCP resources (`src/live-feeds.ts`), all
  pushed via `notifications/resources/updated` after `resources/subscribe` —
  no polling. One table row per topic (`FEED_DEFS`), not hand-written per
  resource:

  | Resource | SDK topic |
  |---|---|
  | `polymarket://market/{tokenId}/book` | `market` |
  | `polymarket://user/activity` (requires `PRIVATE_KEY`) | `user` |
  | `polymarket://sports/events` | `sports` |
  | `polymarket://comments/{parentEntityType}/{parentEntityId}` | `comments` |
  | `polymarket://prices/crypto/binance/{symbol}` | `prices.crypto.binance` |
  | `polymarket://prices/crypto/chainlink/{symbol}` | `prices.crypto.chainlink` |
  | `polymarket://prices/equity/{symbol}` | `prices.equity.pyth` |
  | `polymarket://perps/{instrumentId}/trades` | `perps.trades` |
  | `polymarket://perps/{instrumentId}/bbo` | `perps.bbo` |
  | `polymarket://perps/{instrumentId}/book` | `perps.book` |
  | `polymarket://perps/{instrumentId}/candles/{interval}` | `perps.candles` |
  | `polymarket://perps/tickers` | `perps.tickers` |
  | `polymarket://perps/{instrumentId}/statistics` | `perps.statistics` |

## Builder attribution

Every order this server places carries a builder code via Polymarket's
official builder-attribution mechanism (`builderCode` on order requests).
It's wired in once, centrally (`src/config/client.ts` +
`src/config/builder-code.ts`), applies regardless of which method places the
order, and cannot be overridden via tool arguments. The server verifies the
integrity of this wiring at startup and refuses to start if it's been
tampered with — see [LICENSE](LICENSE) for the terms this is granted under.

Independently verify it yourself against Polymarket's public API:

```bash
node -e "
import('@polymarket/client').then(async sdk => {
  const client = sdk.createPublicClient();
  const p = sdk.listBuilderTrades(client, { builderCode: '0xf2864b3cfa9b0752432588aeca0c8d8af45d3be852148ff5468dd28c9532a438' });
  console.log(await p.firstPage());
});
"
```

## Test

```bash
npm test
```

Spawns the real server over stdio, does the MCP handshake, checks
`tools/list`/`resources/list`, makes one live `poly_read` call, confirms
`poly_write` rejects a read-only method (proves the split is enforced), and
does one live `polymarket://docs/llms` read. Set `SMOKE_TEST_OFFLINE=1` to
skip the network calls (protocol-only check).
