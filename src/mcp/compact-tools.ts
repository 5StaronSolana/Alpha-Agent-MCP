import type { ToolDef } from './agent-meta.js';

const MAX_DESC = 180;

/** Short tool descriptions for pure SDK 1:1 tools in tools/list. */
export const COMPACT_TOOL_DESCRIPTIONS: Record<string, string> = {
  // Only direct Polymarket SDK wrappers (no meta)
  discover_topic: '[Discovery] Topic → events + markets + tokenIds.',
  fetch_market: '[Discovery] Market by id/slug/url/tokenId.',
  list_markets: '[Discovery] SDK listMarkets (tagId, titleSearch, clobTokenIds, rewardsMinSize, closed, pageSize, etc.).',
  list_events: '[Discovery] SDK listEvents (tagSlug, titleSearch, closed, pageSize).',
  fetch_event: '[Discovery] Fetch a single event by id or slug.',
  list_tags: '[Discovery / Gamma] List all Gamma tags.',
  fetch_tag: '[Discovery / Gamma] Fetch details for a specific Gamma tag by slug.',
  search: 'Official full-text search via client.search().',
  get_order_book: '[Trading] SDK getOrderBook(tokenId).',
  get_spread: '[Trading] SDK getSpread / fetchSpread.',
  get_midpoint: '[Trading] Direct SDK getMidpointPrice / fetchMidpoint.',
  fetch_market_tags: '[Discovery] Direct SDK fetchMarketTags.',
  list_comments: '[Discovery] Direct SDK listComments.',
  list_sports: '[Discovery] Sports metadata via SDK.',
  list_current_rewards: '[Rewards] Direct raw SDK listCurrentRewards() - all active reward programs.',
  list_market_rewards: '[Rewards] Direct raw SDK listMarketRewards(conditionId) - present and future rewards for a market.',
  list_reward_markets: '[Rewards] SDK-native bulk enumeration via listCurrentRewards (getMultipleMarketsWithRewards equivalent) with filters and pagination.',
  get_market_reward_details: '[Rewards] Direct raw SDK listMarketRewards / getRawRewards for a market.',
  order_scoring: '[Rewards] Direct SDK orderScoring.',
  batch_order_scoring: '[Rewards] Direct SDK batchOrderScoring.',
  list_simplified_markets: '[Discovery] Lightweight markets via listMarkets (accepting_orders, active, rewards, tokens projection).',
  list_sampling_markets: '[Rewards] Markets eligible for sampling/liquidity rewards (via listCurrentRewards / listMarkets projection).',
  list_sampling_simplified_markets: '[Rewards] Lightweight sampling markets.',
  place_limit_order: '[Trading] SDK placeLimitOrder (GTC/GTD via expiration, postOnly for maker/rewards).',
  place_market_order: '[Trading] SDK placeMarketOrder (FOK/FAK).',
  place_optimized_reward_order: '[Rewards] Suggest→validate→place maker reward order (postOnly GTC for scoring).',
  create_limit_order: '[Trading] Direct SDK createLimitOrder (sign only, no post).',
  create_market_order: '[Trading] Direct SDK createMarketOrder (sign only).',
  cancel_order: '[Trading] Direct SDK cancelOrder(orderId).',
  cancel_market_orders: '[Trading] Direct SDK cancelMarketOrders.',
  cancel_all_orders: '[Trading] Direct SDK cancelAllOrders.',
  list_open_orders: '[Trading] Direct SDK listOpenOrders.',
  fetch_order: '[Trading] Direct SDK fetchOrder(orderId).',
  get_order_history: '[Trading] Order history via SDK.',
  post_orders: '[Trading] Direct SDK postOrders (batch).',
  list_positions: '[Account] Direct SDK listPositions (with PnL).',
  get_balance_allowance: '[Account] Direct SDK fetchBalanceAllowance / getBalanceAllowance.',
  get_portfolio_value: '[Account] Direct SDK getPortfolioValue / fetchPortfolioValue.',
  list_activity: '[Account] Direct SDK listActivity (trades, rewards, on-chain).',
  list_trades: '[Account] Direct SDK listTrades (maker filter supported).',
  get_user_earnings: '[Rewards] Direct SDK getUserEarningsAndMarketsConfig (day optional).',
  get_farmability: '[Rewards] SDK book + listMarketRewards + mids (for reward eligibility).',
  suggest_qualified_size: '[Rewards] Advisory size calculation from SDK reward config (rewardsMinSize) + intent.',
  is_gasless_ready: '[Gasless] Direct SDK isWalletDeployed(client).',
  setup_gasless_wallet: '[Gasless] Direct SDK deployDepositWallet(client).',
  subscribe_market: '[WS] Ensure subscription to market topic (orderbooks, trades, prices) via SDK ClobMarketWebSocketManager. Surfaces as resource for push.',
  subscribe_sports: '[WS] Subscribe to sports topic (scores, periods) via SDK SportsWebSocketManager.',
  subscribe_user: '[WS] Subscribe to authenticated user topic (private updates) via SDK ClobUserWebSocketManager.',
  subscribe_prices_crypto: '[WS] Subscribe to real-time prices topic via SDK RtdsWebSocketManager.',
};

export function compactTool(tool: ToolDef): ToolDef {
  const short = COMPACT_TOOL_DESCRIPTIONS[tool.name];
  if (short) return { ...tool, description: short };

  const desc = tool.description || '';
  const prefix = desc.match(/^\[[^\]]+\]/)?.[0] || '';
  const body = desc.replace(/^\[[^\]]+\]\s*/, '').trim();
  const firstSentence = body.split(/(?<=[.!?])\s+/)[0] || body;
  let compact = prefix ? `${prefix} ${firstSentence}` : firstSentence;
  if (compact.length > MAX_DESC) compact = compact.slice(0, MAX_DESC - 3) + '...';
  return { ...tool, description: compact };
}

export function compactTools(tools: ToolDef[]): ToolDef[] {
  return tools.map(compactTool);
}