import type { Address, OrderExecution, OrderIntent, OrderTypedData, TxRequest } from '@robinchan/shared';
import type { OrderRow } from '@robinchan/store';
import {
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  formatUnits,
  parseAbiItem,
  parseUnits,
  toHex,
  type TransactionReceipt,
} from 'viem';

import { ERC20_ABI, publicClient } from '../chain';
import { chainConfig, paperOnchain, venueId, type VenueId } from '../env';
import { getPrice } from '../prices';
import { quoteToken, tokenRegistry } from '../tokens';
import { OrderError } from './errors';

/**
 * Execution venues (main brief open decision #4: which DEX, which ABI).
 *
 * A venue turns an order intent into something the user signs — a
 * transaction or EIP-712 typed data — and, once it's on chain, says what
 * price it actually filled at. The server never signs anything itself.
 */
export type VenueQuoteInput = {
  orderId: string;
  intent: OrderIntent;
  address: Address;
  /** Latest cached market price. */
  marketPrice: number;
  slippageBps: number;
  expiresAt: string;
};

export type VenueQuote = {
  estPrice: number;
  /** Network fee estimate in the native token; 0 when nothing is sent on chain. */
  gasNative: number;
  execution: OrderExecution;
};

export type Settlement = { ok: true; fillPrice: number } | { ok: false; error: string };

export interface Venue {
  id: VenueId;
  /** Can this venue hold a resting limit order? (open decisions #1/#2) */
  supportsLimit: boolean;
  quote(input: VenueQuoteInput): Promise<VenueQuote>;
  /** Price a mined, successful transaction actually filled at. */
  settle(order: OrderRow, receipt: TransactionReceipt): Promise<Settlement>;
}

export function getVenue(): Venue | null {
  const id = venueId();
  if (id === 'paper') return paperVenue;
  if (id === 'uniswap-v3') return uniswapVenue;
  return null;
}

/** The quote's slippage bound, applied to a price observed at fill time. */
export function withinSlippage(side: OrderIntent['side'], quoted: number, actual: number, bps: number): boolean {
  const tolerance = bps / 10_000;
  return side === 'buy' ? actual <= quoted * (1 + tolerance) : actual >= quoted * (1 - tolerance);
}

/** A decimal string for `parseUnits` — `Number#toString` would give "1e-7" for tiny values. */
function decimalString(value: number, decimals: number): string {
  return value.toFixed(Math.min(decimals, 18)).replace(/\.?0+$/, '') || '0';
}

/* ------------------------------------------------------------------ */
/* Paper — dev only                                                    */
/* ------------------------------------------------------------------ */

export const ORDER_TYPES: OrderTypedData['types'] = {
  Order: [
    { name: 'orderId', type: 'string' },
    { name: 'side', type: 'string' },
    { name: 'symbol', type: 'string' },
    { name: 'qty', type: 'string' },
    { name: 'orderType', type: 'string' },
    { name: 'price', type: 'string' },
    { name: 'maxSlippageBps', type: 'string' },
    { name: 'venue', type: 'string' },
    { name: 'expiresAt', type: 'string' },
    { name: 'maker', type: 'address' },
  ],
};

/**
 * The dev venue, refused outside `RC_ENV=dev`. Nothing moves: a market
 * order fills against the cached price the moment its signature checks out;
 * a limit order rests until the watcher sees its price.
 *
 * By default the user signs EIP-712 typed data — a real wallet signature,
 * free, no test funds needed. With `RC_PAPER_ONCHAIN=true` a market order is
 * instead a real zero-value transaction to the user's own address, so the
 * whole transaction lifecycle (pending, stuck, sped up, cancelled) can be
 * exercised on a testnet.
 */
const paperVenue: Venue = {
  id: 'paper',
  supportsLimit: true,

  async quote(input) {
    const chainId = chainConfig()?.id ?? 0;
    const { intent } = input;
    const price = intent.orderType === 'limit' ? (intent.limitPrice as number) : input.marketPrice;

    if (intent.orderType === 'limit' || !paperOnchain()) {
      const typedData: OrderTypedData = {
        domain: { name: 'Robinchan', version: '1', chainId },
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: {
          orderId: input.orderId,
          side: intent.side,
          symbol: intent.symbol,
          qty: String(intent.qty),
          orderType: intent.orderType,
          price: String(price),
          maxSlippageBps: String(input.slippageBps),
          venue: 'paper',
          expiresAt: input.expiresAt,
          maker: input.address,
        },
      };
      return { estPrice: price, gasNative: 0, execution: { kind: 'signature', typedData } };
    }

    const tx: TxRequest = {
      to: input.address,
      data: toHex(`robinchan:order:${input.orderId}`),
      value: '0',
      chainId,
      label: 'Paper order (moves nothing)',
    };
    return { estPrice: price, gasNative: await estimateGasNative([tx], input.address), execution: { kind: 'transactions', txs: [tx] } };
  },

  async settle(order) {
    const live = await getPrice(order.symbol);
    if (!live) return { ok: false, error: 'No price was available when the transaction confirmed.' };
    const quoted = order.quotePrice ?? live.price;
    if (!withinSlippage(order.side, quoted, live.price, order.slippageBps ?? 50)) {
      return {
        ok: false,
        error: `The price moved beyond your ${((order.slippageBps ?? 50) / 100).toFixed(2)}% slippage limit before the transaction confirmed, so nothing was filled.`,
      };
    }
    return { ok: true, fillPrice: live.price };
  },
};

async function estimateGasNative(txs: TxRequest[], from: Address): Promise<number> {
  const client = publicClient();
  if (!client) return 0;
  try {
    const [gasPrice, ...units] = await Promise.all([
      client.getGasPrice(),
      ...txs.map((tx) =>
        client.estimateGas({ account: from, to: tx.to, data: tx.data, value: BigInt(tx.value) }),
      ),
    ]);
    const total = units.reduce((sum, u) => sum + u, 0n);
    return Number(formatEther(total * gasPrice));
  } catch {
    // Estimation failing shouldn't block a paper order; assume a plain
    // transfer at 0.1 gwei so the gas line still shows an order of magnitude.
    return Number(formatEther(30_000n * 100_000_000n * BigInt(txs.length)));
  }
}

/* ------------------------------------------------------------------ */
/* Uniswap v3 (SwapRouter02 + QuoterV2)                                */
/* ------------------------------------------------------------------ */

const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'quoteExactOutputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const SWAP_PARAMS_IN = [
  { name: 'tokenIn', type: 'address' },
  { name: 'tokenOut', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMinimum', type: 'uint256' },
  { name: 'sqrtPriceLimitX96', type: 'uint160' },
] as const;

const SWAP_PARAMS_OUT = [
  { name: 'tokenIn', type: 'address' },
  { name: 'tokenOut', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'recipient', type: 'address' },
  { name: 'amountOut', type: 'uint256' },
  { name: 'amountInMaximum', type: 'uint256' },
  { name: 'sqrtPriceLimitX96', type: 'uint160' },
] as const;

const SWAP_ROUTER_02_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: SWAP_PARAMS_IN }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'exactOutputSingle',
    stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: SWAP_PARAMS_OUT }],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [
      { name: 'deadline', type: 'uint256' },
      { name: 'data', type: 'bytes[]' },
    ],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

function uniswapConfig(): { router: Address; quoter: Address; fee: number } | null {
  const router = process.env.RC_UNIV3_ROUTER?.trim();
  const quoter = process.env.RC_UNIV3_QUOTER?.trim();
  const fee = Number(process.env.RC_UNIV3_FEE ?? 3000);
  const addr = /^0x[0-9a-fA-F]{40}$/;
  if (!router || !quoter || !addr.test(router) || !addr.test(quoter) || !Number.isInteger(fee)) return null;
  return { router: router as Address, quoter: quoter as Address, fee };
}

/**
 * Exact-output buys and exact-input sells against one fee tier, priced in
 * the settlement stablecoin (`RC_QUOTE_TOKEN`). Slippage protection lives
 * in the calldata (`amountInMaximum` / `amountOutMinimum`) and a deadline
 * wraps the call, so the contract refuses a fill outside the quote's terms
 * even if the transaction sits in the mempool (Trade §4).
 *
 * No resting orders: a limit order needs either an on-chain primitive or a
 * keeper holding the user's pre-signed order, and neither exists here yet.
 */
const uniswapVenue: Venue = {
  id: 'uniswap-v3',
  supportsLimit: false,

  async quote(input) {
    const cfg = uniswapConfig();
    const client = publicClient();
    const chain = chainConfig();
    const token = tokenRegistry().get(input.intent.symbol);
    const usdc = quoteToken();
    if (!cfg || !client || !chain || !token || !usdc) {
      throw new OrderError(
        'NOT_CONFIGURED',
        'The swap venue is not fully configured (router, quoter, token contracts).',
        503,
      );
    }

    const { intent } = input;
    const qtyUnits = parseUnits(decimalString(intent.qty, token.decimals), token.decimals);
    const slip = BigInt(input.slippageBps);
    let estPrice: number;
    let gasEstimate: bigint;
    let swapData: `0x${string}`;
    let spend: { token: Address; symbol: string; amount: bigint };

    try {
      if (intent.side === 'buy') {
        const { result } = await client.simulateContract({
          address: cfg.quoter,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactOutputSingle',
          args: [{ tokenIn: usdc.address, tokenOut: token.address, amount: qtyUnits, fee: cfg.fee, sqrtPriceLimitX96: 0n }],
        });
        const [amountIn, , , gas] = result;
        estPrice = Number(formatUnits(amountIn, usdc.decimals)) / intent.qty;
        gasEstimate = gas;
        const maxIn = (amountIn * (10_000n + slip)) / 10_000n;
        swapData = encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: 'exactOutputSingle',
          args: [{ tokenIn: usdc.address, tokenOut: token.address, fee: cfg.fee, recipient: input.address, amountOut: qtyUnits, amountInMaximum: maxIn, sqrtPriceLimitX96: 0n }],
        });
        spend = { token: usdc.address, symbol: usdc.symbol, amount: maxIn };
      } else {
        const { result } = await client.simulateContract({
          address: cfg.quoter,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: token.address, tokenOut: usdc.address, amountIn: qtyUnits, fee: cfg.fee, sqrtPriceLimitX96: 0n }],
        });
        const [amountOut, , , gas] = result;
        estPrice = Number(formatUnits(amountOut, usdc.decimals)) / intent.qty;
        gasEstimate = gas;
        const minOut = (amountOut * (10_000n - slip)) / 10_000n;
        swapData = encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: 'exactInputSingle',
          args: [{ tokenIn: token.address, tokenOut: usdc.address, fee: cfg.fee, recipient: input.address, amountIn: qtyUnits, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
        });
        spend = { token: token.address, symbol: token.symbol, amount: qtyUnits };
      }
    } catch {
      throw new OrderError('UPSTREAM_DOWN', 'The venue could not price this order right now. Try again shortly.', 503);
    }

    // The deadline: past the quote's validity plus a margin for a slow
    // confirmation, after which the router reverts instead of filling.
    const deadline = BigInt(Math.floor(Date.parse(input.expiresAt) / 1000) + 600);
    const data = encodeFunctionData({ abi: SWAP_ROUTER_02_ABI, functionName: 'multicall', args: [deadline, [swapData]] });

    const allowance = await client
      .readContract({ address: spend.token, abi: ERC20_ABI, functionName: 'allowance', args: [input.address, cfg.router] })
      .catch(() => 0n);
    const txs: TxRequest[] = [];
    if (allowance < spend.amount) {
      txs.push({
        to: spend.token,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [cfg.router, spend.amount] }),
        value: '0',
        chainId: chain.id,
        label: `Approve ${spend.symbol}`,
      });
    }
    txs.push({ to: cfg.router, data, value: '0', chainId: chain.id, label: 'Swap' });

    const gasPrice = await client.getGasPrice().catch(() => 100_000_000n);
    const units = gasEstimate + 80_000n + (txs.length > 1 ? 55_000n : 0n);
    return {
      estPrice,
      gasNative: Number(formatEther(units * gasPrice)),
      execution: { kind: 'transactions', txs },
    };
  },

  async settle(order, receipt) {
    const usdc = quoteToken();
    if (!usdc) return { ok: false, error: 'Settlement token is not configured.' };
    const user = order.address.toLowerCase();
    let amount = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== usdc.address.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
        const { from, to, value } = ev.args as { from: string; to: string; value: bigint };
        if (order.side === 'buy' && from.toLowerCase() === user) amount += value;
        if (order.side === 'sell' && to.toLowerCase() === user) amount += value;
      } catch {
        /* not a Transfer */
      }
    }
    if (amount === 0n) return { ok: false, error: 'The swap confirmed but no settlement transfer was found.' };
    return { ok: true, fillPrice: Number(formatUnits(amount, usdc.decimals)) / order.qty };
  },
};
