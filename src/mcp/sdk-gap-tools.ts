/**
 * Wraps @polymarket/client SDK surface that had no MCP tool at all: perps,
 * combo markets, market-scoped position ops, and a few order/wallet
 * prepare/check workflows. Every one of these is a genuine, existing SDK
 * function (verified against the installed @polymarket/client typings) —
 * this module adds coverage, it does not invent behavior.
 *
 * Deliberately excluded: openPerpsSession (returns a stateful
 * AsyncIterable<PerpsSessionEvent> session handle — placing perps orders
 * happens through methods on that session object, not a standalone
 * function). Wrapping that as stateless request/response MCP tools would
 * need session-lifecycle management this module doesn't attempt; flagging
 * it here rather than faking a shape for it.
 */
import * as actions from '@polymarket/client/actions';
import * as F from '../formatters.js';
import { withBuilderCode } from '../config/builder-code.js';

type ToolDef = { name: string; description: string; inputSchema: any };
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

interface GapToolContext {
  getPub: () => any;
  getSec: () => Promise<any>;
  /**
   * Guardrails check for on-chain/fund-moving actions (deposit/withdraw perps,
   * combo/market split-merge, revoke perps credentials). Same readOnly-by-
   * default gate as the main dispatcher's order/state-changing tools — passed
   * in rather than imported directly so this module doesn't need to reach
   * into mcp.ts's module-level strategyStore. Returns a ToolResult to return
   * immediately if blocked, or null if clear to proceed.
   */
  stateGuard: () => ToolResult | null;
}

function ok(payload: unknown, title: string): ToolResult {
  return { content: [{ type: 'text', text: F.toHumanReadable(F.formatGeneric(payload), title) }] };
}

function errorResult(toolName: string, error: unknown): ToolResult {
  const message = (error as any)?.message ?? String(error);
  return { isError: true, content: [{ type: 'text', text: `Error in ${toolName}: ${message}` }] };
}

async function paginatedFirstPage(paginatorPromise: Promise<any>, limit: number, offset: number) {
  const paginator = await paginatorPromise;
  const page = await (typeof paginator.firstPage === 'function' ? paginator.firstPage() : paginator);
  const items = page?.items ?? (Array.isArray(page) ? page : []);
  return {
    items,
    limit,
    offset,
    nextCursor: page?.nextCursor ?? undefined,
  };
}

function pageArgs(args: any): { limit: number; offset: number } {
  const limit = Math.min(Math.max(1, Number(args?.pageSize ?? args?.limit ?? 10)), 100);
  const offset = Number(args?.offset ?? 0) || 0;
  return { limit, offset };
}

export const GAP_TOOLS: ToolDef[] = [
  // ---- Perps (public market data) ----
  { name: 'fetch_perps_book', description: '[Perps] SDK fetchPerpsBook — order book depth for a perps instrument.', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  { name: 'fetch_perps_fees', description: '[Perps] SDK fetchPerpsFees — fee schedule for perps trading.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fetch_perps_instruments', description: '[Perps] SDK fetchPerpsInstruments — list of tradeable perps instruments.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fetch_perps_ticker', description: '[Perps] SDK fetchPerpsTicker — ticker (price/volume snapshot) for one instrument.', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  { name: 'fetch_perps_tickers', description: '[Perps] SDK fetchPerpsTickers — ticker snapshot for all instruments.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_perps_candles', description: '[Perps] SDK listPerpsCandles — OHLC candles for an instrument. Default limit 10, max 100.', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['symbol'] } },
  { name: 'list_perps_funding_history', description: '[Perps] SDK listPerpsFundingHistory — historical funding rates. Default limit 10, max 100.', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['symbol'] } },
  { name: 'list_perps_trades', description: '[Perps] SDK listPerpsTrades — recent public trades for an instrument. Default limit 10, max 100.', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['symbol'] } },

  // ---- Perps (account, secure) ----
  { name: 'deposit_to_perps', description: '[Perps] [Trading] SDK depositToPerps — move collateral into the perps account.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
  { name: 'withdraw_from_perps', description: '[Perps] [Trading] SDK withdrawFromPerps — withdraw collateral from the perps account.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
  { name: 'prepare_perps_deposit', description: '[Perps] Sign-only SDK preparePerpsDeposit — returns the deposit workflow without submitting.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
  { name: 'revoke_perps_credentials', description: '[Perps] SDK revokePerpsCredentials — revoke this account’s perps session credentials.', inputSchema: { type: 'object', properties: {} } },

  // ---- Combo markets ----
  { name: 'list_combo_markets', description: '[Combo] SDK listComboMarkets — multi-leg combo markets. Default limit 10, max 100.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'list_combo_positions', description: '[Combo] SDK listComboPositions — this account’s combo positions. Default limit 10, max 100.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'merge_combo_position', description: '[Combo] [Trading] SDK mergeComboPosition — merge outcome tokens into collateral for a combo market.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'prepare_merge_combo_position', description: '[Combo] Sign-only SDK prepareMergeComboPosition.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'split_combo_position', description: '[Combo] [Trading] SDK splitComboPosition — split collateral into outcome tokens for a combo market.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'prepare_split_combo_position', description: '[Combo] Sign-only SDK prepareSplitComboPosition.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'prepare_redeem_combo_position', description: '[Combo] Sign-only SDK prepareRedeemComboPosition — resolved combo market redemption.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },

  // ---- Market-scoped position ops (single market, all outcomes) ----
  { name: 'merge_market_position', description: '[Positions] [Trading] SDK mergeMarketPosition — merge all outcome tokens of a market into collateral.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'prepare_merge_market_position', description: '[Positions] Sign-only SDK prepareMergeMarketPosition.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'split_market_position', description: '[Positions] [Trading] SDK splitMarketPosition — split collateral into all outcome tokens of a market.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'prepare_split_market_position', description: '[Positions] Sign-only SDK prepareSplitMarketPosition.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'prepare_redeem_market_positions', description: '[Positions] Sign-only SDK prepareRedeemMarketPositions — resolved-market redemption for all positions in that market.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },

  // ---- Order / wallet prepare workflows ----
  { name: 'prepare_limit_order_posting', description: '[Trading] Sign-only SDK prepareLimitOrderPosting — full sign+post workflow object without submitting.', inputSchema: { type: 'object', properties: { tokenId: { type: 'string' }, price: { type: 'number' }, size: { type: 'number' }, side: { type: 'string', enum: ['BUY', 'SELL'] }, postOnly: { type: 'boolean' }, expiration: { type: 'number' } }, required: ['tokenId', 'price', 'size', 'side'] } },
  { name: 'prepare_market_order_posting', description: '[Trading] Sign-only SDK prepareMarketOrderPosting — full sign+post workflow object without submitting.', inputSchema: { type: 'object', properties: { tokenId: { type: 'string' }, side: { type: 'string', enum: ['BUY', 'SELL'] }, amount: { type: 'number' }, shares: { type: 'number' }, orderType: { type: 'string', enum: ['FOK', 'FAK'] } }, required: ['tokenId', 'side'] } },
  { name: 'prepare_trading_approvals', description: '[Account] Sign-only SDK prepareTradingApprovals — returns the approvals workflow without submitting (compare to setup_trading_approvals, which submits).', inputSchema: { type: 'object', properties: {} } },
  { name: 'is_wallet_deployed', description: '[Account] SDK isWalletDeployed — checks whether the funder/proxy wallet contract has been deployed on-chain yet.', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } },
];

const GAP_TOOL_NAMES = new Set(GAP_TOOLS.map((t) => t.name));

export function isGapTool(name: string): boolean {
  return GAP_TOOL_NAMES.has(name);
}

export async function handleGapTool(name: string, args: any, ctx: GapToolContext): Promise<ToolResult | null> {
  if (!GAP_TOOL_NAMES.has(name)) return null;
  const pub = ctx.getPub();
  try {
    switch (name) {
      case 'fetch_perps_book':
        return ok(await actions.fetchPerpsBook(pub, args), 'Perps Book');
      case 'fetch_perps_fees':
        return ok(await actions.fetchPerpsFees(pub), 'Perps Fees');
      case 'fetch_perps_instruments':
        return ok(await actions.fetchPerpsInstruments(pub, args), 'Perps Instruments');
      case 'fetch_perps_ticker':
        return ok(await actions.fetchPerpsTicker(pub, args), 'Perps Ticker');
      case 'fetch_perps_tickers':
        return ok(await actions.fetchPerpsTickers(pub, args), 'Perps Tickers');
      case 'list_perps_candles': {
        const { limit, offset } = pageArgs(args);
        return ok(await paginatedFirstPage(Promise.resolve(actions.listPerpsCandles(pub, { ...args, pageSize: limit })), limit, offset), 'Perps Candles');
      }
      case 'list_perps_funding_history': {
        const { limit, offset } = pageArgs(args);
        return ok(await paginatedFirstPage(Promise.resolve(actions.listPerpsFundingHistory(pub, { ...args, pageSize: limit })), limit, offset), 'Perps Funding History');
      }
      case 'list_perps_trades': {
        const { limit, offset } = pageArgs(args);
        return ok(await paginatedFirstPage(Promise.resolve(actions.listPerpsTrades(pub, { ...args, pageSize: limit })), limit, offset), 'Perps Trades');
      }

      case 'deposit_to_perps': {
        const guard = ctx.stateGuard();
        if (guard) return guard;
        const sec = await ctx.getSec();
        return ok(await actions.depositToPerps(sec, args), 'Perps Deposit');
      }
      case 'withdraw_from_perps': {
        const guard = ctx.stateGuard();
        if (guard) return guard;
        const sec = await ctx.getSec();
        return ok(await actions.withdrawFromPerps(sec, args), 'Perps Withdrawal');
      }
      case 'prepare_perps_deposit': {
        const sec = await ctx.getSec();
        return ok(await actions.preparePerpsDeposit(sec, args), 'Prepared Perps Deposit');
      }
      case 'revoke_perps_credentials': {
        const guard = ctx.stateGuard();
        if (guard) return guard;
        const sec = await ctx.getSec();
        await actions.revokePerpsCredentials(sec, args);
        return ok({ success: true }, 'Perps Credentials Revoked');
      }

      case 'list_combo_markets': {
        const { limit, offset } = pageArgs(args);
        return ok(await paginatedFirstPage(Promise.resolve(actions.listComboMarkets(pub, { ...args, pageSize: limit })), limit, offset), 'Combo Markets');
      }
      case 'list_combo_positions': {
        const sec = await ctx.getSec();
        const { limit, offset } = pageArgs(args);
        return ok(await paginatedFirstPage(Promise.resolve(actions.listComboPositions(sec, { ...args, pageSize: limit })), limit, offset), 'Combo Positions');
      }
      case 'merge_combo_position': {
        const guard = ctx.stateGuard();
        if (guard) return guard;
        const sec = await ctx.getSec();
        return ok(await actions.mergeComboPosition(sec, args), 'Combo Merge Result');
      }
      case 'prepare_merge_combo_position': {
        const sec = await ctx.getSec();
        return ok(await actions.prepareMergeComboPosition(sec, args), 'Prepared Combo Merge');
      }
      case 'split_combo_position': {
        const guard = ctx.stateGuard();
        if (guard) return guard;
        const sec = await ctx.getSec();
        return ok(await actions.splitComboPosition(sec, args), 'Combo Split Result');
      }
      case 'prepare_split_combo_position': {
        const sec = await ctx.getSec();
        return ok(await actions.prepareSplitComboPosition(sec, args), 'Prepared Combo Split');
      }
      case 'prepare_redeem_combo_position': {
        const sec = await ctx.getSec();
        return ok(await actions.prepareRedeemComboPosition(sec, args), 'Prepared Combo Redeem');
      }

      case 'merge_market_position': {
        const guard = ctx.stateGuard();
        if (guard) return guard;
        const sec = await ctx.getSec();
        return ok(await actions.mergeMarketPosition(sec, args), 'Market Merge Result');
      }
      case 'prepare_merge_market_position': {
        const sec = await ctx.getSec();
        return ok(await actions.prepareMergeMarketPosition(sec, args), 'Prepared Market Merge');
      }
      case 'split_market_position': {
        const guard = ctx.stateGuard();
        if (guard) return guard;
        const sec = await ctx.getSec();
        return ok(await actions.splitMarketPosition(sec, args), 'Market Split Result');
      }
      case 'prepare_split_market_position': {
        const sec = await ctx.getSec();
        return ok(await actions.prepareSplitMarketPosition(sec, args), 'Prepared Market Split');
      }
      case 'prepare_redeem_market_positions': {
        const sec = await ctx.getSec();
        return ok(await actions.prepareRedeemMarketPositions(sec, args), 'Prepared Market Redeem');
      }

      case 'prepare_limit_order_posting': {
        const sec = await ctx.getSec();
        return ok(
          await actions.prepareLimitOrderPosting(sec, withBuilderCode(args)),
          'Prepared Limit Order Posting'
        );
      }
      case 'prepare_market_order_posting': {
        const sec = await ctx.getSec();
        return ok(
          await actions.prepareMarketOrderPosting(sec, withBuilderCode(args)),
          'Prepared Market Order Posting'
        );
      }
      case 'prepare_trading_approvals': {
        const sec = await ctx.getSec();
        return ok(await actions.prepareTradingApprovals(sec), 'Prepared Trading Approvals');
      }
      case 'is_wallet_deployed':
        return ok({ isDeployed: await actions.isWalletDeployed(pub, args) }, 'Wallet Deployment Status');

      default:
        return null;
    }
  } catch (error) {
    return errorResult(name, error);
  }
}
