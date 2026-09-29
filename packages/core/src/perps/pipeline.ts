import type {
  Address,
  OrderTypedData,
  PerpAccount,
  PerpActionRecord,
  PerpCancelQuote,
  PerpCloseQuote,
  PerpWaitingOrder,
  PerpCollateralQuote,
  PerpMarketDef,
  PerpOpenQuote,
  PerpPosition,
  PerpQuote,
  PerpSide,
  PerpVenueId,
  TxRequest,
} from '@robinchan/shared';
import {
  PERP_LIQUIDATION_THRESHOLD,
  PERP_MIN_COLLATERAL,
  PERP_QUOTE_TTL_SEC,
  perpLiquidationPrice,
  perpMarket,
  perpPayout,
  perpPricePnl,
  perpReserve,
} from '@robinchan/shared';
import { getPerpStore, newId, type PerpActionRow, type PerpPositionRow } from '@robinchan/store';
import { encodeFunctionData, formatEther, parseUnits, verifyTypedData, type Hex } from 'viem';

import { ERC20_ABI, explorerTx, publicClient } from '../chain';
import { chainConfig, isDev } from '../env';
import { AGRI_PERP_ABI, AGRI_VAULT_ABI, MOCK_USDC_ABI } from './abi';
import { chainState, revertName, revertText, type ChainState } from './chain';
import {
  agriPerpContracts,
  paperFaucetAmount,
  paperFaucetCap,
  perpCloseFeeBps,
  perpCollateralSymbol,
  perpExecutionFeeWei,
  perpFeeBps,
  perpMaxProfitMultiple,
  perpsEnabled,
  perpSlippageBps,
  perpsVenue,
} from './config';
import { PerpError } from './errors';
import { perpMarkFor, perpMarks, perpMarketStatus, type Mark } from './markets';
import { fundingIndexAt, fundingOwed, perpMarketState, perpMarketStates, type MarketState } from './state';

/**
 * The perps pipeline: quote → sign → settle, on either venue.
 *
 * - Every number that reaches a signature or a transaction is computed here
 *   from server-side prices and balances; nothing from the page does.
 * - A quote is bound to one address and lives 20 seconds.
 * - Paper settles the moment a valid signature arrives, against the price
 *   at that moment, within the quote's `acceptablePrice`.
 * - On chain an open or close is a *request*: the keeper then executes it at
 *   the first Chainlink round published after it (so the trader can't pick
 *   a price, nor trade the feed's lag), within the same bound, and the
 *   worker follows it until it settles. Until that round is out, the trader
 *   can take it back.
 */

export type PerpUser = { id: string; address: Address };

const QUOTE_GRACE_MS = 5_000;
const EPS = 1e-9;
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
/** USD → 18-decimal price, via 8 decimals so float noise never reaches the contract. */
const price18 = (usd: number): bigint => BigInt(Math.round(usd * 1e8)) * 10n ** 10n;
const usdcUnits = (usd: number): bigint => parseUnits(usd.toFixed(6), 6);

function assertPerps(): PerpVenueId {
  if (!perpsEnabled()) throw new PerpError('FEATURE_DISABLED', 'Perps are not live yet.', 403);
  const venue = perpsVenue();
  if (!venue) throw new PerpError('NOT_CONFIGURED', 'No perps venue is configured on this server.', 503);
  return venue;
}

type Terms = { feeBps: number; closeFeeBps: number; threshold: number; maxProfitMultiple: number; minCollateral: number };

function terms(venue: PerpVenueId, chain: ChainState | null): Terms {
  if (venue === 'agri-perp' && chain) {
    return {
      feeBps: chain.params.openFeeBps,
      closeFeeBps: chain.params.closeFeeBps,
      threshold: chain.params.liquidationThresholdBps / 10_000,
      maxProfitMultiple: chain.params.maxProfitBps / 10_000,
      minCollateral: chain.params.minCollateral,
    };
  }
  return {
    feeBps: perpFeeBps(),
    closeFeeBps: perpCloseFeeBps(),
    threshold: PERP_LIQUIDATION_THRESHOLD,
    maxProfitMultiple: perpMaxProfitMultiple(),
    minCollateral: PERP_MIN_COLLATERAL,
  };
}

/* ------------------------------------------------------------------ */
/* Typed data (paper venue)                                            */
/* ------------------------------------------------------------------ */

export const PERP_ORDER_TYPES: OrderTypedData['types'] = {
  PerpOrder: [
    { name: 'actionId', type: 'string' },
    { name: 'action', type: 'string' },
    { name: 'symbol', type: 'string' },
    { name: 'side', type: 'string' },
    { name: 'collateral', type: 'string' },
    { name: 'leverage', type: 'string' },
    { name: 'acceptablePrice', type: 'string' },
    { name: 'positionId', type: 'string' },
    { name: 'venue', type: 'string' },
    { name: 'expiresAt', type: 'string' },
    { name: 'trader', type: 'address' },
  ],
};

function typedData(m: Record<string, string>): OrderTypedData {
  return {
    domain: { name: 'Robinchan Perps', version: '1', chainId: chainConfig()?.id ?? 0 },
    types: PERP_ORDER_TYPES,
    primaryType: 'PerpOrder',
    message: m,
  };
}

async function checkSignature(address: Address, td: OrderTypedData, signature: Hex): Promise<boolean> {
  const fields = { address, ...td, signature };
  try {
    if (await verifyTypedData(fields as Parameters<typeof verifyTypedData>[0])) return true;
  } catch {
    /* fall through to the contract-wallet check */
  }
  const client = publicClient();
  if (!client) return false;
  try {
    return await client.verifyTypedData(fields as unknown as Parameters<typeof client.verifyTypedData>[0]);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Transactions (on-chain venue)                                       */
/* ------------------------------------------------------------------ */

function contracts() {
  const c = agriPerpContracts();
  if (!c) throw new PerpError('NOT_CONFIGURED', 'The AgriPerp contract addresses are not configured.', 503);
  return c;
}

function chainClient() {
  const c = publicClient();
  if (!c) throw new PerpError('NOT_CONFIGURED', 'No chain is configured.', 503);
  return c;
}

async function requireChain(): Promise<ChainState> {
  const state = await chainState({ maxAgeSec: 10 });
  if (!state) throw new PerpError('UPSTREAM_DOWN', "The perps contract couldn't be read right now.", 503);
  return state;
}

async function walletReads(user: Address, usdc: Address, vault: Address) {
  const c = chainClient();
  const [free, allowance, balance, native] = await Promise.all([
    c.readContract({ address: vault, abi: AGRI_VAULT_ABI, functionName: 'freeCollateral', args: [user] }),
    c.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'allowance', args: [user, vault] }),
    c.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] }),
    c.getBalance({ address: user }),
  ]);
  return { free, allowance, balance, native };
}

/** Network fee for a batch of transactions, in the native token; a rough figure when estimation can't run. */
async function estimateGasNative(txs: TxRequest[], from: Address): Promise<number> {
  const c = chainClient();
  const gasPrice = await c.getGasPrice().catch(() => 100_000_000n);
  let units = 0n;
  for (const tx of txs) {
    // A step after an approval can't be simulated before the approval lands.
    const fallback = tx.label.startsWith('Approve') ? 60_000n : 350_000n;
    units += await c.estimateGas({ account: from, to: tx.to, data: tx.data, value: BigInt(tx.value) }).catch(() => fallback);
  }
  return Number(formatEther(units * gasPrice));
}

/**
 * One transaction on its way at a time, so the wallet's nonces never race.
 * An order whose request already landed isn't in flight: it only waits for
 * its price — hours, for a stock feed quiet overnight — and mustn't block
 * the trader's next order meanwhile.
 */
export async function assertNothingInFlight(userId: string): Promise<void> {
  const pending = await getPerpStore().listActions({ userId, statuses: ['pending'], limit: 50 });
  if (pending.some((a) => a.chainOrderId == null)) {
    throw new PerpError('ORDER_IN_FLIGHT', 'Your previous transaction is still waiting on the network. Let it land first.', 409);
  }
}

/** What an on-chain order pays its executor: the contract's minimum, or more if configured. */
function executionFeeFor(cs: ChainState): bigint {
  const min = BigInt(cs.params.minExecutionFee);
  const configured = perpExecutionFeeWei();
  return configured > min ? configured : min;
}

/** What a trader waits for on chain: Chainlink publishes when the price moves past its threshold, or daily. */
const EXECUTION_NOTE = (def: PerpMarketDef) =>
  def.twap
    ? `The order fills at the first 15-minute ${def.symbol} average that starts after it — about 16 minutes from now, at a price nobody can see yet. While it waits you can ask for it back, forfeiting the opening fee.`
    : `The order fills at Chainlink's next ${def.symbol} price — published when the price moves 0.5%, or within 24 hours. On a quiet market that can take hours; while it waits you can ask for it back, forfeiting the opening fee.`;

/* ------------------------------------------------------------------ */
/* Quote: open                                                         */
/* ------------------------------------------------------------------ */

export async function quotePerpOpen(
  user: PerpUser,
  input: { symbol: string; side: PerpSide; collateral: number; leverage: number },
): Promise<PerpOpenQuote> {
  const venue = assertPerps();
  const def = perpMarket(String(input.symbol ?? ''));
  if (!def) throw new PerpError('NOT_FOUND', `${input.symbol || 'That symbol'} isn't a perps market.`, 404, 'symbol');
  if (def.unavailable) throw new PerpError('NOT_TRADABLE', def.unavailable, 400, 'symbol');
  if (input.side !== 'long' && input.side !== 'short') throw new PerpError('BAD_REQUEST', 'Choose long or short.', 400, 'side');
  const leverage = Number(input.leverage);
  if (!Number.isInteger(leverage) || leverage < 1) throw new PerpError('BAD_REQUEST', 'Leverage is a whole number from 1×.', 400, 'leverage');
  const collateral = round6(Number(input.collateral));
  if (!Number.isFinite(collateral) || collateral <= 0) throw new PerpError('BAD_REQUEST', 'Enter collateral above zero.', 400, 'collateral');
  if (collateral > 1_000_000) throw new PerpError('BAD_REQUEST', 'That collateral is far above any sensible position.', 400, 'collateral');

  const chain = venue === 'agri-perp' ? await requireChain() : null;
  const mark = await perpMarkFor(def.symbol);
  const state = mark?.state ?? (await perpMarketState(def.symbol));
  const status = perpMarketStatus(def, state, mark, { venueConfigured: true });
  if (status.status !== 'open' || !mark || !state) {
    throw new PerpError('MARKET_CLOSED', status.statusNote ?? `${def.symbol} isn't open right now.`, 409);
  }
  if (leverage > state.maxLeverage) {
    throw new PerpError('BAD_REQUEST', `${def.symbol} goes up to ${state.maxLeverage}×.`, 400, 'leverage');
  }
  const t = terms(venue, chain);
  if (collateral < t.minCollateral) {
    throw new PerpError('BAD_REQUEST', `The minimum collateral is ${t.minCollateral} ${perpCollateralSymbol()}.`, 400, 'collateral');
  }

  const size = round6(collateral * leverage);
  if (def.maxPositionUsd != null && size > def.maxPositionUsd + EPS) {
    throw new PerpError(
      'BAD_REQUEST',
      `${def.symbol} positions go up to $${def.maxPositionUsd.toLocaleString('en-US')} of size: at ${leverage}×, that's ${(def.maxPositionUsd / leverage).toFixed(2)} ${perpCollateralSymbol()} of collateral at most.`,
      400,
      'collateral',
    );
  }
  const fee = round6((size * t.feeBps) / 10_000);
  // Checked after the trader's balance: someone who can't pay for it hears that first.
  const checkOpenInterest = () => {
    const sideOi = input.side === 'long' ? state.longOi : state.shortOi;
    if (sideOi + size > state.maxOi + EPS) {
      throw new PerpError(
        'LIQUIDITY_LIMIT',
        `${def.symbol} ${input.side}s are near their open-interest cap: at most $${Math.max(0, state.maxOi - sideOi).toFixed(2)} more of size fits.`,
        409,
        'collateral',
      );
    }
  };

  const slippageBps = Math.max(perpSlippageBps(), def.minSlippageBps ?? 0);
  const acceptablePrice = input.side === 'long' ? mark.price * (1 + slippageBps / 10_000) : mark.price * (1 - slippageBps / 10_000);
  const id = newId();
  const quotedAt = new Date();
  const expiresAt = new Date(quotedAt.getTime() + PERP_QUOTE_TTL_SEC * 1000).toISOString();
  const warnings: string[] = [];
  if (venue === 'agri-perp') warnings.push(EXECUTION_NOTE(def));
  if (leverage >= 20) {
    warnings.push(`At ${leverage}×, a ${((t.threshold / leverage) * 100).toFixed(1)}% move against you liquidates the position.`);
  }
  if (def.schedule !== '24/7') {
    warnings.push(`${def.symbol} only trades ${def.hours}. While it's shut nothing can be closed or liquidated, and it can reopen far from here.`);
  }

  const base = {
    id,
    action: 'open' as const,
    venue,
    address: user.address,
    symbol: def.symbol,
    side: input.side,
    collateral,
    leverage,
    size,
    markPrice: mark.price,
    acceptablePrice,
    slippageBps,
    liquidationPrice: perpLiquidationPrice({ side: input.side, entry: mark.price, collateral, size, threshold: t.threshold }),
    fee,
    feeBps: t.feeBps,
    fundingRatePerHour: state.fundingRate,
    // Fills are at the oracle price: no impact is charged (the brief's
    // size-based estimate would describe a cost that doesn't exist).
    priceImpact: 0,
    quotedAt: quotedAt.toISOString(),
    expiresAt,
    warnings,
  };

  let quote: PerpOpenQuote;
  if (venue === 'paper') {
    const account = await getPerpStore().getPaperAccount(user.id);
    if (account.free + EPS < collateral + fee) {
      throw new PerpError(
        'INSUFFICIENT_BALANCE',
        `This needs ${(collateral + fee).toFixed(2)} ${perpCollateralSymbol()} (collateral + fee) and you have ${account.free.toFixed(2)} free.`,
        400,
        'collateral',
      );
    }
    checkOpenInterest();
    quote = {
      ...base,
      executionFee: 0,
      estGas: 0,
      gasSymbol: chainConfig()?.nativeSymbol ?? 'ETH',
      depositNeeded: 0,
      execution: {
        kind: 'signature',
        typedData: typedData({
          actionId: id,
          action: 'open',
          symbol: def.symbol,
          side: input.side,
          collateral: collateral.toFixed(6),
          leverage: String(leverage),
          acceptablePrice: acceptablePrice.toPrecision(10),
          positionId: '',
          venue: 'paper',
          expiresAt,
          trader: user.address,
        }),
      },
    };
  } else {
    const c = contracts();
    const cs = chain as ChainState;
    await assertNothingInFlight(user.id);
    const w = await walletReads(user.address, cs.usdc, c.vault);
    const free = Number(w.free) / 1e6;
    const depositNeeded = round6(Math.max(0, collateral + fee - free));
    if (depositNeeded > Number(w.balance) / 1e6 + EPS) {
      throw new PerpError(
        'INSUFFICIENT_BALANCE',
        `This needs ${(collateral + fee).toFixed(2)} ${perpCollateralSymbol()}; you have ${free.toFixed(2)} in the vault and ${(Number(w.balance) / 1e6).toFixed(2)} in the wallet.`,
        400,
        'collateral',
      );
    }
    checkOpenInterest();
    const reserve = perpReserve(collateral, size, t.maxProfitMultiple);
    if (cs.pool.available + EPS < reserve) {
      throw new PerpError(
        'LIQUIDITY_LIMIT',
        `The pool can't reserve $${reserve.toFixed(2)} for this right now ($${cs.pool.available.toFixed(2)} free). Try a smaller position.`,
        409,
        'collateral',
      );
    }
    const executionFee = executionFeeFor(cs);
    const deposit = usdcUnits(depositNeeded);
    const chainId = cs.chainId;
    const txs: TxRequest[] = [];
    if (deposit > 0n && w.allowance < deposit) {
      txs.push({
        to: cs.usdc,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [c.vault, deposit] }),
        value: '0',
        chainId,
        label: `Approve ${perpCollateralSymbol()}`,
      });
    }
    txs.push({
      to: c.perp,
      data: encodeFunctionData({
        abi: AGRI_PERP_ABI,
        functionName: 'requestOpen',
        args: [
          def.symbol,
          input.side === 'long',
          usdcUnits(collateral),
          BigInt(leverage),
          price18(acceptablePrice),
          BigInt(t.feeBps),
          deposit,
        ],
      }),
      value: executionFee.toString(),
      chainId,
      label: `Open ${input.side} ${def.symbol}`,
    });
    const estGas = await estimateGasNative(txs, user.address);
    const executionNative = Number(formatEther(executionFee));
    if (Number(formatEther(w.native)) < estGas + executionNative) {
      throw new PerpError(
        'INSUFFICIENT_GAS',
        `You need about ${(estGas + executionNative).toPrecision(2)} ${chainConfig()?.nativeSymbol ?? 'ETH'} for the network and execution fees.`,
        400,
        'gas',
      );
    }
    quote = {
      ...base,
      executionFee: executionNative,
      estGas,
      gasSymbol: chainConfig()?.nativeSymbol ?? 'ETH',
      depositNeeded,
      execution: { kind: 'transactions', txs },
    };
  }

  await getPerpStore().insertAction({
    id,
    userId: user.id,
    address: user.address.toLowerCase(),
    kind: 'open',
    venue,
    symbol: def.symbol,
    positionId: null,
    amount: collateral,
    status: 'quoted',
    quote,
    chainOrderId: null,
    txHash: null,
    txHashes: [],
    signature: null,
    error: null,
    expiresAt,
    checkedAt: null,
  });
  return quote;
}

/* ------------------------------------------------------------------ */
/* Quote: close                                                        */
/* ------------------------------------------------------------------ */

async function ownPosition(user: PerpUser, positionId: string): Promise<PerpPositionRow> {
  const row = await getPerpStore().getPosition(positionId);
  if (!row || row.address !== user.address.toLowerCase()) throw new PerpError('NOT_FOUND', 'Position not found.', 404);
  return row;
}

export async function quotePerpClose(user: PerpUser, positionId: string): Promise<PerpCloseQuote> {
  const venue = assertPerps();
  const row = await ownPosition(user, positionId);
  if (row.status !== 'open') throw new PerpError('CONFLICT', `This position is already ${row.status}.`, 409);
  if (row.venue !== venue) throw new PerpError('NOT_CONFIGURED', 'This position is on a venue this server no longer trades.', 409);
  const def = perpMarket(row.symbol);
  if (!def) throw new PerpError('NOT_FOUND', 'Unknown market.', 404);

  const chain = venue === 'agri-perp' ? await requireChain() : null;
  const mark = await perpMarkFor(row.symbol);
  if (mark?.state.delisted) {
    throw new PerpError('MARKET_CLOSED', `${row.symbol} was delisted: open positions settle at its last price without a close.`, 409);
  }
  if (!mark?.fresh) {
    throw new PerpError(
      'MARKET_CLOSED',
      mark
        ? def.twap
          ? `${row.symbol} can't be closed while its 15-minute average is stale — the last one is ${Math.round(mark.ageSec / 60)} minutes old. It resumes once the pool's average updates again.`
          : `${row.symbol} can't be closed while its market is shut — Chainlink last published ${mark.ageSec < 5_400 ? `${Math.round(mark.ageSec / 60)} minutes` : `${Math.round(mark.ageSec / 3_600)} hours`} ago. It trades ${def.hours}.`
        : `There's no ${row.symbol} price to close against yet.`,
      409,
    );
  }
  const pnl = perpPricePnl({
    side: row.side,
    size: row.size,
    collateral: row.collateral,
    entry: row.entryIndex,
    mark: mark.index,
    maxProfitMultiple: row.reserve / row.collateral,
  });
  const funding = fundingOwed(row, fundingIndexAt(mark.state));
  const gross = Math.min(perpPayout({ collateral: row.collateral, pnl, fundingOwed: funding }), row.collateral + row.reserve);
  const { closeFeeBps } = terms(venue, chain);
  const fee = Math.min(gross, (row.size * closeFeeBps) / 10_000);
  const payout = gross - fee;
  const slippageBps = Math.max(perpSlippageBps(), def.minSlippageBps ?? 0);
  // Closing a long sells (a floor), closing a short buys (a ceiling).
  const acceptablePrice = row.side === 'long' ? mark.price * (1 - slippageBps / 10_000) : mark.price * (1 + slippageBps / 10_000);
  const id = newId();
  const quotedAt = new Date();
  const expiresAt = new Date(quotedAt.getTime() + PERP_QUOTE_TTL_SEC * 1000).toISOString();

  const base = {
    id,
    action: 'close' as const,
    venue,
    address: user.address,
    symbol: row.symbol,
    side: row.side,
    positionId: row.id,
    collateral: row.collateral,
    size: row.size,
    entryPrice: row.entryIndex / (mark.index / mark.price),
    markPrice: mark.price,
    acceptablePrice,
    slippageBps,
    estPnl: round6(pnl),
    estFunding: round6(funding),
    fee: round6(fee),
    feeBps: closeFeeBps,
    estPayout: round6(payout),
    quotedAt: quotedAt.toISOString(),
    expiresAt,
    warnings: [] as string[],
  };

  let quote: PerpCloseQuote;
  if (venue === 'paper') {
    quote = {
      ...base,
      executionFee: 0,
      estGas: 0,
      gasSymbol: chainConfig()?.nativeSymbol ?? 'ETH',
      execution: {
        kind: 'signature',
        typedData: typedData({
          actionId: id,
          action: 'close',
          symbol: row.symbol,
          side: row.side,
          collateral: row.collateral.toFixed(6),
          leverage: String(row.leverage),
          acceptablePrice: acceptablePrice.toPrecision(10),
          positionId: row.id,
          venue: 'paper',
          expiresAt,
          trader: user.address,
        }),
      },
    };
  } else {
    const c = contracts();
    const cs = chain as ChainState;
    await assertNothingInFlight(user.id);
    if (!row.chainPositionId) throw new PerpError('CONFLICT', 'This position has no on-chain id yet.', 409);
    const executionFee = executionFeeFor(cs);
    const txs: TxRequest[] = [
      {
        to: c.perp,
        data: encodeFunctionData({
          abi: AGRI_PERP_ABI,
          functionName: 'requestClose',
          args: [BigInt(row.chainPositionId), price18(acceptablePrice)],
        }),
        value: executionFee.toString(),
        chainId: cs.chainId,
        label: `Close ${row.side} ${row.symbol}`,
      },
    ];
    quote = {
      ...base,
      executionFee: Number(formatEther(executionFee)),
      estGas: await estimateGasNative(txs, user.address),
      gasSymbol: chainConfig()?.nativeSymbol ?? 'ETH',
      execution: { kind: 'transactions', txs },
    };
  }

  await getPerpStore().insertAction({
    id,
    userId: user.id,
    address: user.address.toLowerCase(),
    kind: 'close',
    venue,
    symbol: row.symbol,
    positionId: row.id,
    amount: row.collateral,
    status: 'quoted',
    quote,
    chainOrderId: null,
    txHash: null,
    txHashes: [],
    signature: null,
    error: null,
    expiresAt,
    checkedAt: null,
  });
  return quote;
}

/* ------------------------------------------------------------------ */
/* Cancel: an on-chain order still waiting for its round               */
/* ------------------------------------------------------------------ */

/**
 * Asks for an open or close request back while its Chainlink round hasn't
 * landed — a quiet feed can keep an order waiting for hours. The ask goes out
 * from the wallet; five minutes later the keeper releases the order, and the
 * action settles as cancelled when the worker sees it. An open forfeits its
 * opening fee: it held the pool's liquidity while it waited, and a free
 * cancel would let anyone hold it for nothing. A price Chainlink had observed
 * before the ask still fills the order: whoever saw it early could otherwise
 * cancel exactly the fills that go against them. Checked against the
 * contract first: once the round is out, nothing takes the order back.
 */
export async function quotePerpCancel(user: PerpUser, actionId: string): Promise<PerpCancelQuote> {
  const venue = assertPerps();
  if (venue !== 'agri-perp') throw new PerpError('BAD_REQUEST', 'Only on-chain orders wait for their price.', 400);
  const action = await ownAction(user, actionId);
  if (action.status !== 'pending' || action.chainOrderId == null || (action.kind !== 'open' && action.kind !== 'close')) {
    throw new PerpError('CONFLICT', 'There is no order waiting here to take back.', 409);
  }
  if (action.cancelRequestedAt) throw new PerpError('CONFLICT', 'You already asked for this order back: it’s released within five minutes.', 409);
  const c = contracts();
  const cs = await requireChain();
  const orderId = BigInt(action.chainOrderId);
  try {
    await chainClient().simulateContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'cancelOrder', args: [orderId], account: user.address });
  } catch (err) {
    throw new PerpError('CONFLICT', revertText(revertName(err)), 409);
  }
  const quote = action.quote as PerpQuote | null;
  return {
    id: action.id,
    kind: 'cancel',
    address: user.address,
    venue,
    openingFee: quote?.action === 'open' ? quote.fee : 0,
    execution: {
      kind: 'transactions',
      txs: [
        {
          to: c.perp,
          data: encodeFunctionData({ abi: AGRI_PERP_ABI, functionName: 'cancelOrder', args: [orderId] }),
          value: '0',
          chainId: cs.chainId,
          label: action.kind === 'open' ? `Take back the ${action.symbol ?? ''} order` : `Take back the ${action.symbol ?? ''} close`,
        },
      ],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Collateral (on-chain) and the faucet                                */
/* ------------------------------------------------------------------ */

export async function quotePerpCollateral(user: PerpUser, input: { kind: 'deposit' | 'withdraw'; amount: number }): Promise<PerpCollateralQuote> {
  const venue = assertPerps();
  if (venue !== 'agri-perp') {
    throw new PerpError('BAD_REQUEST', 'The paper venue has no deposits: use the test-USDC button instead.', 400, 'amount');
  }
  const amount = round6(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new PerpError('BAD_REQUEST', 'Enter an amount above zero.', 400, 'amount');
  await assertNothingInFlight(user.id);
  const c = contracts();
  const cs = await requireChain();
  const w = await walletReads(user.address, cs.usdc, c.vault);
  const units = usdcUnits(amount);
  const txs: TxRequest[] = [];
  if (input.kind === 'deposit') {
    if (w.balance < units) {
      throw new PerpError('INSUFFICIENT_BALANCE', `The wallet holds ${(Number(w.balance) / 1e6).toFixed(2)} ${perpCollateralSymbol()}.`, 400, 'amount');
    }
    if (w.allowance < units) {
      txs.push({
        to: cs.usdc,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [c.vault, units] }),
        value: '0',
        chainId: cs.chainId,
        label: `Approve ${perpCollateralSymbol()}`,
      });
    }
    txs.push({
      to: c.vault,
      data: encodeFunctionData({ abi: AGRI_VAULT_ABI, functionName: 'deposit', args: [units] }),
      value: '0',
      chainId: cs.chainId,
      label: `Deposit ${perpCollateralSymbol()}`,
    });
  } else {
    if (w.free < units) {
      throw new PerpError(
        'INSUFFICIENT_BALANCE',
        `Only ${(Number(w.free) / 1e6).toFixed(2)} ${perpCollateralSymbol()} is free; collateral backing open positions can't be withdrawn.`,
        400,
        'amount',
      );
    }
    txs.push({
      to: c.vault,
      data: encodeFunctionData({ abi: AGRI_VAULT_ABI, functionName: 'withdraw', args: [units] }),
      value: '0',
      chainId: cs.chainId,
      label: `Withdraw ${perpCollateralSymbol()}`,
    });
  }
  const id = newId();
  const expiresAt = new Date(Date.now() + PERP_QUOTE_TTL_SEC * 3000).toISOString();
  const quote: PerpCollateralQuote = {
    id,
    kind: input.kind,
    amount,
    address: user.address,
    venue,
    expiresAt,
    execution: { kind: 'transactions', txs },
  };
  await getPerpStore().insertAction({
    id,
    userId: user.id,
    address: user.address.toLowerCase(),
    kind: input.kind,
    venue,
    symbol: null,
    positionId: null,
    amount,
    status: 'quoted',
    quote,
    chainOrderId: null,
    txHash: null,
    txHashes: [],
    signature: null,
    error: null,
    expiresAt,
    checkedAt: null,
  });
  return quote;
}

export type PerpFaucetResult =
  | { kind: 'paper'; account: PerpAccount }
  | { kind: 'transactions'; txs: TxRequest[]; amount: number };

/**
 * Test USDC, dev only. Paper: credited straight to the virtual balance, up
 * to a cap. On chain: a mint transaction for the wallet to send — offered
 * only when the configured collateral token really is the mintable MockUSDC.
 */
export async function perpFaucet(user: PerpUser): Promise<PerpFaucetResult> {
  const venue = assertPerps();
  if (!isDev()) throw new PerpError('FORBIDDEN', 'Test USDC exists only on development builds.', 403);
  const amount = paperFaucetAmount();
  if (venue === 'paper') {
    const next = await getPerpStore().paperFaucet(user.id, amount, paperFaucetCap());
    if (next == null) {
      throw new PerpError('BAD_REQUEST', `This wallet already has the most test USDC the faucet gives (${paperFaucetCap().toLocaleString('en-US')}).`, 400, 'amount');
    }
    return { kind: 'paper', account: await perpAccount(user) };
  }
  const cs = await requireChain();
  if (!(await mintable(cs.usdc, user.address))) {
    throw new PerpError('FORBIDDEN', "The collateral token here isn't a test token, so there's no faucet.", 403);
  }
  return {
    kind: 'transactions',
    amount,
    txs: [
      {
        to: cs.usdc,
        data: encodeFunctionData({ abi: MOCK_USDC_ABI, functionName: 'mint', args: [user.address, usdcUnits(amount)] }),
        value: '0',
        chainId: cs.chainId,
        label: 'Mint test USDC',
      },
    ],
  };
}

const mintableCache = new Map<string, boolean>();
async function mintable(usdc: Address, who: Address): Promise<boolean> {
  const key = usdc.toLowerCase();
  const cached = mintableCache.get(key);
  if (cached != null) return cached;
  const ok = await chainClient()
    .simulateContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'mint', args: [who, 1n], account: who })
    .then(() => true)
    .catch(() => false);
  mintableCache.set(key, ok);
  return ok;
}

/* ------------------------------------------------------------------ */
/* Record                                                              */
/* ------------------------------------------------------------------ */

async function ownAction(user: PerpUser, actionId: string): Promise<PerpActionRow> {
  const action = await getPerpStore().getAction(actionId);
  if (!action || action.userId !== user.id) throw new PerpError('NOT_FOUND', 'Not found.', 404);
  if (action.address !== user.address.toLowerCase()) {
    throw new PerpError('ADDRESS_MISMATCH', 'This quote belongs to a different wallet address.', 409);
  }
  return action;
}

/**
 * After the user signs. A paper signature settles right here; a transaction
 * hash moves the action to `pending`, and from then on the server follows it
 * (the worker every few seconds, and any read of the action).
 */
export async function recordPerpAction(
  user: PerpUser,
  input: { actionId: string; signature?: Hex; txHash?: Hex; step?: number },
): Promise<PerpActionRecord> {
  assertPerps();
  const store = getPerpStore();
  const action = await ownAction(user, input.actionId);
  const quote = action.quote as PerpQuote | PerpCollateralQuote;

  if (quote.execution.kind === 'signature') {
    if (!input.signature) throw new PerpError('BAD_REQUEST', 'A signature is required.', 400);
    if (action.status !== 'quoted') throw new PerpError('CONFLICT', `This was already ${action.status}.`, 409);
    if (Date.now() > Date.parse(quote.expiresAt) + QUOTE_GRACE_MS) {
      await store.updateAction(action.id, { status: 'expired' }, ['quoted']);
      throw new PerpError('QUOTE_EXPIRED', 'The quote expired before it was signed. Get a fresh price.', 410);
    }
    if (!(await checkSignature(user.address, quote.execution.typedData, input.signature))) {
      throw new PerpError('BAD_REQUEST', "The signature doesn't match this quote.", 400);
    }
    if (action.kind === 'open') return toPerpActionRecord(await settlePaperOpen(action, quote as PerpOpenQuote, input.signature));
    if (action.kind === 'close') return toPerpActionRecord(await settlePaperClose(action, quote as PerpCloseQuote, input.signature));
    throw new PerpError('BAD_REQUEST', 'Nothing to sign here.', 400);
  }

  const hash = input.txHash;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new PerpError('BAD_REQUEST', 'A transaction hash is required.', 400);
  const txs = quote.execution.txs;
  const step = input.step ?? txs.length - 1;
  if (!Number.isInteger(step) || step < 0 || step >= txs.length) throw new PerpError('BAD_REQUEST', 'Unknown step.', 400);
  // Recorded even when the quote lapsed while the wallet was open: the
  // transaction is already out, and the contract's own bounds protect it.
  const hashes = action.txHashes.includes(hash) ? action.txHashes : [...action.txHashes, hash];
  if (step < txs.length - 1) {
    const updated = await store.updateAction(action.id, { txHashes: hashes }, ['quoted', 'expired']);
    if (!updated) throw new PerpError('CONFLICT', `This was already ${action.status}.`, 409);
    return toPerpActionRecord(updated);
  }
  const pending = await store.updateAction(action.id, { status: 'pending', txHash: hash, txHashes: hashes }, ['quoted', 'expired', 'pending']);
  if (!pending) throw new PerpError('CONFLICT', `This was already ${action.status}.`, 409);
  return toPerpActionRecord(pending);
}

async function failAction(action: PerpActionRow, error: string): Promise<PerpActionRow> {
  return (await getPerpStore().updateAction(action.id, { status: 'failed', error }, ['quoted'])) ?? action;
}

async function settlePaperOpen(action: PerpActionRow, quote: PerpOpenQuote, signature: Hex): Promise<PerpActionRow> {
  const store = getPerpStore();
  const def = perpMarket(quote.symbol);
  const mark = await perpMarkFor(quote.symbol);
  if (!def || !mark?.fresh) {
    return failAction(action, `The ${quote.symbol} price went stale before it could fill (the market may have closed). Nothing was opened.`);
  }
  const acceptable = quote.side === 'long' ? mark.price <= quote.acceptablePrice : mark.price >= quote.acceptablePrice;
  if (!acceptable) {
    return failAction(action, `The price moved past your ${(quote.slippageBps / 100).toFixed(2)}% limit before it filled. Nothing was opened.`);
  }
  const state = mark.state;
  const sideOi = quote.side === 'long' ? state.longOi : state.shortOi;
  if (sideOi + quote.size > state.maxOi + EPS) {
    return failAction(action, `${quote.symbol} reached its open-interest cap before this filled. Nothing was opened.`);
  }
  const result = await store.paperOpen({
    actionId: action.id,
    signature,
    debit: round6(quote.collateral + quote.fee),
    position: {
      userId: action.userId,
      address: action.address,
      venue: 'paper',
      chainId: null,
      chainPositionId: null,
      symbol: quote.symbol,
      category: def.category,
      side: quote.side,
      collateral: quote.collateral,
      size: quote.size,
      leverage: quote.leverage,
      entryPrice: mark.price,
      entryIndex: mark.index,
      entryFunding: fundingIndexAt(state),
      reserve: round6(perpReserve(quote.collateral, quote.size, perpMaxProfitMultiple())),
      fee: quote.fee,
      status: 'open',
      exitPrice: null,
      exitIndex: null,
      realizedPnl: null,
      fundingPaid: null,
      payout: null,
      liquidationReward: null,
      txOpen: null,
      txClose: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
    },
  });
  if (result === 'insufficient') {
    return failAction(action, 'Not enough free collateral when it came to fill. Nothing was opened.');
  }
  if (result === 'conflict') throw new PerpError('CONFLICT', 'This quote changed while signing.', 409);
  return (await store.getAction(action.id)) ?? action;
}

async function settlePaperClose(action: PerpActionRow, quote: PerpCloseQuote, signature: Hex): Promise<PerpActionRow> {
  const store = getPerpStore();
  const row = await store.getPosition(quote.positionId);
  if (!row || row.status !== 'open') return failAction(action, `The position was already ${row?.status ?? 'gone'}.`);
  const mark = await perpMarkFor(row.symbol);
  if (!mark?.fresh) return failAction(action, `The ${row.symbol} price went stale before it could close. Nothing changed.`);
  const acceptable = row.side === 'long' ? mark.price >= quote.acceptablePrice : mark.price <= quote.acceptablePrice;
  if (!acceptable) {
    return failAction(action, `The price moved past your ${(quote.slippageBps / 100).toFixed(2)}% limit before it closed. Nothing changed.`);
  }
  const pnl = perpPricePnl({
    side: row.side,
    size: row.size,
    collateral: row.collateral,
    entry: row.entryIndex,
    mark: mark.index,
    maxProfitMultiple: row.reserve / row.collateral,
  });
  const funding = fundingOwed(row, fundingIndexAt(mark.state));
  const gross = Math.min(perpPayout({ collateral: row.collateral, pnl, fundingOwed: funding }), row.collateral + row.reserve);
  const fee = Math.min(gross, (row.size * quote.feeBps) / 10_000);
  const payout = round6(gross - fee);
  const settled = await store.paperSettle({
    positionId: row.id,
    patch: {
      status: 'closed',
      exitPrice: mark.price,
      exitIndex: mark.index,
      realizedPnl: round6(payout - row.collateral),
      fundingPaid: round6(funding),
      payout,
      closedAt: new Date().toISOString(),
    },
    payout,
    action: { id: action.id, signature },
  });
  if (!settled) return failAction(action, 'The position changed while closing (it may have been liquidated).');
  return (await store.getAction(action.id)) ?? action;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function toPerpActionRecord(a: PerpActionRow): PerpActionRecord {
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    venue: a.venue,
    symbol: a.symbol,
    positionId: a.positionId,
    amount: a.amount,
    error: a.error,
    txHash: a.txHash,
    explorerUrl: explorerTx(a.txHash),
    awaitingExecution: a.status === 'pending' && a.chainOrderId != null,
    // The contract has the last word (a round may be out already); the cancel quote checks.
    cancellable: a.status === 'pending' && a.chainOrderId != null && (a.kind === 'open' || a.kind === 'close') && !a.cancelRequestedAt,
    cancelRequestedAt: a.cancelRequestedAt ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** A stored position, marked to the current price when it's open. */
export function toPerpPosition(
  row: PerpPositionRow,
  ctx: { mark?: Mark | null; state?: MarketState | null; threshold: number; closing?: boolean },
): PerpPosition {
  const state = ctx.mark?.state ?? ctx.state ?? null;
  // Today's terms: the contract month traded now, prices since any split.
  const factor = state?.rollFactor ?? 1;
  const open = row.status === 'open';
  const funding = open && state ? fundingOwed(row, fundingIndexAt(state)) : (row.fundingPaid ?? 0);
  const pnl =
    open && ctx.mark
      ? perpPricePnl({
          side: row.side,
          size: row.size,
          collateral: row.collateral,
          entry: row.entryIndex,
          mark: ctx.mark.index,
          maxProfitMultiple: row.reserve / row.collateral,
        })
      : null;
  const entryPrice = open ? row.entryIndex / factor : row.entryPrice;
  const equity = pnl == null ? null : row.collateral + pnl - funding;
  return {
    id: row.id,
    venue: row.venue,
    chainPositionId: row.chainPositionId,
    symbol: row.symbol,
    category: row.category,
    side: row.side,
    collateral: row.collateral,
    size: row.size,
    leverage: row.leverage,
    entryPrice,
    markPrice: open ? (ctx.mark?.price ?? null) : row.exitPrice,
    liquidationPrice: perpLiquidationPrice({
      side: row.side,
      entry: entryPrice,
      collateral: row.collateral,
      size: row.size,
      fundingOwed: funding,
      threshold: ctx.threshold,
    }),
    unrealizedPnl: pnl,
    fundingAccrued: funding,
    equity,
    pnlPct: open ? (equity == null ? null : ((equity - row.collateral) / row.collateral) * 100) : row.realizedPnl == null ? null : (row.realizedPnl / row.collateral) * 100,
    fee: row.fee,
    status: row.status,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    exitPrice: row.exitPrice,
    realizedPnl: row.realizedPnl,
    fundingPaid: row.fundingPaid,
    payout: row.payout,
    txOpen: row.txOpen,
    txClose: row.txClose,
    explorerOpen: explorerTx(row.txOpen),
    explorerClose: explorerTx(row.txClose),
    closing: Boolean(ctx.closing),
  };
}

async function thresholdFor(venue: PerpVenueId): Promise<number> {
  if (venue !== 'agri-perp') return PERP_LIQUIDATION_THRESHOLD;
  const cs = await chainState();
  return cs ? cs.params.liquidationThresholdBps / 10_000 : PERP_LIQUIDATION_THRESHOLD;
}

export async function perpPositions(user: PerpUser): Promise<PerpPosition[]> {
  const venue = perpsVenue();
  if (!venue) return [];
  const store = getPerpStore();
  const [rows, allMarks, states, threshold, closing] = await Promise.all([
    store.listPositions({ address: user.address, venue, statuses: ['open'], limit: 200 }),
    perpMarks(),
    perpMarketStates(),
    thresholdFor(venue),
    store.listActions({ userId: user.id, statuses: ['pending'], kinds: ['close'], limit: 50 }),
  ]);
  const closingIds = new Set(closing.map((a) => a.positionId));
  return rows.map((row) =>
    toPerpPosition(row, { mark: allMarks.get(row.symbol), state: states.get(row.symbol), threshold, closing: closingIds.has(row.id) }),
  );
}

export async function perpHistory(user: PerpUser, opts: { page: number; limit: number }): Promise<PerpPosition[]> {
  const venue = perpsVenue();
  if (!venue) return [];
  const threshold = await thresholdFor(venue);
  const rows = await getPerpStore().listPositions({
    address: user.address,
    venue,
    statuses: ['closed', 'liquidated'],
    orderBy: 'closed',
    limit: opts.limit,
    offset: (opts.page - 1) * opts.limit,
  });
  return rows.map((row) => toPerpPosition(row, { threshold }));
}

export async function perpAccount(user: PerpUser): Promise<PerpAccount> {
  const venue = perpsVenue();
  const empty: PerpAccount = {
    venue,
    free: 0,
    locked: 0,
    unrealizedPnl: 0,
    equity: 0,
    openPositions: 0,
    walletUsdc: null,
    canFaucet: false,
    collateralSymbol: perpCollateralSymbol(),
  };
  if (!venue) return empty;
  const positions = await perpPositions(user);
  const locked = positions.reduce((s, p) => s + p.collateral, 0);
  const unrealized = positions.reduce((s, p) => s + (p.equity == null ? 0 : p.equity - p.collateral), 0);

  if (venue === 'paper') {
    const account = await getPerpStore().getPaperAccount(user.id);
    return {
      ...empty,
      free: account.free,
      locked: round6(locked),
      unrealizedPnl: round6(unrealized),
      equity: round6(account.free + locked + unrealized),
      openPositions: positions.length,
      canFaucet: isDev() && account.faucetTotal + paperFaucetAmount() <= paperFaucetCap(),
    };
  }
  const c = contracts();
  const cs = await requireChain();
  const w = await walletReads(user.address, cs.usdc, c.vault);
  const free = Number(w.free) / 1e6;
  return {
    ...empty,
    free,
    locked: round6(locked),
    unrealizedPnl: round6(unrealized),
    equity: round6(free + locked + unrealized),
    openPositions: positions.length,
    walletUsdc: Number(w.balance) / 1e6,
    canFaucet: isDev() && (await mintable(cs.usdc, user.address)),
  };
}

/**
 * The wallet's on-chain orders still waiting for their Chainlink round —
 * which can be hours on a quiet feed, so the page lists them after a reload,
 * each with the way to take it back.
 */
export async function perpWaitingOrders(user: PerpUser, check?: (a: PerpActionRow) => Promise<unknown>): Promise<PerpWaitingOrder[]> {
  if (perpsVenue() !== 'agri-perp') return [];
  const store = getPerpStore();
  const query = { userId: user.id, statuses: ['pending' as const], kinds: ['open' as const, 'close' as const], limit: 50 };
  let rows = await store.listActions(query);
  if (check && rows.length) {
    await Promise.all(rows.map((a) => check(a).catch((err) => console.warn(`[perps] check ${a.id}: ${(err as Error).message}`))));
    rows = await store.listActions(query);
  }
  return rows.flatMap((a) => {
    const q = a.quote as PerpQuote | null;
    if (a.chainOrderId == null || a.address !== user.address.toLowerCase() || !q || (q.action !== 'open' && q.action !== 'close')) return [];
    return [
      {
        ...toPerpActionRecord(a),
        kind: q.action,
        symbol: q.symbol,
        side: q.side,
        collateral: q.collateral,
        leverage: q.action === 'open' ? q.leverage : Math.round(q.size / q.collateral),
        size: q.size,
        acceptablePrice: q.acceptablePrice,
      },
    ];
  });
}

/** One action, for the page to poll while a transaction is on its way. */
export async function perpAction(user: PerpUser, actionId: string, check?: (a: PerpActionRow) => Promise<unknown>): Promise<PerpActionRecord> {
  let action = await ownAction(user, actionId);
  if (action.status === 'pending' && check) {
    await check(action).catch((err) => console.warn(`[perps] check ${action.id}: ${(err as Error).message}`));
    action = (await getPerpStore().getAction(action.id)) ?? action;
  }
  return toPerpActionRecord(action);
}
