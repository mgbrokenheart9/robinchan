import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { network } from 'hardhat';
import { maxUint256, parseEther, parseEventLogs, parseUnits, zeroAddress, type Address, type Hex } from 'viem';

/**
 * TwapRoundFeed: a Uniswap pool's 15-minute TWAP as Chainlink-style rounds,
 * in USD through the quote token's Chainlink feed — from a V2 pair's
 * cumulative price or a V3 pool's cumulative tick. Covers the average itself,
 * what a short spike does to it, the liquidity gate, a stale quote feed, the
 * circuit breaker, a gap in the record, and an AgriPerp order settling on the
 * first average that began after it.
 */

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner, alice, mallory] = await viem.getWalletClients();

const V2 = 0;
const V3 = 1;
const WINDOW = 900;
const STEP = 60;
const usd = (x: number | string) => parseUnits(String(x), 6);

async function now(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest());
}

async function mined(hash: Promise<Hex>) {
  return publicClient.waitForTransactionReceipt({ hash: await hash });
}

/** An 18-decimal answer against a price in dollars: within a billionth, or the answer's last digit. */
function close(answer: bigint, expectedUsd: number, what: string) {
  const want = expectedUsd * 1e18;
  assert.ok(Math.abs(Number(answer) - want) <= Math.max(1, want * 1e-9), `${what}: ${Number(answer) / 1e18} vs ${expectedUsd}`);
}

const feedConfig = (c: { kind: number; pair: Address; baseToken: Address; quoteUsdFeed: Address; minLiquidityUsd?: bigint; source: string }) => ({
  kind: c.kind,
  pair: c.pair,
  baseToken: c.baseToken,
  quoteUsdFeed: c.quoteUsdFeed,
  window: WINDOW,
  granularity: STEP,
  maxStaleness: 3600,
  quoteFeedMaxAge: 90_000,
  minLiquidityUsd: c.minLiquidityUsd ?? parseEther('100000'),
  description: 'Robinchan TEST / USD (TWAP)',
  source: c.source,
});

/** WOOD/WETH on a Uniswap V2 pair (2026-09-28): 82.1 WETH against 41.8M WOOD, ETH at $2,650. */
async function deploy(opts: { minLiquidityUsd?: bigint } = {}) {
  const weth = await viem.deployContract('MockToken', [18]);
  const wood = await viem.deployContract('MockToken', [18]);
  const pair = await viem.deployContract('MockUniswapV2Pair', [weth.address, wood.address]);
  const ethUsd = await viem.deployContract('MockAggregator', [8, 'ETH / USD', parseUnits('2650', 8)]);
  const wethIs0 = (await pair.read.token0()).toLowerCase() === weth.address.toLowerCase();
  const setPool = async (wethAmount: number, woodAmount: number) => {
    const w = parseEther(String(wethAmount));
    const t = parseEther(String(woodAmount));
    await mined(pair.write.setReserves(wethIs0 ? [w, t] : [t, w]));
  };
  await setPool(82.1, 41_800_000);
  const feed = await viem.deployContract('TwapRoundFeed', [
    feedConfig({ kind: V2, pair: pair.address, baseToken: wood.address, quoteUsdFeed: ethUsd.address, minLiquidityUsd: opts.minLiquidityUsd, source: 'Uniswap V2 WOOD/WETH' }),
    owner.account.address,
  ]);
  return { weth, wood, pair, ethUsd, feed, setPool };
}

/** CASHCAT/WETH on a Uniswap V3 pool (2026-09-28): 0.00006983 WETH a CASHCAT, 925 WETH in the pool, ETH at $2,650. */
const CASHCAT_IN_WETH = 0.00006983;
async function deployV3(opts: { minLiquidityUsd?: bigint } = {}) {
  const weth = await viem.deployContract('MockToken', [18]);
  const cat = await viem.deployContract('MockToken', [18]);
  const catIs0 = cat.address.toLowerCase() < weth.address.toLowerCase();
  // token1 per token0 is 1.0001^tick.
  const tickFor = (catInWeth: number) => {
    const t = Math.round(Math.log(catInWeth) / Math.log(1.0001));
    return catIs0 ? t : -t;
  };
  const priceAt = (tick: number) => Math.pow(1.0001, catIs0 ? tick : -tick) * 2650;
  const pool = await viem.deployContract('MockUniswapV3Pool', [weth.address, cat.address, tickFor(CASHCAT_IN_WETH)]);
  await mined(weth.write.setBalance([pool.address, parseEther('925')]));
  await mined(cat.write.setBalance([pool.address, parseEther('35000000')]));
  const ethUsd = await viem.deployContract('MockAggregator', [8, 'ETH / USD', parseUnits('2650', 8)]);
  const feed = await viem.deployContract('TwapRoundFeed', [
    feedConfig({ kind: V3, pair: pool.address, baseToken: cat.address, quoteUsdFeed: ethUsd.address, minLiquidityUsd: opts.minLiquidityUsd, source: 'Uniswap V3 CASHCAT/WETH' }),
    owner.account.address,
  ]);
  return { weth, cat, pool, ethUsd, feed, tickFor, priceAt };
}

type Feed = { feed: { write: { update: (o?: { account: typeof mallory.account }) => Promise<Hex> }; read: { latestRoundData: () => Promise<readonly [bigint, bigint, bigint, bigint, bigint]> } } };

/** One keeper tick: a minute on, then update(). */
async function tick(f: Feed) {
  await networkHelpers.time.increase(STEP);
  return mined(f.feed.write.update({ account: mallory.account }));
}

/** Enough ticks for a window's history, plus one: returns the first round's id. */
async function warmUp(f: Feed): Promise<bigint> {
  for (let i = 0; i < WINDOW / STEP; i++) await tick(f);
  await tick(f);
  return (await f.feed.read.latestRoundData())[0];
}

describe('TwapRoundFeed on a Uniswap V2 pair', () => {
  it('makes no round until a window of history is on record, then one per tick', async () => {
    const f = await deploy();
    await viem.assertions.revertWithCustomError(f.feed.read.latestRoundData(), f.feed, 'NoRound');
    for (let i = 0; i < WINDOW / STEP - 1; i++) await tick(f);
    assert.equal(await f.feed.read.roundCount(), 0n, 'fourteen minutes: no average yet');
    await tick(f);
    await tick(f);
    assert.ok((await f.feed.read.roundCount()) >= 1n);
    const [id, answer, startedAt, updatedAt, answeredIn] = await f.feed.read.latestRoundData();
    assert.equal(id >> 64n, 1n);
    assert.equal(answeredIn, id);
    assert.ok(updatedAt - startedAt >= BigInt(WINDOW), 'the window spans at least 15 minutes');
    assert.ok(updatedAt - startedAt <= BigInt(WINDOW + STEP), 'and not much more');
    // No trades: the average is the price.
    close(answer, (82.1 / 41_800_000) * 2650, 'WOOD');
    assert.equal(await f.feed.read.decimals(), 18);
    await viem.assertions.revertWithCustomError(f.feed.write.update(), f.feed, 'TooSoon');
    assert.equal(await f.feed.read.nextUpdateAt(), updatedAt + BigInt(STEP), 'the keeper reads when to come back');
  });

  it('averages over time: a price held for half the window moves the answer half as much', async () => {
    const f = await deploy();
    await warmUp(f);
    const before = (await f.feed.read.latestRoundData())[1];
    // WOOD doubles (half the WOOD for the same WETH), held for the next 7.5 minutes.
    await f.setPool(82.1, 20_900_000);
    for (let i = 0; i < 7; i++) await tick(f);
    await networkHelpers.time.increase(30);
    const mid = await f.feed.read.latestRoundData();
    // About half the window at 2×: ≈ 1.5× — nowhere near the new spot.
    const ratio = Number(mid[1]) / Number(before);
    assert.ok(ratio > 1.35 && ratio < 1.6, `half a window at 2× reads ${ratio.toFixed(3)}×`);
  });

  it('a spike held for a few seconds barely moves the average — a flash loan can’t reach it', async () => {
    const f = await deploy();
    await warmUp(f);
    const before = (await f.feed.read.latestRoundData())[1];
    await networkHelpers.time.increase(20);
    await f.setPool(82.1, 4_180_000); // 10× WOOD's price
    await networkHelpers.time.increase(2);
    await f.setPool(82.1, 41_800_000); // back
    await tick(f);
    const after = (await f.feed.read.latestRoundData())[1];
    const move = Math.abs(Number(after) / Number(before) - 1);
    assert.ok(move < 0.03, `a 10× spike for ~2 s moves the 15-minute average ${(move * 100).toFixed(2)}%`);
  });

  it('a pool below the liquidity floor prices nothing: its rounds answer 0', async () => {
    // The pool holds 2 × 82.1 × $2,650 ≈ $435k; a $500k floor refuses it.
    const f = await deploy({ minLiquidityUsd: parseEther('500000') });
    await warmUp(f);
    assert.equal((await f.feed.read.latestRoundData())[1], 0n, 'thin pool: a bad-price round');
    const liq = await f.feed.read.liquidityUsd();
    assert.ok(liq > parseEther('430000') && liq < parseEther('440000'), `liquidity ${liq}`);
    await viem.assertions.revertWithCustomError(f.feed.write.setMinLiquidityUsd([0n], { account: mallory.account }), f.feed, 'OwnableUnauthorizedAccount');
    await mined(f.feed.write.setMinLiquidityUsd([parseEther('400000')]));
    await tick(f);
    assert.ok((await f.feed.read.latestRoundData())[1] > 0n, 'above the floor: priced');
  });

  it('a stale quote feed prices nothing', async () => {
    const f = await deploy();
    await warmUp(f);
    // ETH/USD's last answer now more than 25 hours old.
    await networkHelpers.time.increase(90_100);
    await mined(f.feed.write.update());
    for (let i = 0; i < WINDOW / STEP + 1; i++) await tick(f);
    assert.equal((await f.feed.read.latestRoundData())[1], 0n);
  });

  it('circuit breaker: an hour without a round and the latest reads 0; history keeps its prices', async () => {
    const f = await deploy();
    const first = await warmUp(f);
    assert.ok((await f.feed.read.latestRoundData())[1] > 0n);
    await networkHelpers.time.increase(3601);
    assert.equal((await f.feed.read.latestRoundData())[1], 0n, 'stale: no new orders, no liquidations');
    assert.ok((await f.feed.read.getRoundData([first]))[1] > 0n, 'past rounds still settle orders');
  });

  it('after a gap in the record, no average until a fresh window has passed', async () => {
    const f = await deploy();
    await warmUp(f);
    const rounds = await f.feed.read.roundCount();
    await networkHelpers.time.increase(2 * 3600);
    await mined(f.feed.write.update());
    assert.equal(await f.feed.read.roundCount(), rounds, 'the observations before the gap are too old');
    for (let i = 0; i < WINDOW / STEP - 1; i++) await tick(f);
    assert.equal(await f.feed.read.roundCount(), rounds);
    await tick(f);
    assert.equal(await f.feed.read.roundCount(), rounds + 1n, 'a fresh window: rounds resume');
  });

  it('reads through the cumulative price wrapping past 2^256, as Uniswap V2 means it to', async () => {
    const f = await deploy();
    // A pool that's run for ages: its cumulatives just short of wrapping.
    await mined(f.pair.write.setCumulatives([maxUint256 - 10n ** 30n, maxUint256 - 10n ** 30n]));
    await f.setPool(82.1, 41_800_000);
    await warmUp(f);
    close((await f.feed.read.latestRoundData())[1], (82.1 / 41_800_000) * 2650, 'WOOD after the wrap');
  });

  it('refuses a pool that isn’t the kind it’s told, or a token that isn’t in it', async () => {
    const f = await deploy();
    const stranger = await viem.deployContract('MockToken', [18]);
    await assert.rejects(
      viem.deployContract('TwapRoundFeed', [feedConfig({ kind: V2, pair: f.pair.address, baseToken: stranger.address, quoteUsdFeed: f.ethUsd.address, source: 'x' }), owner.account.address]),
    );
    // A V2 pair has no observe(): as a V3 pool it can't be read.
    await assert.rejects(
      viem.deployContract('TwapRoundFeed', [feedConfig({ kind: V3, pair: f.pair.address, baseToken: f.wood.address, quoteUsdFeed: f.ethUsd.address, source: 'x' }), owner.account.address]),
    );
  });
});

describe('TwapRoundFeed on a Uniswap V3 pool', () => {
  it('prices from the pool’s tick: 1.0001^tick, in USD through ETH/USD — to a billionth', async () => {
    const f = await deployV3();
    await warmUp(f);
    const t = Number(await f.pool.read.tick());
    close((await f.feed.read.latestRoundData())[1], f.priceAt(t), 'CASHCAT');
    assert.ok(Math.abs(f.priceAt(t) / (CASHCAT_IN_WETH * 2650) - 1) < 1e-4, 'the tick is the pool’s price');
    // The pool holds 925 WETH: 2 × 925 × $2,650.
    assert.equal(await f.feed.read.liquidityUsd(), 2n * 925n * 2650n * 10n ** 18n);
  });

  it('either side of the pool: WETH priced in CASHCAT reads the inverse', async () => {
    const f = await deployV3();
    // The other token of the same pool, with its quote (CASHCAT) taken as $1.
    const inverse = await viem.deployContract('TwapRoundFeed', [
      feedConfig({ kind: V3, pair: f.pool.address, baseToken: f.weth.address, quoteUsdFeed: zeroAddress, minLiquidityUsd: 0n, source: 'Uniswap V3 CASHCAT/WETH' }),
      owner.account.address,
    ]);
    const both = { feed: inverse };
    await warmUp(both);
    const t = Number(await f.pool.read.tick());
    close((await inverse.read.latestRoundData())[1], 2650 / f.priceAt(t), 'WETH in CASHCAT');
  });

  it('the tick math holds across the range: sqrt(1.0001)^t built from its bits', async () => {
    const a = await viem.deployContract('MockToken', [18]);
    const b = await viem.deployContract('MockToken', [18]);
    const aIs0 = a.address.toLowerCase() < b.address.toLowerCase();
    for (const t of [-300_000, -95_690, -1, 0, 1, 12_345, 95_690, 300_000]) {
      const pool = await viem.deployContract('MockUniswapV3Pool', [a.address, b.address, t]);
      // Price token a in token b, b taken as $1: 1.0001^t if a is token0, else its inverse.
      const feed = await viem.deployContract('TwapRoundFeed', [
        feedConfig({ kind: V3, pair: pool.address, baseToken: a.address, quoteUsdFeed: zeroAddress, minLiquidityUsd: 0n, source: 'x' }),
        owner.account.address,
      ]);
      await warmUp({ feed });
      close((await feed.read.latestRoundData())[1], Math.pow(1.0001, aIs0 ? t : -t), `tick ${t}`);
    }
  });

  it('a V3 average is the geometric mean: half the window at 2× reads about √2×', async () => {
    const f = await deployV3();
    await warmUp(f);
    const before = (await f.feed.read.latestRoundData())[1];
    await mined(f.pool.write.setTick([f.tickFor(CASHCAT_IN_WETH * 2)]));
    for (let i = 0; i < 7; i++) await tick(f);
    await networkHelpers.time.increase(30);
    const ratio = Number((await f.feed.read.latestRoundData())[1]) / Number(before);
    assert.ok(ratio > 1.3 && ratio < 1.55, `half a window at 2× reads ${ratio.toFixed(3)}×`);
  });

  it('a swap and its reversal inside a few seconds barely move it', async () => {
    const f = await deployV3();
    await warmUp(f);
    const before = (await f.feed.read.latestRoundData())[1];
    await networkHelpers.time.increase(20);
    await mined(f.pool.write.setTick([f.tickFor(CASHCAT_IN_WETH * 10)]));
    await networkHelpers.time.increase(2);
    await mined(f.pool.write.setTick([f.tickFor(CASHCAT_IN_WETH)]));
    await tick(f);
    const move = Math.abs(Number((await f.feed.read.latestRoundData())[1]) / Number(before) - 1);
    assert.ok(move < 0.02, `a 10× spike for ~2 s moves it ${(move * 100).toFixed(2)}%`);
  });

  it('a pool holding under the floor prices nothing', async () => {
    const f = await deployV3({ minLiquidityUsd: parseEther('5000000') });
    await warmUp(f);
    assert.equal((await f.feed.read.latestRoundData())[1], 0n, '$4.9M < $5M');
  });

  it('AgriPerp settles an order on the first average that began after it', async () => {
    const f = await deployV3();
    const usdc = await viem.deployContract('MockUSDC');
    const agriFeed = await viem.deployContract('AgriFeed', [owner.account.address]);
    const vault = await viem.deployContract('AgriVault', [usdc.address, owner.account.address]);
    const perp = await viem.deployContract('AgriPerp', [vault.address, agriFeed.address, owner.account.address]);
    await mined(vault.write.setPerp([perp.address]));
    await mined(usdc.write.mint([owner.account.address, usd(1_000_000)]));
    await mined(usdc.write.approve([vault.address, maxUint256]));
    await mined(vault.write.addLiquidity([usd(1_000_000)]));
    await mined(usdc.write.mint([alice.account.address, usd(10_000)]));
    await mined(usdc.write.approve([vault.address, maxUint256], { account: alice.account }));

    await warmUp(f);
    await mined(agriFeed.write.listFeed(['CASHCAT', f.feed.address]));
    await mined(perp.write.listMarket(['CASHCAT', 5, usd(10_000), 0n]));

    const receipt = await mined(perp.write.requestOpen(['CASHCAT', true, usd(100), 2n, maxUint256, 10n, usd(101)], { account: alice.account }));
    const [ev] = parseEventLogs({ abi: perp.abi, logs: receipt.logs, eventName: 'OrderRequested' });
    assert.ok(ev);
    const requestedAt = BigInt(ev.args.requestedAt);

    // The next round's average began before the order: it can't settle it.
    await tick(f);
    const early = (await f.feed.read.latestRoundData())[0];
    await viem.assertions.revertWithCustomError(perp.write.executeOrder([ev.args.orderId, early]), agriFeed, 'ObservedBeforeRequest');

    // Fifteen-odd minutes on, the first average that began after the order settles it — by anyone.
    let settling = 0n;
    for (let i = 0; i < WINDOW / STEP + 6 && settling === 0n; i++) {
      await tick(f);
      const [id, , startedAt] = await f.feed.read.latestRoundData();
      if (startedAt >= requestedAt + 2n) settling = id;
    }
    assert.ok(settling > 0n, 'an average that began after the order');
    assert.ok((await now()) - requestedAt >= BigInt(WINDOW), 'a whole window after the order');
    await mined(perp.write.executeOrder([ev.args.orderId, settling], { account: mallory.account }));
    const position = await perp.read.getPosition([1n]);
    assert.equal(position.trader.toLowerCase(), alice.account.address.toLowerCase());
    // AgriFeed keeps 18 decimals: the entry is the average, as the feed gave it.
    const [, answer] = await f.feed.read.getRoundData([settling]);
    assert.equal(position.entryPrice, answer);
  });
});
