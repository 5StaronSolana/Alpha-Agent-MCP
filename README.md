# Alpha-MCP-TS

A production-grade MCP server that gives AI agents a clean, structured gateway into Polymarket — removing all friction between an LLM and live prediction market operations.

---

## What this is

An agent (Hermes, Nyx, OpenClaw, or any LLM harness) connects to this server and gets back **display-ready formatted cards** instead of raw SDK data. No parsing. No formatting logic in the agent. No boilerplate. The agent calls a tool and prints the response directly.

The MCP layer absorbs all Polymarket complexity — auth, signature type resolution, address mapping, pagination, CLOB v2 quirks — so agents stay focused on strategy rather than integration plumbing.

---

## Full lifecycle coverage

| Phase | Tools |
|-------|-------|
| **Discovery** | `discover_topic`, `list_events`, `list_markets`, `search`, `fetch_market`, `list_tags`, `fetch_tag`, `fetch_market_tags`, `list_series`, `list_sports` |
| **Pricing** | `get_order_book`, `get_midpoint`, `get_spread`, `get_farmability`, `fetch_price`, `list_open_interest`, `fetch_event_live_volume` |
| **Order execution** | `place_limit_order`, `place_market_order`, `place_optimized_reward_order`, `post_orders` (batch), `cancel_order`, `cancel_all_orders`, `cancel_market_orders` |
| **Order management** | `list_open_orders`, `fetch_order`, `get_order_history`, `watch_order_until_filled`, `order_scoring`, `batch_order_scoring` |
| **CTF on-chain** | `split_position`, `merge_positions`, `redeem_positions`, `enable_auto_redeem`, `resolve_condition_by_token` + `prepare_*` variants |
| **Account state** | `list_positions`, `list_closed_positions`, `get_balance_allowance`, `get_portfolio_value`, `list_activity`, `get_user_earnings`, `list_account_trades` |
| **Rewards** | `list_current_rewards`, `list_market_rewards`, `get_market_reward_details`, `suggest_qualified_size`, `list_user_earnings_and_markets_config` |
| **Live data (WebSocket)** | `subscribe_market`, `subscribe_user`, `subscribe_sports`, `subscribe_prices_crypto`, `subscribe_wallet_activity` via MCP Resources |
| **Auth / setup** | `create_secure_client`, `setup_trading_approvals`, `setup_gasless_wallet`, `create_api_key`, `create_builder_api_key`, builder header signing |
| **Analytics** | `get_trader_leaderboard`, `get_builder_leaderboard`, `list_market_holders`, `fetch_builder_volume`, `fetch_builder_fee_rates` |
| **RFQ** (quoter/market-maker side only — see caveat below) | `open_rfq_session`, `list_pending_rfq_quote_requests`, `respond_to_rfq_quote_request`, `cancel_rfq_quote`, `close_rfq_session` |
| **Perps trading** (`@experimental` per Polymarket — see caveat below) | `open_perps_session`, `place_perps_order`, `post_perps_orders`, `place_perps_position_tp_sl`, `cancel_perps_order(s)`, `cancel_all_perps_orders`, `update_perps_leverage`, `fetch_perps_balances`/`portfolio`/`account_stats`/`account_config`/`open_orders`/`orders`, `list_perps_fills`/`funding_payments`/`deposits`/`withdrawals`/`equity_history`/`pnl_history`, `deposit_to_perps`, `withdraw_from_perps`, `revoke_perps_credentials`, plus public `fetch_perps_book`/`fees`/`instruments`/`ticker(s)` and `list_perps_candles`/`funding_history`/`trades` |

180+ tools through a single stdio MCP server. Every tool is a 1:1 wrapper of `@polymarket/client` — no custom HTTP, no undocumented endpoints.

**Two honesty caveats, not marketing:**
- **Perps is entirely `@experimental`** in Polymarket's own SDK — every Perps method's doc comment says it "may change in a breaking way in any release, including patch releases." This coverage may need to change on any SDK bump, not just major ones. Placing a Perps order also opens leveraged exposure — same guardrails gate as spot orders applies (see Safety below), but the leverage risk itself is yours to manage.
- **RFQ here is quoter (market-maker) side only.** `openRfqSession()` streams incoming `quote_request` events from takers and lets you respond with a price — there is currently no client-side "request a quote as a taker" function in this SDK version. If you want an agent that *requests* quotes rather than *answers* them, this SDK doesn't expose that yet. Check https://docs.polymarket.com/changelog/sdks#typescript — the SDK ships changes weekly.

---

## Formatted output — what agents receive

Every response is a pre-formatted card. Low token count (~130 tokens per market card vs 800+ for raw JSON). Agent prints directly.

```
📊 Will Bitcoin exceed $150k before 2027?
YES  0.34  |  NO  0.66
Volume: $2,841,203   Liquidity: $98,432   Ends: 31 Dec 2026
Guidance: High liquidity. Spread tight. Eligible for maker rewards.
Next Step: get_order_book({tokenId: "0x..."}) for depth, then place_limit_order.
```

No parsing. No field extraction. No formatting logic upstream.

---

## Setup

One command, no manual build step — point your agent host's MCP config directly at this:

```bash
npx -y -p github:5StaronSolana/Alpha-Agent-MCP alpha-agent-mcp
```

(`-p ... alpha-agent-mcp` names the bin explicitly — this package also ships
a second, unrelated CLI (`polymarket-client`), so a bare `npx github:...`
can't guess which one you want.)

`npx` clones, installs, and builds automatically (via the `prepare` script) on
first run, then starts the stdio server. For an `mcpServers`-style host config:

```json
{
  "mcpServers": {
    "alpha-agent-mcp": {
      "command": "npx",
      "args": ["-y", "-p", "github:5StaronSolana/Alpha-Agent-MCP", "alpha-agent-mcp"]
    }
  }
}
```

Prefer a local clone (e.g. to read or modify the code)? Same result, one more step:

```bash
git clone https://github.com/5StaronSolana/Alpha-Agent-MCP.git
cd Alpha-Agent-MCP
npm install              # builds automatically via the prepare script
node dist/mcp.js          # stdio MCP server — plug into any agent harness
```

Required env vars:
```
EOA_PRIVATE_KEY=0x...               # signing key
DEPOSIT_WALLET_ADDRESS=0x...        # funder / proxy wallet (optional)
CLOB_API_KEY / CLOB_SECRET / CLOB_PASS_PHRASE   # CLOB L2 credentials
```

Health check: `npm run doctor`

---

## Safety — every fund-moving action is blocked until you opt in

**By default, nothing that moves or approves access to your funds will execute.** Until you explicitly configure guardrails, every order tool (`place_limit_order`, `place_market_order`, `place_optimized_reward_order`, `place_perps_order`, ...), every on-chain action (split/merge/redeem positions, approvals, `transfer_erc20`, `send_transaction`, Perps deposit/withdraw, combo/market split-merge), and the Perps/RFQ actions that place orders or commit to a trade (`post_perps_orders`, `update_perps_leverage`, `respond_to_rfq_quote_request`, ...) are rejected with a `readOnly` block. This is deliberate: this server is designed to be pointed at a live, funded wallet and connected to an autonomous agent (OpenClaw, Hermes, or any MCP host), so it should never move funds or place a real order before its owner has decided what that agent is allowed to do.

To allow trading, call `update_strategy`:

```json
update_strategy({ "tokenId": "guardrails:global", "readOnly": false })
```

You can (and should) cap what the agent can do at the same time:

```json
update_strategy({
  "tokenId": "guardrails:global",
  "readOnly": false,
  "maxOrderSizeUsd": 50,
  "maxPriceDeviationFromMid": 0.05,
  "maxOpenOrdersTotal": 10
})
```

Fields: `readOnly`, `maxOrderSizeUsd` (hard cap on notional per order), `maxPriceDeviationFromMid` (reject orders far from mid), `allowedTokenIds` (allowlist), `maxOpenOrdersTotal`, `allowedTransferAddresses` (allowlist for `transfer_erc20` recipients — a raw transfer has no exchange counterparty or price bound, so it gets its own stricter check). Unset fields impose no restriction on that dimension once you've configured the key at all. See `src/mcp/guardrails.ts`.

---

## How agents use it

Standard MCP protocol — nothing proprietary:

1. `tools/list` → get the full flat surface (all 90+ tools returned immediately, no tiers)
2. `tools/call` with exact tool name + args → get formatted card back
3. Print the card. Done.

Discovery → `list_events(tagSlug)` or `discover_topic(topic)` for categories  
Pricing → `get_order_book` + `get_farmability` for depth + reward eligibility  
Execution → `place_limit_order` with concrete `price` / `size` / `side` from strategy  
Live → subscribe via MCP Resources for push updates (`polymarket://market/{tokenId}/book`)

---

## Key design principles

**No intent trading.** Every order tool takes explicit `price`, `size`, `side`. The agent computes these from strategy — the MCP never infers intent.

**Flat surface.** `tools/list` returns everything immediately. No progressive disclosure, no gating, no "load profile first".

**Pagination on all list tools.** Default `limit=10`, max `100`. Every response includes `items`, `limit`, `offset`, `nextCursor`.

**Auth absorbed.** Signature type, proxy wallet address resolution, CLOB credential injection — all handled server-side. Agent never touches auth.

---

## Agent contract

See [AGENTS.md](AGENTS.md) for the full "never guess" contract, mandatory startup sequence, discovery best practices, and continuous improvement ritual.

Quick ref for agents:
```
prompts/get mcp_llms_full_guide     ← full SDK + MCP mapping (load at startup)
prompts/get agent_routing           ← intent → tool routing plan
prompts/get mcp_tool_structure_and_categories
```

---

## Builder attribution

Every order this server places carries a builder code via Polymarket's
official builder-attribution mechanism (`builderCode` on order requests,
see `client.listBuilderTrades` / `listBuilderLeaderboard` in
`@polymarket/client`) — trading volume routed through this tool is credited
to its builder.

This is wired in once, centrally, at the `SecureClient` factory
(`src/config/client.ts` + `src/config/builder-code.ts`), so it applies to
every order path regardless of which tool or code path places the order,
and cannot be overridden via tool arguments. The server verifies the
integrity of this wiring at startup and refuses to start if it has been
tampered with — see [LICENSE](LICENSE) for the terms this is granted under.
