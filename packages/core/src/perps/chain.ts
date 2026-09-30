import { getCache } from '@robinchan/store';
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

import { publicClient } from '../chain';
import { AGRI_FEED_ABI, AGRI_PERP_ABI, AGRI_VAULT_ABI } from './abi';
import { agriPerpContracts } from './config';
import { PerpError } from './errors';
import { perpKey, perpNetwork, tradableHere } from './network';

/**
 * The on-chain venue's reads. The server reads the contracts and builds
 * transactions for the user's wallet to send; it never signs for a user.
 * (The optional keeper key only calls the contracts' permissionless
 * functions — see keeper.ts.)
 */

export const marketKey = (symbol: string): Hex => keccak256(toBytes(symbol));

const WAD = 1e18;
const USDC = 1e6;

export type ChainParams = {
  openFeeBps: number;
  closeFeeBps: number;
  liquidationThresholdBps: number;
  liquidatorRewardBps: number;
  minLiquidationRewardBps: number;
  maxProfitBps: number;
  /** Orders fill at the first round published this many seconds after the request… */
  minExecutionDelay: number;
  /** …which must come within this many seconds. */
  maxExecutionDelay: number;
  liquidationPriceAge: number;
  /** A request needs a round no older than this, seconds. */
  requestPriceAge: number;
  minCollateral: number;
  /** Wei, as a decimal string (the cache is JSON). */
  minExecutionFee: string;
  nextOrderId: number;
};

export type ChainMarket = {
  symbol: string;
  listed: boolean;
  enabled: boolean;
  /** The feed died: positions settle at `settlementPrice` (the keeper settles them). */
  delisted: boolean;
  settlementPrice: number | null;
  maxLeverage: number;
  /** Fraction of size per hour; positive = longs pay. */
  fundingRatePerHour: number;
  fundingIndex: number;
  /** ms */
  fundingUpdatedAt: number;
  longOi: number;
  shortOi: number;
  maxOi: number;
  /** The Chainlink feed (proxy) AgriFeed reads for this market — a MockAggregator on a local chain. */
  feed: Hex;
};

export type ChainState = {
  chainId: number;
  usdc: Address;
  params: ChainParams;
  markets: Record<string, ChainMarket>;
  pool: { balance: number; reserved: number; available: number };
  readAt: number;
};

function contracts() {
  const c = agriPerpContracts();
  if (!c) throw new PerpError('NOT_CONFIGURED', 'The AgriPerp contract addresses are not configured.', 503);
  return c;
}

function client() {
  const c = publicClient();
  if (!c) throw new PerpError('NOT_CONFIGURED', 'No chain is configured.', 503);
  return c;
}

type Read = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/**
 * Many reads in one round trip when Multicall3 exists on the chain, one by
 * one when it doesn't (a fresh local node has none).
 */
async function readAll(reads: Read[]): Promise<unknown[]> {
  const c = client();
  try {
    return await c.multicall({ contracts: reads as never, allowFailure: false });
  } catch {
    return Promise.all(reads.map((r) => c.readContract(r as never)));
  }
}

const PERP_PARAMS = [
  'openFeeBps',
  'closeFeeBps',
  'liquidationThresholdBps',
  'liquidatorRewardBps',
  'minLiquidationRewardBps',
  'maxProfitBps',
  'minExecutionDelay',
  'maxExecutionDelay',
  'liquidationPriceAge',
  'requestPriceAge',
  'minCollateral',
  'minExecutionFee',
  'nextOrderId',
] as const;

export async function readChainState(): Promise<ChainState> {
  const { perp, vault, feed } = contracts();
  const c = client();
  const symbols = tradableHere().map((m) => m.symbol);
  const head: Read[] = [
    ...PERP_PARAMS.map((functionName) => ({ address: perp, abi: AGRI_PERP_ABI as Abi, functionName })),
    { address: vault, abi: AGRI_VAULT_ABI, functionName: 'usdc' },
    { address: vault, abi: AGRI_VAULT_ABI, functionName: 'poolBalance' },
    { address: vault, abi: AGRI_VAULT_ABI, functionName: 'reservedLiquidity' },
  ];
  const perMarket: Read[] = symbols.flatMap((s) => [
    { address: perp, abi: AGRI_PERP_ABI, functionName: 'markets', args: [marketKey(s)] },
    { address: feed, abi: AGRI_FEED_ABI, functionName: 'feedOf', args: [marketKey(s)] },
  ]);
  const [chainId, results] = await Promise.all([c.getChainId(), readAll([...head, ...perMarket])]);
  const p = results.slice(0, PERP_PARAMS.length) as bigint[];
  const [usdc, poolBalance, reserved] = results.slice(PERP_PARAMS.length, head.length) as [Address, bigint, bigint];

  const markets: Record<string, ChainMarket> = {};
  symbols.forEach((symbol, i) => {
    const at = head.length + i * 2;
    // listed, enabled, delisted, maxLeverage, fundingUpdatedAt, fundingRatePerHour, fundingIndex,
    // longOi, shortOi, maxOi, settlementPrice, settlementIndex
    const m = results[at] as readonly [boolean, boolean, boolean, number, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    const f = results[at + 1] as readonly [Hex, number, boolean];
    markets[symbol] = {
      symbol,
      listed: m[0] && f[2],
      enabled: m[1],
      delisted: m[2],
      settlementPrice: m[2] ? Number(m[10]) / WAD : null,
      maxLeverage: Number(m[3]),
      fundingUpdatedAt: Number(m[4]) * 1000,
      fundingRatePerHour: Number(m[5]) / WAD,
      fundingIndex: Number(m[6]) / WAD,
      longOi: Number(m[7]) / USDC,
      shortOi: Number(m[8]) / USDC,
      maxOi: Number(m[9]) / USDC,
      feed: f[0].toLowerCase() as Hex,
    };
  });

  return {
    chainId,
    usdc,
    params: {
      openFeeBps: Number(p[0]),
      closeFeeBps: Number(p[1]),
      liquidationThresholdBps: Number(p[2]),
      liquidatorRewardBps: Number(p[3]),
      minLiquidationRewardBps: Number(p[4]),
      maxProfitBps: Number(p[5]),
      minExecutionDelay: Number(p[6]),
      maxExecutionDelay: Number(p[7]),
      liquidationPriceAge: Number(p[8]),
      requestPriceAge: Number(p[9]),
      minCollateral: Number(p[10]) / USDC,
      minExecutionFee: (p[11] as bigint).toString(),
      nextOrderId: Number(p[12]),
    },
    markets,
    pool: {
      balance: Number(poolBalance) / USDC,
      reserved: Number(reserved) / USDC,
      available: Number(poolBalance - reserved) / USDC,
    },
    readAt: Date.now(),
  };
}

/** Per network: the read in flight, shared by everyone who asks meanwhile. */
const refreshing = new Map<string, Promise<ChainState | null>>();

/**
 * The contract state, cached for everyone: the worker refreshes it on its
 * schedule, and a reader that finds it older than `maxAgeSec` refreshes it
 * once (concurrent readers share that one read). A failed refresh serves the
 * last good copy rather than nothing.
 */
export async function chainState(opts: { maxAgeSec?: number } = {}): Promise<ChainState | null> {
  const key = perpKey('perp', 'chain');
  const network = perpNetwork();
  const hit = await getCache()
    .getWithAge<ChainState>(key)
    .catch(() => null);
  if (hit && hit.ageSec <= (opts.maxAgeSec ?? 20)) return hit.value;
  let read = refreshing.get(network);
  if (!read) {
    read = readChainState()
      .then(async (state) => {
        await getCache().set(key, state, 60);
        return state;
      })
      .catch((err) => {
        console.warn(`[perps] ${network} chain state unavailable: ${(err as Error).message}`);
        return null;
      })
      .finally(() => {
        refreshing.delete(network);
      });
    refreshing.set(network, read);
  }
  return (await read) ?? hit?.value ?? null;
}

/**
 * The chain's clock, UNIX seconds: the wall clock, or the latest block's
 * time when that's ahead — a dev node that mines a burst of transactions
 * runs ahead of the wall (every block needs a later timestamp than the
 * last), and the contracts' deadlines run on block time.
 */
export async function chainNow(): Promise<number> {
  const wall = Math.floor(Date.now() / 1000);
  const block = await client()
    .getBlock({ blockTag: 'latest' })
    .catch(() => null);
  return block ? Math.max(wall, Number(block.timestamp)) : wall;
}

/* ------------------------------------------------------------------ */
/* Reverts, in words                                                   */
/* ------------------------------------------------------------------ */

const ERRORS_ABI = [...AGRI_PERP_ABI, ...AGRI_VAULT_ABI, ...AGRI_FEED_ABI].filter((x) => x.type === 'error') as Abi;

const REVERT_TEXT: Record<string, string> = {
  StalePrice: "The market's Chainlink feed hasn't published for over a day (the market may be shut), so nothing happened.",
  BadPrice: 'The Chainlink feed reported an impossible price, so nothing happened.',
  RoundNotFound: "That Chainlink round doesn't exist.",
  RoundOutOfWindow: "That Chainlink round isn't in the order's window.",
  NotFirstRound: "That isn't the first Chainlink round after the order.",
  ObservedBeforeRequest: 'That Chainlink price was observed before the order was placed, so it can’t fill it.',
  NotLatestRound: "That isn't the feed's latest round.",
  WrongPhase: "That Chainlink round belongs to another aggregator than the order's.",
  FeedUpgraded: "Chainlink moved the market's feed to a new aggregator: the order can only be cancelled now.",
  NotYourOrder: 'Only the trader who placed an order can ask for it back.',
  AcceptablePriceTooTight: 'The price already moved past the limit. Get a fresh quote.',
  InsufficientFreeCollateral: "There wasn't enough free collateral in the vault for this.",
  OpenInterestCapReached: "The market's open-interest cap filled first. Try a smaller position.",
  MarketIsDelisted: 'This market was delisted (its feed stopped): positions settle at its last price, no close needed.',
  OrderNotPending: 'That order was already executed or cancelled.',
  TooEarlyToCancel: 'Not yet: an order asked back is released five minutes after the ask, and one nobody priced once its 25-hour window has passed.',
  PriceAlreadyOut: "The price this order settles at is already out, so it can't be taken back — it executes in a moment.",
  InsufficientPoolLiquidity: "The pool couldn't reserve enough liquidity for a position this size.",
  MarketDisabled: 'This market is paused: positions can be closed, not opened.',
  MarketNotListed: "This market isn't listed on the contract.",
  PositionNotOpen: 'That position is already closed.',
  NotPositionOwner: 'That position belongs to another wallet.',
  CloseAlreadyPending: 'A close for this position is already waiting to execute.',
  InvalidLeverage: "That leverage isn't allowed on this market.",
  CollateralTooSmall: 'The collateral is below the minimum.',
  FeeAboveMax: 'The opening fee was raised after the quote. Get a fresh quote.',
  ExecutionFeeTooSmall: 'The execution fee sent was too small.',
};

export function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (reverted?.data?.errorName) return reverted.data.errorName;
  const raw = err.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null;
  if (raw?.data && raw.data.length >= 10) {
    try {
      return decodeErrorResult({ abi: ERRORS_ABI, data: raw.data }).errorName;
    } catch {
      return null;
    }
  }
  return null;
}

export function revertText(name: string | null): string {
  return (name && REVERT_TEXT[name]) || 'The transaction reverted on chain. Nothing changed except the network fee.';
}

/** Why a mined transaction reverted: replay it at its block to get the revert data. */
export async function explainRevert(tx: { from: Address; to: Address | null; input: Hex; value: bigint; blockNumber: bigint | null }): Promise<string> {
  if (!tx.to) return revertText(null);
  try {
    await client().call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      blockNumber: tx.blockNumber != null && tx.blockNumber > 0n ? tx.blockNumber - 1n : undefined,
    });
    return revertText(null);
  } catch (err) {
    const data = (err as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk?.(
      (e) => typeof (e as { data?: unknown }).data === 'string',
    ) as { data?: Hex } | null;
    if (data?.data && data.data.length >= 10) {
      try {
        return revertText(decodeErrorResult({ abi: ERRORS_ABI, data: data.data }).errorName);
      } catch {
        /* unknown error */
      }
    }
    return revertText(revertName(err));
  }
}
