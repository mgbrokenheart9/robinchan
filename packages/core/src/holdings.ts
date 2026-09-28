import { createHash } from 'node:crypto';

import type { Address } from '@robinchan/shared';
import { SYMBOL_NAMES, WATCHED_SYMBOLS, symbolInfo } from '@robinchan/shared';
import { cacheKey, getCache, getDb } from '@robinchan/store';
import { formatUnits } from 'viem';

import { ERC20_ABI, publicClient } from './chain';
import { chainConfig, isDev } from './env';
import { quoteToken, tokenRegistry, type TokenInfo } from './tokens';

/**
 * What a wallet holds. Robinchan is non-custodial, so this is always read
 * from the chain — never from our own records of what the user "should"
 * have (Portfolio §8).
 *
 * In `RC_ENV=dev`, with no token contracts configured yet, a deterministic
 * sample wallet stands in (flagged `source: 'fixture'`), with paper-venue
 * fills applied on top so buying through Robinchan visibly changes it.
 */
export type RawHolding = {
  symbol: string;
  name: string;
  tokenAddress: string | null;
  qty: number;
  supported: boolean;
  /** Price reported by the explorer, for tokens outside our price feeds. */
  externalPrice: number | null;
  /** The settlement stablecoin. */
  cash: boolean;
};

export type HoldingsRead = {
  holdings: RawHolding[];
  native: { symbol: string; qty: number };
  /** Settlement stablecoin balance, for the order ticket's balance check. */
  cash: { symbol: string; qty: number } | null;
  discovery: 'registry' | 'explorer';
  source: 'chain' | 'fixture';
  asOf: string;
};

export class HoldingsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldingsUnavailable';
  }
}

const CACHE_SEC = 15;

const holdingsKey = (address: string) => cacheKey('holdings', address.toLowerCase());

/** Called after a fill so the next read reflects it instead of a 15s-old balance. */
export async function invalidateHoldings(address: string): Promise<void> {
  await getCache().del(holdingsKey(address)).catch(() => undefined);
}

export async function readHoldings(address: Address, userId: string | null): Promise<HoldingsRead> {
  const key = holdingsKey(address);
  const cached = await getCache().getWithAge<HoldingsRead>(key).catch(() => null);
  if (cached && cached.ageSec < CACHE_SEC) return cached.value;

  const registry = tokenRegistry();
  const hasStockTokens = [...registry.keys()].some((s) => symbolInfo(s)?.kind === 'stock');

  let result: HoldingsRead;
  if (hasStockTokens && publicClient()) {
    result = await readFromChain(address, registry);
  } else if (isDev()) {
    result = await readFixture(address, userId);
  } else if (publicClient()) {
    // No stock contracts listed yet, but the chain still answers: the gas
    // balance, $RCHAN and the stablecoin if configured, and whatever an
    // explorer finds. Better than refusing to show the wallet at all.
    result = await readFromChain(address, registry);
  } else {
    throw new HoldingsUnavailable('No chain RPC is configured, so wallet balances cannot be read.');
  }

  await getCache().set(key, result, CACHE_SEC).catch(() => undefined);
  return result;
}

/* ------------------------------------------------------------------ */
/* Chain                                                               */
/* ------------------------------------------------------------------ */

async function readFromChain(address: Address, registry: Map<string, TokenInfo>): Promise<HoldingsRead> {
  const client = publicClient();
  const chain = chainConfig();
  if (!client || !chain) throw new HoldingsUnavailable('No chain RPC is configured.');

  const quote = quoteToken();
  const tokens = [...registry.values(), ...(quote ? [quote] : [])];

  const balances = await readBalances(address, tokens);
  const native = await client.getBalance({ address }).catch(() => 0n);

  const holdings: RawHolding[] = [];
  let cash: HoldingsRead['cash'] = null;
  for (const [i, token] of tokens.entries()) {
    const raw = balances[i];
    if (raw == null) continue;
    const qty = Number(formatUnits(raw, token.decimals));
    const isCash = quote != null && token.address.toLowerCase() === quote.address.toLowerCase();
    if (isCash) cash = { symbol: token.symbol, qty };
    if (qty <= 0) continue;
    holdings.push({
      symbol: token.symbol,
      name: isCash ? `${token.symbol} (settlement)` : (SYMBOL_NAMES[token.symbol] ?? token.symbol),
      tokenAddress: token.address,
      qty,
      supported: true,
      externalPrice: isCash ? 1 : null,
      cash: isCash,
    });
  }

  // Open decision #6: every token in the wallet, with the ones Robinchan
  // doesn't support in a section of their own. That needs an indexer; with
  // only an RPC, the registry is all that can be read.
  const known = new Set(tokens.map((t) => t.address.toLowerCase()));
  const discovered = await discoverTokens(address);
  for (const d of discovered ?? []) {
    if (known.has(d.tokenAddress.toLowerCase())) continue;
    holdings.push(d);
  }

  return {
    holdings,
    native: { symbol: chain.nativeSymbol, qty: Number(formatUnits(native, 18)) },
    cash,
    discovery: discovered ? 'explorer' : 'registry',
    source: 'chain',
    asOf: new Date().toISOString(),
  };
}

async function readBalances(address: Address, tokens: TokenInfo[]): Promise<Array<bigint | null>> {
  const client = publicClient();
  if (!client || tokens.length === 0) return [];
  try {
    const results = await client.multicall({
      allowFailure: true,
      contracts: tokens.map((t) => ({
        address: t.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf' as const,
        args: [address] as const,
      })),
    });
    return results.map((r) => (r.status === 'success' ? (r.result as bigint) : null));
  } catch {
    // No Multicall3 on this chain: one read per token.
    return Promise.all(
      tokens.map((t) =>
        client
          .readContract({ address: t.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] })
          .catch(() => null),
      ),
    );
  }
}

type BlockscoutBalance = {
  value?: string;
  token?: {
    address?: string;
    address_hash?: string;
    symbol?: string | null;
    name?: string | null;
    decimals?: string | null;
    exchange_rate?: string | null;
    type?: string;
  };
};

/** Every ERC-20 in the wallet via a Blockscout v2 API (`RC_EXPLORER_API`). Null when not configured or failing. */
async function discoverTokens(address: Address): Promise<Array<RawHolding & { tokenAddress: string }> | null> {
  const base = process.env.RC_EXPLORER_API?.trim().replace(/\/$/, '');
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/v2/addresses/${address}/token-balances`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as BlockscoutBalance[];
    const out: Array<RawHolding & { tokenAddress: string }> = [];
    for (const row of rows) {
      const token = row.token;
      const tokenAddress = token?.address_hash ?? token?.address;
      if (!token || token.type !== 'ERC-20' || !tokenAddress || !row.value) continue;
      const decimals = Number(token.decimals ?? 18);
      const qty = Number(formatUnits(BigInt(row.value), Number.isFinite(decimals) ? decimals : 18));
      if (!(qty > 0)) continue;
      const price = token.exchange_rate != null ? Number(token.exchange_rate) : null;
      out.push({
        symbol: (token.symbol ?? '???').slice(0, 16),
        name: (token.name ?? token.symbol ?? 'Unknown token').slice(0, 48),
        tokenAddress,
        qty,
        supported: false,
        externalPrice: price != null && Number.isFinite(price) ? price : null,
        cash: false,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Dev fixture                                                         */
/* ------------------------------------------------------------------ */

const FIXTURE_CASH = 5_000;

/**
 * A sample wallet derived from the address, so the same wallet always shows
 * the same starting holdings: a handful of stocks "bought elsewhere" (unknown
 * cost basis), $RCHAN, one dust position, and one token Robinchan doesn't
 * support — every branch of the Portfolio page gets exercised.
 */
async function readFixture(address: Address, userId: string | null): Promise<HoldingsRead> {
  const seed = createHash('sha256').update(address.toLowerCase()).digest();
  const byte = (i: number) => seed[i % seed.length] as number;

  const qty = new Map<string, number>();
  const picks = WATCHED_SYMBOLS.filter((_, i) => byte(i) % 2 === 0);
  const held = picks.length >= 3 ? picks : WATCHED_SYMBOLS.slice(0, 3);
  held.forEach((symbol, i) => {
    qty.set(symbol, Number((1 + (byte(i + 8) % 24) + (byte(i + 16) % 100) / 100).toFixed(2)));
  });
  qty.set('RCHAN', 5_000 + (byte(24) % 50) * 250);
  // A dust position: under $1 even at the priciest symbol here (~$750).
  const dust = WATCHED_SYMBOLS.find((s) => !qty.has(s)) ?? 'COIN';
  qty.set(dust, (qty.get(dust) ?? 0) + 0.0005);

  // Paper-venue fills move the sample wallet the way a real swap would.
  let cash = FIXTURE_CASH;
  if (userId) {
    const fills = await getDb().listOrders({ userId, statuses: ['filled'], limit: 500 });
    for (const o of fills) {
      if (o.venue !== 'paper' || o.fillPrice == null) continue;
      const cost = o.qty * o.fillPrice + (o.fee ?? 0);
      if (o.side === 'buy') {
        qty.set(o.symbol, (qty.get(o.symbol) ?? 0) + o.qty);
        cash -= cost;
      } else {
        qty.set(o.symbol, Math.max(0, (qty.get(o.symbol) ?? 0) - o.qty));
        cash += o.qty * o.fillPrice - (o.fee ?? 0);
      }
    }
  }

  const holdings: RawHolding[] = [...qty.entries()]
    .filter(([, q]) => q > 0)
    .map(([symbol, q]) => ({
      symbol,
      name: SYMBOL_NAMES[symbol] ?? symbol,
      tokenAddress: null,
      qty: Number(q.toFixed(6)),
      supported: true,
      externalPrice: null,
      cash: false,
    }));
  holdings.push({
    symbol: 'USDC',
    name: 'USDC (settlement)',
    tokenAddress: null,
    qty: Number(Math.max(0, cash).toFixed(2)),
    supported: true,
    externalPrice: 1,
    cash: true,
  });
  holdings.push({
    symbol: 'AIRDROP',
    name: 'Unrecognized airdrop token',
    tokenAddress: null,
    qty: 25_000,
    supported: false,
    externalPrice: null,
    cash: false,
  });

  return {
    holdings,
    native: { symbol: chainConfig()?.nativeSymbol ?? 'ETH', qty: 0.05 + (byte(28) % 20) / 1000 },
    cash: { symbol: 'USDC', qty: Number(Math.max(0, cash).toFixed(2)) },
    discovery: 'explorer',
    source: 'fixture',
    asOf: new Date().toISOString(),
  };
}
