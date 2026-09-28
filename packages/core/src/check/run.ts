import type { CheckContract, CheckMarket, CheckPool, CheckSimulation, CheckSupply, TokenCheck } from '@robinchan/shared';
import { decodeFunctionResult, encodeFunctionData, getAddress, type Hex, type PublicClient } from 'viem';

import { basePairs, blendedPrice, fetchDexPairs, pairLiquidity, pairPrice, pairVersion, pairVolume, type DexPair } from '../dexscreener';
import { oracleClient } from '../perps/chainlink';
import { BEACON_SLOT, IMPLEMENTATION_SLOT, capabilitiesIn, cloneTarget, slotAddress } from './bytecode';
import { judgeToken, type CheckFacts } from './judge';

/**
 * Token Check, end to end: the contract (code, owner, proxy, owner-only
 * powers), its pools (DexScreener), where the supply sits, and a buy and a
 * sell simulated against the live chain state with `eth_simulateV1` — a
 * transfer out of its deepest pool, then the tokens that arrived sent back.
 * Nothing is signed or sent: every read is a call.
 *
 * Runs on Robinhood Chain mainnet whatever chain the app's wallet features
 * point at: that's where the tokens people ask about live.
 */

const TOKEN_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getOwner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/**
 * Uniswap v4 keeps every v4 pool's tokens in one contract, its PoolManager —
 * the one address emitting v4's `Swap` events on Robinhood Chain mainnet
 * (checked 2026-09-28). A v4-only token's simulated trade goes through it.
 */
export const UNISWAP_V4_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';

const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';
/** The simulated buyer: an address nobody holds a key to. */
const BUYER = '0x5f3e9f1d2c4b7a8e6d0c1b2a3948576a6b7c8d9e';

const isPoolContract = (pair: string) => /^0x[0-9a-fA-F]{40}$/.test(pair);

export class CheckUnavailable extends Error {}

export async function runTokenCheck(
  address: string,
  opts: { client?: PublicClient | null; pairs?: () => Promise<DexPair[]>; now?: number } = {},
): Promise<TokenCheck> {
  const client = opts.client === undefined ? oracleClient() : opts.client;
  if (!client) throw new CheckUnavailable('No Robinhood Chain RPC is configured.');
  const token = getAddress(address);
  const now = opts.now ?? Date.now();

  let code: Hex | undefined;
  try {
    code = await client.getCode({ address: token });
  } catch {
    throw new CheckUnavailable("Robinhood Chain didn't answer. Try again in a moment.");
  }
  const base: CheckFacts = {
    address: token,
    isContract: Boolean(code && code !== '0x'),
    token: null,
    contract: null,
    market: null,
    marketUnavailable: false,
    simulation: { status: 'skipped', via: null, buy: null, sell: null, note: '' },
    supply: null,
    now,
  };
  if (!code || code === '0x') return assemble(base);

  const read = <T>(functionName: 'name' | 'symbol' | 'decimals' | 'totalSupply' | 'owner' | 'getOwner') =>
    client.readContract({ address: token, abi: TOKEN_ABI, functionName }).then(
      (v) => v as T,
      () => null,
    );

  const [name, symbol, decimals, totalSupply, owner, getOwner, implWord, beaconWord, pairs] = await Promise.all([
    read<string>('name'),
    read<string>('symbol'),
    read<number>('decimals'),
    read<bigint>('totalSupply'),
    read<string>('owner'),
    read<string>('getOwner'),
    client.getStorageAt({ address: token, slot: IMPLEMENTATION_SLOT }).catch(() => null),
    client.getStorageAt({ address: token, slot: BEACON_SLOT }).catch(() => null),
    (opts.pairs ?? (() => fetchDexPairs(token)))().catch(() => null),
  ]);

  if (symbol == null || decimals == null || totalSupply == null) return assemble(base);
  // A token names itself: control and bidi-override characters can disguise
  // what the name says, so they go before it's shown or quoted anywhere.
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  base.token = {
    name: clean(name ?? symbol).slice(0, 80) || clean(symbol).slice(0, 24),
    symbol: clean(symbol).slice(0, 24),
    decimals: Number(decimals),
    totalSupply: Number(totalSupply) / 10 ** Number(decimals),
  };

  /* ---- contract ---- */
  const implementation = slotAddress(implWord);
  const beacon = slotAddress(beaconWord);
  const clone = cloneTarget(code as string);
  let logicAddress: string | null = implementation ?? clone;
  if (!logicAddress && beacon) {
    logicAddress = await client
      .readContract({ address: getAddress(beacon), abi: TOKEN_ABI, functionName: 'implementation' })
      .then((a) => a as string)
      .catch(() => null);
  }
  const logicCode = logicAddress ? await client.getCode({ address: getAddress(logicAddress) }).catch(() => undefined) : undefined;
  const scanned = capabilitiesIn(logicCode && logicCode !== '0x' ? logicCode : (code as string));
  const ownerAddr = owner ?? getOwner;
  const renounced = ownerAddr != null && [ZERO, DEAD].includes(ownerAddr.toLowerCase());
  const contract: CheckContract = {
    proxy: implementation ? 'eip1967' : beacon ? 'beacon' : clone ? 'clone' : null,
    implementation: logicAddress,
    upgradeable: Boolean(implementation || beacon || scanned.uups),
    owner: ownerAddr && !renounced ? ownerAddr : null,
    ownerState: ownerAddr == null ? 'none' : renounced ? 'renounced' : 'active',
    capabilities: scanned.capabilities,
    codeSize: ((code as string).length - 2) / 2,
  };

  /* ---- market ---- */
  const market = pairs ? checkMarketOf(token, pairs) : null;

  /* ---- supply and the sell test ---- */
  // Pools with an address of their own (Uniswap v2/v3 style) hold their
  // tokens; v4 pools (a 32-byte pool id) keep theirs in the PoolManager.
  const poolManager = UNISWAP_V4_POOL_MANAGER.toLowerCase();
  const pools = [
    ...new Set([
      ...(pairs ?? []).filter((p) => isPoolContract(p.pairAddress)).map((p) => p.pairAddress.toLowerCase()).slice(0, 8),
      ...((pairs ?? []).some((p) => !isPoolContract(p.pairAddress)) ? [poolManager] : []),
    ]),
  ];
  const holders = [...new Set([...pools, DEAD, ZERO, token.toLowerCase(), ...(contract.owner ? [contract.owner.toLowerCase()] : [])])];
  const balances = new Map<string, bigint>();
  await Promise.all(
    holders.map(async (h) => {
      const bal = await client
        .readContract({ address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [getAddress(h)] })
        .catch(() => null);
      if (bal != null) balances.set(h, bal as bigint);
    }),
  );
  const supply = supplyOf(totalSupply, balances, { pools, token: token.toLowerCase(), owner: contract.owner?.toLowerCase() ?? null });

  // The simulated trade comes out of whichever pool holds the most of it.
  const pick = pools
    .map((pool) => ({ pool, balance: balances.get(pool) ?? 0n }))
    .filter((p) => p.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))[0];
  const simulation: CheckSimulation = pick
    ? await simulateRoundTrip(client, token, pick.pool, pick.balance / 100n, pick.pool === poolManager ? 'Uniswap v4' : poolLabel(pairs ?? [], pick.pool))
    : { status: 'skipped', via: null, buy: null, sell: null, note: 'No pool holds any of it, so there was no trade to simulate.' };

  return assemble({ ...base, contract, market, marketUnavailable: pairs == null, simulation, supply });
}

function assemble(f: CheckFacts): TokenCheck {
  const j = judgeToken(f);
  return {
    address: f.address,
    verdict: j.verdict,
    headline: j.headline,
    token: f.token,
    known: j.known,
    impersonates: j.impersonates,
    findings: j.findings,
    market: f.market,
    contract: f.contract,
    simulation: f.simulation,
    supply: f.supply,
    checkedAt: new Date(f.now).toISOString(),
  };
}

function poolLabel(pairs: DexPair[], pool: string): string {
  const p = pairs.find((x) => x.pairAddress.toLowerCase() === pool);
  if (!p) return 'its deepest';
  const version = pairVersion(p);
  return `${p.dexId.charAt(0).toUpperCase()}${p.dexId.slice(1)}${version ? ` ${version}` : ''} ${p.baseToken.symbol}/${p.quoteToken.symbol}`;
}

export function checkMarketOf(token: string, pairs: DexPair[]): CheckMarket {
  const own = basePairs(pairs, token).sort((a, b) => pairLiquidity(b) - pairLiquidity(a));
  const deepest = own[0];
  const blended = blendedPrice(own, { minLiquidityUsd: 0 });
  const info = own.find((p) => p.info)?.info;
  const created = own.map((p) => p.pairCreatedAt).filter((t): t is number => Number.isFinite(t) && (t as number) > 0);
  const pools: CheckPool[] = own.slice(0, 6).map((p) => ({
    dex: p.dexId,
    version: pairVersion(p),
    pair: p.pairAddress,
    quote: p.quoteToken.symbol,
    liquidityUsd: pairLiquidity(p),
    volume24h: pairVolume(p),
    url: p.url,
  }));
  const links = [
    ...(info?.websites ?? []).map((w) => ({ label: w.label || 'Website', url: w.url })),
    ...(info?.socials ?? []).map((s) => ({ label: socialLabel(s.type), url: s.url })),
  ]
    .filter((l) => /^https:\/\//.test(l.url))
    .slice(0, 6);
  return {
    priceUsd: blended?.price ?? (deepest ? pairPrice(deepest) : null),
    change24hPct: deepest?.priceChange?.h24 ?? null,
    liquidityUsd: own.reduce((s, p) => s + pairLiquidity(p), 0),
    volume24h: own.reduce((s, p) => s + pairVolume(p), 0),
    fdv: deepest?.fdv ?? null,
    marketCap: deepest?.marketCap ?? null,
    buys24h: own.reduce((s, p) => s + (p.txns?.h24?.buys ?? 0), 0),
    sells24h: own.reduce((s, p) => s + (p.txns?.h24?.sells ?? 0), 0),
    firstPoolAt: created.length ? new Date(Math.min(...created)).toISOString() : null,
    pools,
    imageUrl: info?.imageUrl && /^https:\/\/cdn\.dexscreener\.com\//.test(info.imageUrl) ? info.imageUrl : null,
    links,
  };
}

function socialLabel(type: string | undefined): string {
  const t = (type ?? '').toLowerCase();
  if (t === 'twitter' || t === 'x') return 'X';
  if (t === 'telegram') return 'Telegram';
  if (t === 'discord') return 'Discord';
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Link';
}

function supplyOf(
  totalSupply: bigint,
  balances: Map<string, bigint>,
  who: { pools: string[]; token: string; owner: string | null },
): CheckSupply | null {
  if (totalSupply <= 0n) return null;
  const share = (v: bigint) => Number((v * 1_000_000n) / totalSupply) / 10_000;
  const sum = (keys: string[]) => keys.reduce((s, k) => s + (balances.get(k) ?? 0n), 0n);
  const inPools = who.pools.length ? share(sum(who.pools)) : null;
  const burned = share(sum([DEAD, ZERO]));
  const ownerPct = who.owner ? share(balances.get(who.owner) ?? 0n) : null;
  const contractPct = share(balances.get(who.token) ?? 0n);
  const rest = Math.max(0, 100 - (inPools ?? 0) - burned - (ownerPct ?? 0) - contractPct);
  return { inPoolsPct: inPools, burnedPct: burned, ownerPct, contractPct, restPct: rest };
}

type SimCall = { returnData: Hex; status: Hex; error?: { message?: string } };

/**
 * One block, simulated on top of the latest: the pool sends `amount` to a
 * fresh address (a buy, as the token sees it), then that address sends back
 * whatever arrived (a sell). Balances read in between measure any tax.
 */
async function simulateRoundTrip(client: PublicClient, token: Hex, pool: string, amount: bigint, via: string): Promise<CheckSimulation> {
  const call = (data: Hex, from?: string) => ({ ...(from ? { from } : {}), to: token, data });
  const balanceOf = (who: string) => encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [getAddress(who)] });
  const transfer = (to: string, value: bigint) => encodeFunctionData({ abi: TOKEN_ABI, functionName: 'transfer', args: [getAddress(to), value] });
  const simulate = async (calls: ReturnType<typeof call>[]): Promise<SimCall[]> => {
    const request = client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<Array<{ calls: SimCall[] }>>;
    const blocks = await request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls }], validation: false }, 'latest'] });
    return blocks[0]?.calls ?? [];
  };
  const bigOf = (c: SimCall | undefined) =>
    c && c.status === '0x1' ? (decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'balanceOf', data: c.returnData }) as bigint) : null;
  const okOf = (c: SimCall | undefined) => {
    if (!c || c.status !== '0x1') return false;
    // Tokens that return nothing (USDT-style) succeeded by not reverting.
    if (!c.returnData || c.returnData === '0x') return true;
    return decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'transfer', data: c.returnData }) as boolean;
  };
  const errOf = (c: SimCall | undefined) => (c?.error?.message ? c.error.message.replace(/^execution reverted:?\s*/i, '').slice(0, 100) || 'reverted' : c && c.status === '0x1' ? 'returned false' : 'reverted');
  const taxOf = (sent: bigint, got: bigint) => (sent > 0n ? Math.max(0, Number(((sent - got) * 1_000_000n) / sent) / 10_000) : null);

  try {
    // Leg one alone first: what arrives decides how much the sale sends back.
    const buyCalls = await simulate([call(balanceOf(BUYER)), call(transfer(BUYER, amount), pool), call(balanceOf(BUYER))]);
    const before = bigOf(buyCalls[0]) ?? 0n;
    const bought = okOf(buyCalls[1]);
    const after = bigOf(buyCalls[2]);
    if (!bought || after == null) {
      return { status: 'failed', via, buy: { ok: false, taxPct: null, error: errOf(buyCalls[1]) }, sell: null, note: 'The transfer out of the pool failed.' };
    }
    const received = after - before;
    const buy = { ok: true, taxPct: taxOf(amount, received), error: null };
    if (received <= 0n) {
      return { status: 'failed', via, buy: { ok: false, taxPct: 100, error: 'nothing arrived' }, sell: null, note: 'Nothing arrived from the pool.' };
    }

    const all = await simulate([
      call(transfer(BUYER, amount), pool),
      call(balanceOf(pool)),
      call(transfer(pool, received), BUYER),
      call(balanceOf(pool)),
    ]);
    const sold = okOf(all[2]);
    const p1 = bigOf(all[1]);
    const p2 = bigOf(all[3]);
    if (!sold || p1 == null || p2 == null) {
      return { status: 'failed', via, buy, sell: { ok: false, taxPct: null, error: errOf(all[2]) }, note: 'The sale back into the pool failed.' };
    }
    const sell = { ok: true, taxPct: taxOf(received, p2 - p1), error: null };
    return { status: 'passed', via, buy, sell, note: 'Simulated on a copy of the latest block. Nothing was sent.' };
  } catch (err) {
    const message = (err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message ?? '';
    return { status: 'skipped', via, buy: null, sell: null, note: `The chain couldn't run the simulation (${message.split('\n')[0]?.slice(0, 80)}).` };
  }
}
