import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { CheckSimulation, UsSession } from '@robinchan/shared';
import { STOCK_TOKENS, stockToken, usSession } from '@robinchan/shared';
import { encodeFunctionData, toFunctionSelector } from 'viem';

import { capabilitiesIn, cloneTarget, pushedSelectors, slotAddress } from '../src/check/bytecode';
import { impersonationOf, judgeToken, type CheckFacts } from '../src/check/judge';
import { blendedPrice, type DexPair } from '../src/dexscreener';
import { appendGapHistory, buildGapBoard, gapRead, gapRow, gapSpark, summarizeGap } from '../src/gap';
import { soundsLikeAdvice } from '../src/guard';

const utc = (iso: string) => Date.parse(iso);

describe('US market session', () => {
  test('regular hours, with DST: 9:30 New York is 13:30 UTC in September, 14:30 in December', () => {
    const s = usSession(utc('2026-09-28T14:00:00Z'));
    assert.equal(s.state, 'regular');
    assert.equal(s.closed, false);
    assert.equal(s.nextClose, '2026-09-28T20:00:00.000Z');
    assert.equal(s.nextOpen, '2026-09-29T13:30:00.000Z');
    assert.equal(usSession(utc('2026-12-01T14:31:00Z')).state, 'regular');
    assert.equal(usSession(utc('2026-12-01T14:29:00Z')).label, 'Pre-market');
  });

  test('pre-market, after hours and the overnight session', () => {
    assert.equal(usSession(utc('2026-09-28T12:00:00Z')).label, 'Pre-market');
    assert.equal(usSession(utc('2026-09-28T21:00:00Z')).label, 'After hours');
    const night = usSession(utc('2026-09-28T06:30:00Z'));
    assert.equal(night.state, 'overnight');
    assert.equal(night.nextOpen, '2026-09-28T13:30:00.000Z');
  });

  test('the weekend runs Friday 20:00 to Sunday 20:00 New York, and the next open is Monday', () => {
    const fri = usSession(utc('2026-09-26T00:30:00Z')); // Friday 20:30 New York
    assert.equal(fri.state, 'weekend');
    assert.equal(fri.closed, true);
    assert.equal(fri.nextOpen, '2026-09-28T13:30:00.000Z');
    assert.equal(usSession(utc('2026-09-27T12:00:00Z')).state, 'weekend');
    assert.equal(usSession(utc('2026-09-28T00:30:00Z')).state, 'overnight'); // Sunday 20:30
  });

  test('holidays are closed, and the next open skips them', () => {
    const thanksgiving = usSession(utc('2026-11-26T16:00:00Z'));
    assert.equal(thanksgiving.state, 'holiday');
    assert.equal(thanksgiving.holiday, 'Thanksgiving');
    assert.equal(thanksgiving.nextOpen, '2026-11-27T14:30:00.000Z');
    // The day after closes at 13:00.
    assert.equal(usSession(utc('2026-11-27T15:00:00Z')).nextClose, '2026-11-27T18:00:00.000Z');
    assert.equal(usSession(utc('2026-11-27T18:30:00Z')).label, 'After hours');
    // Good Friday 2027: Thursday night's next open is Monday.
    assert.equal(usSession(utc('2027-03-25T21:00:00Z')).nextOpen, '2027-03-29T13:30:00.000Z');
  });
});

const pair = (price: number, liquidity: number, extra: Partial<DexPair> = {}): DexPair => ({
  chainId: 'robinhood',
  dexId: 'uniswap',
  url: `https://dexscreener.com/robinhood/${price}-${liquidity}`,
  pairAddress: '0x0000000000000000000000000000000000000001',
  labels: ['v3'],
  baseToken: { address: STOCK_TOKENS[0]!.address, name: 'Apple • Robinhood Token', symbol: 'AAPL' },
  quoteToken: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', name: 'Global Dollar', symbol: 'USDG' },
  priceUsd: String(price),
  liquidity: { usd: liquidity },
  volume: { h24: 1_000 },
  ...extra,
});

describe('Gap board', () => {
  test('a blended price weights pools by liquidity and leaves out shallow or stranded ones', () => {
    const got = blendedPrice([pair(100, 300_000), pair(102, 100_000), pair(140, 500_000), pair(90, 2_000)]);
    // 140 is 35% off the median and 90 sits in a $2K pool: both out.
    assert.ok(got);
    assert.equal(got.pools.length, 2);
    assert.equal(Number(got.price.toFixed(4)), 100.5);
    assert.equal(blendedPrice([pair(10, 1_000)]), null);
  });

  test('a row sets the blended price against the reference; the board sorts by the widest gap', () => {
    const [aapl, nvda, tsla] = ['AAPL', 'NVDA', 'TSLA'].map((s) => stockToken(s)!);
    const rows = [
      gapRow(aapl!, [pair(101, 200_000)], { price: 100, at: 1_790_000_000, source: 'yahoo' }, []),
      gapRow(nvda!, [pair(97, 200_000)], { price: 100, at: 1_790_000_000, source: 'yahoo' }, []),
      gapRow(tsla!, [], { price: 100, at: 1_790_000_000, source: 'yahoo' }, []),
    ];
    assert.equal(Number(rows[0]!.gapPct!.toFixed(6)), 1);
    const session = usSession(utc('2026-09-27T12:00:00Z'));
    const board = buildGapBoard(session, rows, 'live', utc('2026-09-27T12:00:00Z'));
    assert.deepEqual(board.rows.map((r) => r.symbol), ['NVDA', 'AAPL']);
    assert.deepEqual(board.unpriced, ['TSLA']);
    assert.deepEqual(board.summary.widest, { symbol: 'NVDA', gapPct: board.rows[0]!.gapPct });
    assert.equal(board.summary.above, 1);
    assert.equal(board.summary.below, 1);
    assert.match(board.read, /closed for the weekend.*NVDA trades 3\.00% below its last close/);
  });

  test("Robinchan's lines describe; none of them reads as advice", () => {
    const summary = summarizeGap([gapRow(stockToken('AAPL')!, [pair(103, 200_000)], { price: 100, at: 1, source: 'yahoo' }, [])]);
    const sessions: UsSession[] = [
      usSession(utc('2026-09-27T12:00:00Z')),
      usSession(utc('2026-11-26T16:00:00Z')),
      usSession(utc('2026-09-28T14:00:00Z')),
      usSession(utc('2026-09-28T06:00:00Z')),
      usSession(utc('2026-09-28T21:00:00Z')),
    ];
    for (const s of sessions) {
      const line = gapRead(s, summary);
      assert.ok(!soundsLikeAdvice(line), line);
    }
    assert.match(gapRead(sessions[1]!, summary), /off for Thanksgiving/);
  });

  test('history keeps one point per 10 minutes and the spark one per half hour', () => {
    let store = appendGapHistory(null, 1_000_000, { AAPL: 1 });
    store = appendGapHistory(store, 1_000_120, { AAPL: 2 }); // same slot: replaced
    store = appendGapHistory(store, 1_000_700, { AAPL: 3 });
    assert.deepEqual(store.points.map((p) => p.g.AAPL), [2, 3]);
    store = appendGapHistory(store, 1_000_700 + 5 * 86_400, { AAPL: 4 }); // four days later: the rest ages out
    assert.deepEqual(store.points.map((p) => p.g.AAPL), [4]);
    assert.deepEqual(gapSpark(store, 'AAPL', 1_000_700 + 5 * 86_400), [4]);
  });
});

/* ------------------------------------------------------------------ */

const passed: CheckSimulation = {
  status: 'passed',
  via: 'Uniswap v3 MEME/WETH',
  buy: { ok: true, taxPct: 0, error: null },
  sell: { ok: true, taxPct: 0, error: null },
  note: 'Simulated.',
};

const facts = (over: Partial<CheckFacts> = {}): CheckFacts => ({
  address: '0x1111111111111111111111111111111111111111',
  isContract: true,
  token: { name: 'Meme', symbol: 'MEME', decimals: 18, totalSupply: 1e9 },
  contract: { proxy: null, implementation: null, upgradeable: false, owner: null, ownerState: 'renounced', capabilities: [], codeSize: 4000 },
  market: {
    priceUsd: 0.01,
    change24hPct: 2,
    liquidityUsd: 250_000,
    volume24h: 90_000,
    fdv: 1e7,
    marketCap: 1e7,
    buys24h: 400,
    sells24h: 380,
    firstPoolAt: '2026-08-01T00:00:00Z',
    pools: [{ dex: 'uniswap', version: 'v3', pair: '0x2', quote: 'WETH', liquidityUsd: 250_000, volume24h: 90_000, url: 'https://dexscreener.com/x' }],
    imageUrl: null,
    links: [],
  },
  marketUnavailable: false,
  simulation: passed,
  supply: { inPoolsPct: 12, burnedPct: 0, ownerPct: null, contractPct: 0, restPct: 88 },
  now: utc('2026-09-28T00:00:00Z'),
  ...over,
});

describe('Token Check: reading the facts', () => {
  test('nothing wrong: no red flags, and Robinchan says why', () => {
    const j = judgeToken(facts());
    assert.equal(j.verdict, 'clean');
    assert.deepEqual(j.findings.map((f) => f.id).sort(), ['deep-liquidity', 'no-tax', 'renounced']);
    assert.match(j.headline, /no tax, ownership is renounced and \$250K sits in its pools/);
  });

  test('a sell that fails is a red flag, whatever else is fine', () => {
    const j = judgeToken(facts({ simulation: { ...passed, status: 'failed', sell: { ok: false, taxPct: null, error: 'Trading not open' } } }));
    assert.equal(j.verdict, 'danger');
    assert.equal(j.findings[0]?.id, 'sell-blocked');
    assert.match(j.findings[0]!.detail, /Trading not open/);
    assert.match(j.headline, /^Red flags here\. Selling looks blocked/);
  });

  test('taxes: 5% is worth knowing, 25% on the sell side is a red flag', () => {
    const taxed = (sell: number) => judgeToken(facts({ simulation: { ...passed, sell: { ok: true, taxPct: sell, error: null } } }));
    assert.equal(taxed(5).verdict, 'caution');
    assert.equal(taxed(25).verdict, 'danger');
    assert.equal(taxed(25).findings[0]?.title, '25% sell tax');
  });

  test('an active owner with a mint and a blacklist, a young pool, and nobody selling', () => {
    const j = judgeToken(
      facts({
        contract: { proxy: null, implementation: null, upgradeable: false, owner: '0x2222222222222222222222222222222222222222', ownerState: 'active', capabilities: ['mint', 'blacklist'], codeSize: 5000 },
        market: { ...facts().market!, firstPoolAt: '2026-09-27T20:00:00Z', buys24h: 60, sells24h: 0 },
        supply: { inPoolsPct: 30, burnedPct: 0, ownerPct: 22, contractPct: 0, restPct: 48 },
      }),
    );
    assert.equal(j.verdict, 'danger');
    const ids = j.findings.map((f) => f.id);
    for (const id of ['no-sellers', 'mint', 'blacklist', 'new', 'owner-supply']) assert.ok(ids.includes(id), id);
    assert.equal(j.findings[0]?.severity, 'danger');
  });

  test('official stock tokens are official, their issuer controls noted, not held against them', () => {
    const tsla = stockToken('TSLA')!;
    const j = judgeToken(
      facts({
        address: tsla.address,
        token: { name: 'Tesla • Robinhood Token', symbol: 'TSLA', decimals: 18, totalSupply: 13_000 },
        contract: { proxy: 'beacon', implementation: '0x3', upgradeable: true, owner: null, ownerState: 'none', capabilities: ['mint', 'pause'], codeSize: 283 },
      }),
    );
    assert.equal(j.verdict, 'official');
    assert.deepEqual(j.known, { kind: 'stock', symbol: 'TSLA', name: 'Tesla' });
    assert.ok(!j.findings.some((f) => f.severity === 'warn' || f.severity === 'danger'));
    assert.match(j.headline, /real Tesla stock token/);
  });

  test('impersonation: a borrowed name is a red flag, a borrowed ticker a caution', () => {
    const fake = impersonationOf('0x5DD716Fe12275B69f04b26bEeca343843C8e3539', { name: 'NVIDIA Robinhood Coin', symbol: 'NVDA' });
    assert.equal(fake?.by, 'name');
    assert.equal(fake?.symbol, 'NVDA');
    assert.equal(impersonationOf('0x1b33420614e9EF459d047cBe22E5265653776CF7', { name: 'OG Memestock', symbol: 'TSLA' })?.by, 'ticker');
    assert.equal(impersonationOf('0x1', { name: 'Tesla Stock Token', symbol: '$tsla' })?.by, 'name');
    assert.equal(impersonationOf('0x1', { name: 'Robinchan Inu', symbol: 'RCINU' })?.symbol, 'RCHAN');
    assert.equal(impersonationOf('0x1', { name: 'Global Dollar', symbol: 'USDG' })?.symbol, 'USDG');
    assert.equal(impersonationOf(stockToken('NVDA')!.address, { name: 'NVIDIA • Robinhood Token', symbol: 'NVDA' }), null);
    assert.equal(impersonationOf('0x1', { name: 'Cash Cat', symbol: 'CASHCAT' }), null);

    const j = judgeToken(facts({ token: { name: 'NVIDIA Robinhood Coin', symbol: 'NVDA', decimals: 18, totalSupply: 1e9 } }));
    assert.equal(j.verdict, 'danger');
    assert.equal(j.findings[0]?.id, 'impersonation');
    const meme = judgeToken(facts({ token: { name: 'OG Memestock', symbol: 'TSLA', decimals: 18, totalSupply: 1e9 } }));
    assert.equal(meme.verdict, 'caution');
    assert.match(meme.headline, /one thing stands out: not the official TSLA/);
  });

  test('a wallet, or a contract that is no token, is unknown', () => {
    assert.equal(judgeToken(facts({ isContract: false, token: null })).verdict, 'unknown');
    assert.match(judgeToken(facts({ token: null })).headline, /doesn't answer like a token/);
  });

  test('no finding or headline reads as advice', () => {
    const cases = [
      facts(),
      facts({ simulation: { ...passed, status: 'failed', sell: { ok: false, taxPct: null, error: null } } }),
      facts({ simulation: { status: 'skipped', via: null, buy: null, sell: null, note: 'No pool holds any of it.' }, market: null }),
      facts({ contract: { ...facts().contract!, ownerState: 'active', owner: '0x2', capabilities: ['mint', 'blacklist', 'pause', 'fees', 'limits', 'trading'] } }),
      facts({ token: { name: 'NVIDIA Robinhood Coin', symbol: 'NVDA', decimals: 18, totalSupply: 1 } }),
    ];
    for (const f of cases) {
      const j = judgeToken(f);
      for (const text of [j.headline, ...j.findings.flatMap((x) => [x.title, x.detail])]) assert.ok(!soundsLikeAdvice(text), text);
    }
  });
});

describe('Token Check: reading the code', () => {
  test('selectors come from PUSH4s, never from inside another PUSH', () => {
    const mint = toFunctionSelector('function mint(address,uint256)').slice(2);
    const pause = toFunctionSelector('function pause()').slice(2);
    // PUSH4 mint · PUSH32 (hiding a PUSH4 pause in its data) · PUSH4 pause
    const code = `0x63${mint}7f63${pause}${'00'.repeat(27)}63${pause}`;
    assert.deepEqual([...pushedSelectors(code)], [mint, pause]);
    const hidden = `0x63${mint}7f63${pause}${'00'.repeat(27)}`;
    assert.deepEqual(capabilitiesIn(hidden).capabilities, ['mint']);
    const upgrade = toFunctionSelector('function upgradeToAndCall(address,bytes)').slice(2);
    assert.equal(capabilitiesIn(`0x63${upgrade}`).uups, true);
    // The encoder agrees with the scan on what a selector is.
    assert.equal(encodeFunctionData({ abi: [{ type: 'function', name: 'pause', inputs: [], outputs: [], stateMutability: 'nonpayable' }], functionName: 'pause' }), `0x${pause}`);
  });

  test('EIP-1167 clones and EIP-1967 slots', () => {
    const impl = 'bebebebebebebebebebebebebebebebebebebebe';
    assert.equal(cloneTarget(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`), `0x${impl}`);
    // Solady's variant, as a launchpad deployed the fake NVDA on Robinhood Chain.
    assert.equal(cloneTarget(`0x3d3d3d3d363d3d37363d73${impl}5af43d3d93803e602a57fd5bf3`), `0x${impl}`);
    // EIP-7511, with PUSH0.
    assert.equal(cloneTarget(`0x365f5f375f5f365f73${impl}5af43d5f5f3e5f3d91602a57fd5bf3`), `0x${impl}`);
    assert.equal(cloneTarget('0x6080'), null);
    assert.equal(cloneTarget(`0x6080${'00'.repeat(200)}73${impl}5af4`), null);
    assert.equal(slotAddress(`0x000000000000000000000000${impl}`), `0x${impl}`);
    assert.equal(slotAddress(`0x${'0'.repeat(64)}`), null);
    assert.equal(slotAddress(null), null);
  });
});
