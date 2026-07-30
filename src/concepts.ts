/**
 * Curated, static Polymarket agent reference — the semantics an agent
 * actually needs before calling poly_read/poly_write, inlined once here
 * instead of one hop away in docs.polymarket.com's ~150-link sitemap (see
 * docs.ts, which fetches that sitemap live as polymarket://docs/llms).
 *
 * Deliberately a curated stable subset, not a mirror of the sitemap: units/
 * decimals, order lifecycle, positions, negative risk, resolution, rate
 * limits, and the error codes an agent is actually likely to hit. Anything
 * not covered here is still one polymarket://docs/llms hop away — this file
 * is the fast path for the common case, not a replacement for the long
 * tail. Content is hand-curated from docs.polymarket.com as of 2026-07-30;
 * re-verify against the live docs (or the SDK's own .d.ts comments, which
 * are authoritative for request shapes) before trusting a number here that
 * looks stale.
 */
export const CONCEPTS_DOC = `# Polymarket Agent Reference (curated)

## Units & decimals — read this before calling poly_write

- **Order price/size are already human-readable.** \`price\` is USD per share
  in [0, 1] (e.g. 0.60 = 60 cents = 60% implied probability). \`size\` is
  outcome-token count — confirmed by the SDK's own type comment on
  PrepareLimitOrderRequest.size: "This is the human-readable token amount:
  1 means one full share, not one 6-decimal base unit." So
  \`price * size\` is already correct USD notional. Do NOT apply any
  decimals conversion to order price/size.
- **Collateral-amount methods are the opposite: raw base units.**
  \`approveErc20\`, \`splitPosition\`, \`mergePositions\`, \`depositToPerps\`,
  \`withdrawFromPerps\` all take \`amount: bigint\` in pUSD base units, not
  dollars. pUSD is fixed at **6 decimals** (docs.polymarket.com/concepts/
  pusd, and the same 10**6 factor is hardcoded in @polymarket/client's own
  compiled source) — so \`amount\` in dollars = \`amount / 1_000_000\`.
  \`approveErc20\`/\`mergePositions\` also accept the literal string \`"max"\`
  (uint256 max / "as much as needed") instead of a bigint.
- \`redeemPositions\` takes no amount at all — it redeems your *entire*
  winning balance for a condition, not a partial amount.
- This server's own \`maxCollateralActionUsd\` guardrail (see
  set_guardrails) enforces exactly this conversion — set it before turning
  off readOnly if you want a real dollar cap on these five methods.

## Prices, orderbook, order types

- Every share prices between $0.00 and $1.00; price *is* the market's
  implied probability. Displayed price is the bid/ask midpoint, or the last
  trade price if the spread exceeds $0.10.
- All Polymarket orders are technically **limit orders**. A "market order"
  is a limit order priced to execute immediately against the book.
- Order types: **GTC** (rests until filled/cancelled), **GTD** (expires at
  a given timestamp — must be ≥3 minutes in the future), **FOK** (fill
  entirely or cancel — rejected outright if it can't fully fill), **FAK**
  (fill what's available, cancel the rest — needs at least one match or
  it's rejected). **Post-only** orders are rejected instead of filled if
  they'd cross the spread (guarantees maker-only).
- Orders are EIP712-signed; settlement is atomic on Polygon via the
  Exchange contract. Some markets (selected crypto/finance and sports) hold
  marketable orders in a brief delay window (crypto: 250ms taker delay,
  check a market's \`itode\` flag; sports: configurable) before matching —
  the order can't be cancelled mid-delay.
- Order statuses: \`live\` (resting), \`matched\`, \`delayed\` (in a delay
  window), \`unmatched\` (placed on book after delay expired unmatched).
  Trade statuses: \`MATCHED\` → \`MINED\` → \`CONFIRMED\` (terminal success) or
  \`RETRYING\`/\`FAILED\` (terminal failure).
- Partial fills can't be cancelled — only the unfilled remainder can.
- Sports markets auto-cancel all resting orders when the game starts
  (clock-based, so a game starting early may not clear in time — don't
  assume orders are safe right up to kickoff).

## Positions & tokens

- Every market has exactly two ERC1155 outcome tokens (Yes/No), always
  fully backed 1:1 by pUSD in the CTF contract.
- **Split**: pUSD → equal Yes + No tokens (\`$100 → 100 Yes + 100 No\`).
  **Merge**: equal Yes + No → pUSD (\`100 Yes + 100 No → $100\`). **Redeem**
  (post-resolution only): winning tokens → pUSD 1:1; losing tokens become
  worthless.
- Position value = token balance × current price. Eligible markets pay a
  variable ~4% annualized Holding Reward on position value, sampled hourly,
  paid daily.

## Negative risk (multi-outcome events)

- In a neg-risk event, a No share in any one outcome market can be
  converted (via the Neg Risk Adapter contract) into 1 Yes share in every
  *other* outcome market in the event — capital-efficient betting against
  one outcome ≈ betting for all the others.
- **Augmented neg risk** (outcome set not fully known at launch, e.g. an
  election with candidates still entering): has named outcomes, reserved
  "placeholder" outcomes, and a catch-all "Other". Only trade named
  outcomes — placeholders aren't shown in the UI and their meaning can
  still change. If the real winner was never named, the market resolves to
  "Other".

## Resolution

- Polymarket uses UMA's Optimistic Oracle. Anyone can propose an outcome
  (posting a ~$750 pUSD bond); a 2-hour challenge period follows. Undisputed
  → resolves in ~2 hours. One dispute → second proposal round. Two disputes
  → escalates to a ~48-hour UMA token-holder vote (total 4-6 days).
  Unknown/50-50 outcomes resolve every token at $0.50.
- Read a market's resolution *rules*, not just its title, before trading —
  the rules define edge cases and are the actual resolution source.
- Trading stops the moment a market resolves; winning tokens become
  redeemable for exactly $1.00, losing tokens worth $0.00.

## Rate limits — three independent regimes

1. **General Cloudflare IP limits** (all REST APIs — Gamma, Data, CLOB,
   Bridge). These *throttle/queue*, not hard-reject, on a sliding window.
   Trading endpoints specifically: \`POST/DELETE /order\` ~5,000 req/10s
   burst, 120,000/10min sustained; batch variants lower. See
   docs.polymarket.com/api-reference/rate-limits for the full per-endpoint
   table.
2. **CLOB per-signer order/cancel token buckets**
   (docs.polymarket.com/api-reference/trading-rate-limits) — separate
   buckets per signer address, tiered by 30-day trading volume (Standard:
   40 order-tokens/s, 60 burst; scales up to Elite at $10M+ volume: 600/s,
   900 burst). Order/cancel actions each cost tokens per the linked table.
   **Currently in a 2-week warning-only rollout starting 2026-07-24** — a
   429 during this window may just carry \`Poly-RateLimit-Warning: true\`
   rather than being a real rejection; check that header before treating it
   as a hard block.
3. **Perps-specific buckets** (docs.polymarket.com/api-reference/perps/
   rate-limits) — separate IP bucket (1,000 weighted tokens/min), account
   action bucket (5,000 tokens/min default tier, 1,000 open-order cap), and
   WebSocket message/subscription limits. 429 body's \`error\` field
   distinguishes \`ip_rate_limited\` / \`action_rate_limited\` /
   \`open_orders_limit\` — the last one is a capacity cap, not a rate limit,
   so waiting doesn't help; cancel resting orders instead.

A poly_read/poly_write call that hits any of these returns
\`{ rateLimited: true, regime, guidance }\` from this server (see
src/registry.ts's describeRateLimit) — **note the SDK itself discards the
real Retry-After/header/body detail before this server ever sees it** (its
HTTP layer throws a bare error with no header read on a 429), so
\`regime\`/\`guidance\` are best-effort inference from the request URL, not a
precise countdown. Back off with growing delay rather than expecting an
exact retry time.

Polymarket also publishes \`GET /v1/account/limits\` (Perps only) for
checking remaining quota in advance — **not wrapped by @polymarket/client**,
so it is NOT reachable through this server. Don't guess a method name for
it; it doesn't exist in poly_methods.

## Errors worth recognizing by message text

CLOB errors are \`{ "error": "<message>" }\`. The ones an agent placing real
orders is most likely to hit:

- \`not enough balance / allowance\` — insufficient pUSD or missing token
  approval. Check balance and run setupTradingApprovals (or approveErc20)
  first.
- \`order {id} is invalid. Price ({price}) breaks minimum tick size rule\`
  — price isn't aligned to the market's tick size; fetch the market's tick
  size first rather than guessing a precision.
- \`order {id} is invalid. Size ({size}) lower than the minimum\` — below
  the market's minimum order size.
- \`invalid post-only order: order crosses book\` — a postOnly order would
  have matched immediately; it was rejected instead of filled.
- \`order couldn't be fully filled. FOK orders are fully filled or killed.\`
  / \`no orders found to match with FAK order\` — liquidity wasn't
  sufficient for the order's fill-or-kill / fill-and-kill semantics.
- \`Trading is currently cancel-only\` (503) — new orders rejected, cancels
  still processed.
- \`post-only mode: only post-only orders and cancels are allowed\` (503) —
  system-wide post-only mode; response includes \`retry_after_seconds\` and
  the same value in the \`Retry-After\` header (this one *is* a real,
  numeric retry hint, unlike the generic RateLimitError case above).
- HTTP 425 from the matching engine — it's restarting; back off and retry.

Full reference: docs.polymarket.com/resources/error-codes.
`;
