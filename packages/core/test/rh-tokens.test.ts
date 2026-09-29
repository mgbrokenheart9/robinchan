import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PerpMarket } from '@robinchan/shared';
import { RH_TOKEN_MIN_LIQUIDITY_USD, RH_TOKEN_WARNING, TWAP_BADGE, perpMarket } from '@robinchan/shared';

import type { DexPair } from '../src/dexscreener';
import { readRhPools, rhPoolsFrom, rhTokensBoard } from '../src/perps/rh-tokens';
import { TWAP_CADENCE_SEC, twapCadenceSec, twapRoundMarkets } from '../src/perps/twap';

const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const CASHCAT_V3 = '0xa70fc67c9f69da90b63a0e4c05d229954574e313';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

/** A pool as DexScreener lists it. */
function pair(p: { address: string; dex: string; version?: string; base: string; baseSymbol: string; quote?: string; liquidity: number; price: number }): DexPair {
  return {
    chainId: 'robinhood',
    dexId: p.dex,
    url: `https://dexscreener.com/robinhood/${p.address}`,
    pairAddress: p.address,
    labels: p.version ? [p.version] : undefined,
    baseToken: { address: p.base, name: p.baseSymbol, symbol: p.baseSymbol },
    quoteToken: { address: WETH, name: 'Wrapped Ether', symbol: p.quote ?? 'WETH' },
    priceUsd: String(p.price),
    liquidity: { usd: p.liquidity },
  };
}

/** CASHCAT's deepest pools on 2026-09-28: the V3 pool the average reads, and a deeper-looking v4 one that can't be read. */
const catPools = (v3Liquidity = 4_906_569) => [
  pair({ address: '0xA70fc67C9F69da90B63a0e4C05D229954574E313', dex: 'uniswap', version: 'v3', base: CASHCAT, baseSymbol: 'CASHCAT', liquidity: v3Liquidity, price: 0.1875 }),
  pair({ address: '0xd42A491087a15E5afd51FEb3606066Cc152d2b09', dex: 'uniswap', version: 'v3', base: CASHCAT, baseSymbol: 'CASHCAT', liquidity: 2_518_606, price: 0.1874 }),
  pair({ address: '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b', dex: 'uniswap', version: 'v4', base: CASHCAT, baseSymbol: 'CASHCAT', quote: 'USDG', liquidity: 1_072_309, price: 0.1876 }),
];

const unlisted = (symbol: string): PerpMarket => ({
  symbol,
  name: perpMarket(symbol)!.name,
  category: 'rh',
  unit: '',
  status: 'unavailable',
  statusNote: perpMarket(symbol)!.unavailable ?? null,
  price: null,
  confidence: null,
  change24hPct: null,
  publishTime: null,
  fundingRatePerHour: 0,
  openInterest: { long: 0, short: 0 },
  maxLeverage: 5,
  contract: null,
  nextRollAt: null,
  hours: '24/7',
  source: null,
});

describe('RH Tokens board', () => {
  test('only the oracle pool counts toward the $500k: CASHCAT’s V3 pool, not its total across pools', () => {
    const cat = rhPoolsFrom(perpMarket('CASHCAT')!, catPools(), null);
    assert.equal(Math.round(cat.totalLiquidityUsd ?? 0), 8_497_484);
    assert.equal(cat.oraclePoolLiquidityUsd, 4_906_569);
    assert.deepEqual(cat.pools.map((p) => [p.dex, p.version, p.pair]), [
      ['uniswap', 'v3', 'CASHCAT/WETH'],
      ['uniswap', 'v3', 'CASHCAT/WETH'],
      ['uniswap', 'v4', 'CASHCAT/USDG'],
    ]);
    assert.ok(cat.spotPrice && cat.spotPrice > 0.187 && cat.spotPrice < 0.188);

    const board = rhTokensBoard(['PONS', 'CASHCAT', 'DELTA'].map(unlisted), { tokens: [cat], checkedAt: '2026-09-28T13:00:00Z' });
    const row = board.tokens.find((t) => t.symbol === 'CASHCAT')!;
    assert.equal(row.meetsLiquidity, true, '$4.9M ≥ $500k');
    assert.equal(row.oraclePool?.address, CASHCAT_V3);
    assert.equal(row.oraclePool?.label, 'Uniswap V3 CASHCAT/WETH');
    assert.equal(row.twapPrice, null, 'no average yet');
    assert.equal(row.status, 'unavailable');
    assert.equal(board.minLiquidityUsd, RH_TOKEN_MIN_LIQUIDITY_USD);
    assert.equal(board.oracle, TWAP_BADGE);
    assert.equal(board.warning, RH_TOKEN_WARNING);

    // The V3 pool drained to $400k: under the floor, however deep the v4 pool is.
    const thin = rhTokensBoard([unlisted('CASHCAT')], { tokens: [rhPoolsFrom(perpMarket('CASHCAT')!, catPools(400_000), null)], checkedAt: '' });
    assert.equal(thin.tokens.find((t) => t.symbol === 'CASHCAT')?.meetsLiquidity, false);
  });

  test('a deployed feed’s own reading of its pool wins over DexScreener’s', () => {
    const cat = rhPoolsFrom(perpMarket('CASHCAT')!, catPools(), 480_000);
    assert.equal(cat.oraclePoolLiquidityUsd, 480_000);
  });

  test('a token whose pools can’t be read this run keeps no numbers, and doesn’t list', async () => {
    const calls: string[] = [];
    const snapshot = await readRhPools({
      client: null,
      fetchPairs: async (token) => {
        calls.push(token);
        if (token === CASHCAT) return catPools();
        throw new Error('DexScreener HTTP 429');
      },
    });
    assert.equal(calls.length, 3);
    const by = (s: string) => snapshot.tokens.find((t) => t.symbol === s)!;
    assert.equal(by('CASHCAT').oraclePoolLiquidityUsd, 4_906_569);
    assert.equal(by('PONS').totalLiquidityUsd, null, 'unreadable this run');
    assert.equal(by('PONS').oraclePoolLiquidityUsd, null);
    const board = rhTokensBoard([], snapshot);
    assert.equal(board.tokens.find((t) => t.symbol === 'CASHCAT')?.meetsLiquidity, true);
    assert.equal(board.tokens.find((t) => t.symbol === 'PONS')?.meetsLiquidity, false, 'unknown depth never passes');
  });

  test('the keeper updates the three deployed feeds', () => {
    assert.deepEqual(twapRoundMarkets().map((m) => [m.symbol, m.twap.roundFeed]), [
      ['PONS', '0x0931fdc472e1d75379569b889df23518c65480dc'],
      ['CASHCAT', '0x43472dc130b64f85386e85d11c2d18390ee1f5ea'],
      ['DELTA', '0xe25af4ae6404ce04769dbfeb7cf61fd723517bc7'],
    ]);
  });

  test('the keeper updates a feed every minute while an order waits, every 5 with positions open, every 16 otherwise', () => {
    assert.equal(twapCadenceSec({ orderWaiting: true, openInterest: 0 }), 60);
    assert.equal(twapCadenceSec({ orderWaiting: true, openInterest: 500 }), 60);
    assert.equal(twapCadenceSec({ orderWaiting: false, openInterest: 500 }), 300);
    assert.equal(twapCadenceSec({ orderWaiting: false, openInterest: 0 }), 960);
    // Every cadence finds a start the contract takes (900–1,140 s back, granularity 60) and stays under the hour-long breaker.
    for (const s of Object.values(TWAP_CADENCE_SEC)) {
      const starts = Array.from({ length: 30 }, (_, i) => (i + 1) * s).filter((age) => age >= 900 && age <= 1_140);
      assert.ok(s === 60 ? starts.length >= 1 : starts.length === 1, `${s}s leaves a window start`);
      assert.ok(s < 3_600);
    }
  });
});
