import './setup';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { PerpCloseQuote, PerpOpenQuote } from '@robinchan/shared';
import {
  CRYPTO_MAX_LEVERAGE,
  GAPPING_MAX_LEVERAGE,
  PERP_MARKETS,
  answerToUsd,
  perpComingSoon,
  perpIsLiquidatable,
  perpLiquidationPrice,
  perpMarket,
  perpOracleFeeds,
  perpPayout,
  perpPricePnl,
  perpSessionOpen,
  tradablePerpMarkets,
} from '@robinchan/shared';
import { getDb, getPerpStore, type PerpActionRow } from '@robinchan/store';
import type { Hex, PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

process.env.FEATURE_PERPS = 'true';
process.env.PERPS_VENUE = 'paper';
process.env.PERPS_FUNDING_RATE_PER_HOUR = '0';
// No oracle reads in tests: prices go straight into the cache.
process.env.PERPS_ORACLE_RPC_URL = 'http://127.0.0.1:9';

const core = await import('../src/index');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const feedOf = (symbol: string) => perpMarket(symbol)!.contracts[0]!.feedId;

/** A Chainlink price as the worker caches it. */
function oracle(symbol: string, usd: number, ageSec = 1): import('../src/index').OraclePrice {
  const publishTime = Math.floor(Date.now() / 1000) - ageSec;
  return { symbol, feed: feedOf(symbol), price: usd, publishTime, roundId: String(publishTime), source: 'fixture' };
}

async function setPrice(symbol: string, usd: number, ageSec = 1): Promise<void> {
  await core.writeFeedPrices([oracle(symbol, usd, ageSec)]);
}

async function newUser(funded = true) {
  const account = privateKeyToAccount(generatePrivateKey());
  const row = await getDb().upsertUser(account.address);
  const user = { id: row.id, address: account.address };
  if (funded) await core.perpFaucet(user);
  return { account, user };
}

type Account = ReturnType<typeof privateKeyToAccount>;

async function sign(account: Account, quote: PerpOpenQuote | PerpCloseQuote): Promise<Hex> {
  assert.equal(quote.execution.kind, 'signature');
  if (quote.execution.kind !== 'signature') throw new Error('unreachable');
  const { domain, types, primaryType, message } = quote.execution.typedData;
  return account.signTypedData({ domain, types, primaryType, message } as Parameters<Account['signTypedData']>[0]);
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof core.PerpError, `expected PerpError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/**
 * A feed's rounds as a Chainlink proxy serves them — `(phase << 64) | n`,
 * each with when it was observed and when it landed — behind the two calls
 * the keeper makes.
 */
function stubFeed(rounds: Array<{ observed: number; landed: number }>, phase = 1n): PublicClient {
  const id = (n: number) => (phase << 64n) | BigInt(n);
  const row = (n: number) => {
    const r = rounds[n - 1];
    if (!r) throw new Error('No data present');
    return [id(n), 300_000_000_000n, BigInt(r.observed), BigInt(r.landed), id(n)] as const;
  };
  return {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) =>
      functionName === 'latestRoundData' ? row(rounds.length) : row(Number((args?.[0] as bigint) & 0xffffffffffffffffn)),
  } as unknown as PublicClient;
}

await setPrice('ETH', 3000);

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

describe('perps registry', () => {
  test('every feed is a Chainlink proxy address, listed once', () => {
    const feeds = PERP_MARKETS.flatMap((m) => m.contracts.map((c) => c.feedId));
    for (const f of feeds) assert.match(f, /^0x[0-9a-fA-F]{40}$/, f);
    assert.equal(new Set(feeds.map((f) => f.toLowerCase())).size, feeds.length);
    assert.equal(perpOracleFeeds().length, 9);
  });

  test('agri, SOL and ARB are listed but untradable: agri is coming soon, SOL and ARB have no Chainlink feed', () => {
    const agri = PERP_MARKETS.filter((m) => m.category === 'agri');
    assert.deepEqual(agri.map((m) => m.symbol), ['CORN', 'SOYB', 'WEAT', 'COFF', 'COCC', 'SUGA', 'PALM', 'RICE', 'COTT']);
    for (const m of agri) {
      assert.match(m.unavailable as string, /^Coming soon\./);
      assert.ok(perpComingSoon(m), m.symbol);
    }
    for (const m of [perpMarket('SOL')!, perpMarket('ARB')!]) {
      assert.match(m.unavailable as string, /Chainlink has no/);
      assert.ok(!perpComingSoon(m), m.symbol);
    }
    assert.deepEqual(
      tradablePerpMarkets().map((m) => m.symbol),
      ['BTC', 'ETH', 'AAPL', 'TSLA', 'NVDA', 'AMZN', 'GOOGL', 'MSFT', 'META'],
    );
  });

  test('crypto goes to 20× (the feed can lag 0.5%), stocks to 5× (they gap over weekends)', () => {
    for (const m of tradablePerpMarkets()) {
      assert.equal(m.maxLeverage, m.category === 'crypto' ? CRYPTO_MAX_LEVERAGE : GAPPING_MAX_LEVERAGE, m.symbol);
    }
    assert.equal(CRYPTO_MAX_LEVERAGE, 20);
    assert.equal(GAPPING_MAX_LEVERAGE, 5);
  });

  test('stocks trade 24/5: shut from Friday 20:00 to Sunday 20:00 New York, in summer and winter time', () => {
    const nvda = perpMarket('NVDA')!;
    const at = (iso: string) => perpSessionOpen(nvda, Date.parse(iso));
    assert.equal(at('2026-09-25T23:59:00Z'), true, 'Fri 19:59 EDT');
    assert.equal(at('2026-09-26T00:00:30Z'), false, 'Fri 20:00 EDT');
    assert.equal(at('2026-09-27T23:59:00Z'), false, 'Sun 19:59 EDT');
    assert.equal(at('2026-09-28T00:00:30Z'), true, 'Sun 20:00 EDT');
    assert.equal(at('2026-12-05T00:30:00Z'), true, 'Fri 19:30 EST');
    assert.equal(at('2026-12-05T01:30:00Z'), false, 'Fri 20:30 EST');
    assert.equal(perpSessionOpen(perpMarket('BTC')!, Date.parse('2026-09-26T12:00:00Z')), true, 'crypto never shuts');
  });

  test('contracts/deploy/markets.json matches the registry (regenerate with scripts/perps-markets.mts)', () => {
    const file = JSON.parse(readFileSync(new URL('../../../contracts/deploy/markets.json', import.meta.url), 'utf8'));
    assert.deepEqual(file, core.perpMarketsForDeploy());
    const pyth = JSON.parse(readFileSync(new URL('../../../contracts/deploy/pyth-feeds.json', import.meta.url), 'utf8'));
    assert.deepEqual(pyth, core.pythFeedsForDeploy());
  });
});

/* ------------------------------------------------------------------ */
/* Math, bars, rounds                                                  */
/* ------------------------------------------------------------------ */

describe('perps math (mirrors AgriPerp.sol)', () => {
  test("liquidation price is the brief's entry ∓ (0.8 / leverage) × entry, moved by funding owed", () => {
    near(perpLiquidationPrice({ side: 'long', entry: 3000, collateral: 1000, size: 10_000 }), 3000 - (0.8 / 10) * 3000);
    near(perpLiquidationPrice({ side: 'short', entry: 3000, collateral: 1000, size: 10_000 }), 3000 + (0.8 / 10) * 3000);
    // 50 of funding already owed on a long leaves 750 of room instead of 800.
    near(perpLiquidationPrice({ side: 'long', entry: 3000, collateral: 1000, size: 10_000, fundingOwed: 50 }), 3000 * (1 - 750 / 10_000));
  });

  test('PnL mirrors for shorts and caps at 9× collateral; payout never goes below zero', () => {
    near(perpPricePnl({ side: 'long', size: 10_000, collateral: 1000, entry: 3000, mark: 3150 }), 500);
    near(perpPricePnl({ side: 'short', size: 10_000, collateral: 1000, entry: 3000, mark: 3150 }), -500);
    near(perpPricePnl({ side: 'long', size: 50_000, collateral: 1000, entry: 3000, mark: 6000 }), 9000);
    assert.equal(perpPayout({ collateral: 1000, pnl: -1500, fundingOwed: 0 }), 0);
    assert.ok(perpIsLiquidatable({ collateral: 1000, pnl: -790, fundingOwed: 10 }));
    assert.ok(!perpIsLiquidatable({ collateral: 1000, pnl: -790, fundingOwed: 9 }));
  });

  test('Chainlink answers (8 decimals) become dollars', () => {
    near(answerToUsd(8_375_553_000_000n, 8), 83_755.53);
    near(answerToUsd('34145318048', 8), 341.45318048);
  });

  test('bars: ticks build them, rounds carry forward through quiet hours, shut hours get none', () => {
    let bars = core.applyTick([], '1H', 3600 * 10 + 5, 100);
    bars = core.applyTick(bars, '1H', 3600 * 10 + 900, 104);
    bars = core.applyTick(bars, '1H', 3600 * 10 + 1800, 98);
    bars = core.applyTick(bars, '1H', 3600 * 11 + 1, 101);
    bars = core.applyTick(bars, '1H', 3600 * 10, 500); // out of order: ignored
    assert.deepEqual(bars.map((b) => [b.open, b.high, b.low, b.close]), [[100, 104, 98, 98], [101, 101, 101, 101]]);

    // Rounds at 10:15 (100), 10:40 (102) and 13:30 (99): hours 11 and 12 hold 102.
    const rounds = [
      { timeSec: 3600 * 9 + 100, price: 97 },
      { timeSec: 3600 * 10 + 900, price: 100 },
      { timeSec: 3600 * 10 + 2400, price: 102 },
      { timeSec: 3600 * 13 + 1800, price: 99 },
    ];
    const step = core.stepBars(rounds, '1H', 3600 * 10, 3600 * 14 - 1);
    assert.deepEqual(step.map((b) => [b.time / 3600, b.open, b.high, b.low, b.close]), [
      [10, 97, 102, 97, 102],
      [11, 102, 102, 102, 102],
      [12, 102, 102, 102, 102],
      [13, 102, 102, 99, 99],
    ]);
    const shut = core.stepBars(rounds, '1H', 3600 * 10, 3600 * 14 - 1, (t) => t < 3600 * 11 || t >= 3600 * 13);
    assert.deepEqual(shut.map((b) => b.time / 3600), [10, 13]);

    const hourly = Array.from({ length: 30 }, (_, i) => ({ time: 1_000_000 + i * 3600, open: i, high: i, low: i, close: i, volume: 0 }));
    assert.equal(core.priceDayAgo(hourly, 1_000_000 + 29 * 3600), 5);
    assert.equal(core.priceDayAgo(hourly.slice(10), 1_000_000 + 29 * 3600), null);
  });

  test('the keeper reads each order’s fate as AgriFeed proves it: fill, wait, expire, or cancel on a new aggregator', async () => {
    const feed = feedOf('ETH');
    const id = (n: number, phase = 1n) => (phase << 64n) | BigInt(n);
    // Requested at 1,000: its round is observed from 1,002 (the margin) and lands from 1,001 to 1,100.
    const order = { phase: 1, observedFrom: 1_002, notBefore: 1_001, notAfter: 1_100 };
    const decide = (rounds: Array<{ observed: number; landed: number }>, now: number, phase = 1n) =>
      core.orderRound(stubFeed(rounds, phase), feed, order, now);

    // Round 2 lands after the request but was observed before it (in flight); round 3 is the one.
    const fill = await decide([{ observed: 900, landed: 913 }, { observed: 995, landed: 1_008 }, { observed: 1_050, landed: 1_063 }, { observed: 1_090, landed: 1_099 }], 1_099);
    assert.deepEqual(fill, { kind: 'fill', roundId: id(3), observedAt: 1_050, updatedAt: 1_063 });
    // Out-of-order observation times: the earliest qualifying round, as the contract's look-back finds it.
    const skewed = await decide([{ observed: 900, landed: 913 }, { observed: 1_003, landed: 1_014 }, { observed: 998, landed: 1_016 }, { observed: 1_060, landed: 1_073 }], 1_080);
    assert.equal(skewed.kind === 'fill' && skewed.roundId, id(2));
    // A round observed within the margin of the request doesn't count.
    assert.deepEqual(await decide([{ observed: 900, landed: 913 }, { observed: 1_001, landed: 1_014 }], 1_020), { kind: 'wait' });
    // Nothing landed yet, inside the window: wait. Past it: the latest round proves there was none.
    assert.deepEqual(await decide([{ observed: 900, landed: 913 }], 1_050), { kind: 'wait' });
    assert.deepEqual(await decide([{ observed: 900, landed: 913 }], 1_200), { kind: 'expire', roundId: id(1) });
    // Only in-flight rounds in the window, then rounds after it: the first after the window is the proof.
    const expire = await decide(
      [{ observed: 900, landed: 913 }, { observed: 995, landed: 1_008 }, { observed: 1_150, landed: 1_163 }, { observed: 1_300, landed: 1_313 }],
      1_400,
    );
    assert.deepEqual(expire, { kind: 'expire', roundId: id(3) });
    // A round in the window settles the order however late: fill, not expire.
    const late = await decide([{ observed: 900, landed: 913 }, { observed: 1_050, landed: 1_063 }, { observed: 1_150, landed: 1_163 }], 90_000);
    assert.equal(late.kind === 'fill' && late.roundId, id(2));
    // The proxy moved to a new aggregator: the order can only be cancelled.
    assert.deepEqual(await decide([{ observed: 1_050, landed: 1_063 }], 1_070, 2n), { kind: 'upgraded' });
  });

  test('statuses and reasons: a delisted market is close-free; a cancel names who asked', () => {
    const def = perpMarket('NVDA')!;
    const base = { symbol: 'NVDA', venue: 'agri-perp' as const, feedId: def.contracts[0]!.feedId, rollFactor: 1 };
    const delisted = { ...base, enabled: false, delisted: true, settlementPrice: 181.5, fundingRate: 0, fundingIndex: 0, fundingUpdatedAt: 0 };
    const status = core.perpMarketStatus(def, { ...delisted, maxLeverage: 5, maxOi: 1, longOi: 0, shortOi: 0 }, null, { venueConfigured: true });
    assert.equal(status.status, 'halted');
    assert.match(status.statusNote as string, /Delisted.*\$181\.500/);
    assert.equal(core.perpMarketStatus(perpMarket('CORN')!, null, null, { venueConfigured: true }).status, 'unavailable');

    assert.match(core.cancelText('expired', 'open'), /collateral is back/);
    assert.match(core.cancelText('expired', 'close'), /position is still open/);
    assert.match(core.cancelText('price past limit', 'close'), /position is still open/);
    assert.match(core.cancelText('cancelled by trader', 'open'), /You took the order back.*opening fee is kept/);
    assert.match(core.cancelText('feed upgraded', 'open'), /new aggregator/);
    assert.match(core.cancelText('cancelled by trader', 'close'), /position is still open/);
  });

  test('an on-chain order can be asked back once; after the ask the record says when, and offers no second one', () => {
    const row = {
      id: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      address: '0xabc',
      kind: 'open',
      venue: 'agri-perp',
      symbol: 'ETH',
      positionId: null,
      amount: null,
      status: 'pending',
      quote: null,
      chainOrderId: '7',
      cancelRequestedAt: null,
      txHash: null,
      txHashes: [],
      signature: null,
      error: null,
      expiresAt: null,
      checkedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies PerpActionRow;
    assert.equal(core.toPerpActionRecord(row).cancellable, true);
    const asked = core.toPerpActionRecord({ ...row, cancelRequestedAt: '2026-09-26T10:00:00.000Z' });
    assert.equal(asked.cancellable, false);
    assert.equal(asked.cancelRequestedAt, '2026-09-26T10:00:00.000Z');
    assert.equal(core.toPerpActionRecord({ ...row, chainOrderId: null }).cancellable, false, 'the request hasn’t landed');
    assert.equal(core.toPerpActionRecord({ ...row, kind: 'deposit' }).cancellable, false);
  });
});

/* ------------------------------------------------------------------ */
/* Paper venue, end to end                                             */
/* ------------------------------------------------------------------ */

describe('perps on the paper venue', () => {
  test('the market list: open on a live feed, closed past its heartbeat or its session, unavailable without one', async () => {
    const markets = await core.perpMarketViews();
    const eth = markets.find((m) => m.symbol === 'ETH')!;
    assert.equal(eth.status, 'open');
    near(eth.price as number, 3000);
    assert.equal(eth.maxLeverage, 20);
    assert.equal(markets.find((m) => m.symbol === 'CORN')?.status, 'unavailable');
    assert.equal(markets.find((m) => m.symbol === 'GOOGL')?.status, 'closed', 'no price yet');

    // A feed quiet past its 24-hour heartbeat (and the contract's 25-hour limit) has stopped.
    await setPrice('BTC', 84_000, 26 * 3600);
    const btc = (await core.perpMarketViews('crypto')).find((m) => m.symbol === 'BTC')!;
    assert.equal(btc.status, 'closed');
    assert.match(btc.statusNote as string, /last published 26h ago — past its daily heartbeat/);

    // Hours-old is normal for Chainlink: a stock is open or shut by its session alone.
    await setPrice('AAPL', 341, 3 * 3600);
    const aapl = (await core.perpMarketViews('stocks')).find((m) => m.symbol === 'AAPL')!;
    if (perpSessionOpen(perpMarket('AAPL')!)) assert.equal(aapl.status, 'open');
    else assert.match(aapl.statusNote as string, /Market closed for the weekend.*Sun 20:00 – Fri 20:00/);
  });

  test('open → mark → close, with a real wallet signature at each step', async () => {
    const { account, user } = await newUser();
    assert.equal((await core.perpAccount(user)).free, 10_000);

    const quote = await core.quotePerpOpen(user, { symbol: 'ETH', side: 'long', collateral: 1000, leverage: 10 });
    assert.equal(quote.size, 10_000);
    assert.equal(quote.fee, 10);
    near(quote.liquidationPrice, 3000 * (1 - 0.08));
    near(quote.acceptablePrice, 3000 * 1.005);

    const opened = await core.recordPerpAction(user, { actionId: quote.id, signature: await sign(account, quote) });
    assert.equal(opened.status, 'done', opened.error ?? '');
    assert.ok(opened.positionId);
    const account1 = await core.perpAccount(user);
    assert.equal(account1.free, 10_000 - 1010);
    assert.equal(account1.locked, 1000);

    await setPrice('ETH', 3150);
    const [pos] = await core.perpPositions(user);
    assert.ok(pos);
    near(pos.unrealizedPnl as number, 500);
    near(pos.equity as number, 1500);
    near(pos.pnlPct as number, 50);

    const close = await core.quotePerpClose(user, pos.id);
    near(close.fee, 10, 1e-9); // 0.1% of 10,000
    near(close.estPayout, 1490);
    const closed = await core.recordPerpAction(user, { actionId: close.id, signature: await sign(account, close) });
    assert.equal(closed.status, 'done', closed.error ?? '');
    assert.equal((await core.perpAccount(user)).free, 10_000 - 1010 + 1490);
    const [done] = await core.perpHistory(user, { page: 1, limit: 10 });
    assert.equal(done?.status, 'closed');
    near(done?.realizedPnl as number, 490, 1e-6);
    assert.equal((await core.perpPositions(user)).length, 0);
    await setPrice('ETH', 3000);
  });

  test('a price that moved past the limit fills nothing; nor does an expired quote or a stranger’s signature', async () => {
    const { account, user } = await newUser();
    const quote = await core.quotePerpOpen(user, { symbol: 'ETH', side: 'long', collateral: 100, leverage: 5 });
    await setPrice('ETH', 3100); // +3.3%, past the 0.5% bound
    const failed = await core.recordPerpAction(user, { actionId: quote.id, signature: await sign(account, quote) });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error as string, /moved past your 0.50% limit/);
    assert.equal((await core.perpAccount(user)).free, 10_000, 'nothing debited');
    await setPrice('ETH', 3000);

    const stranger = privateKeyToAccount(generatePrivateKey());
    const q2 = await core.quotePerpOpen(user, { symbol: 'ETH', side: 'short', collateral: 100, leverage: 5 });
    await rejects(core.recordPerpAction(user, { actionId: q2.id, signature: await sign(stranger, q2) }), 'BAD_REQUEST');

    // The stored quote is what's checked, never the page's copy: store one that already lapsed.
    const q3 = await core.quotePerpOpen(user, { symbol: 'ETH', side: 'short', collateral: 100, leverage: 5 });
    const row = (await getPerpStore().getAction(q3.id))!;
    const lapsed = await getPerpStore().insertAction({
      ...row,
      id: crypto.randomUUID(),
      quote: { ...(row.quote as PerpOpenQuote), expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    await rejects(core.recordPerpAction(user, { actionId: lapsed.id, signature: '0x00' }), 'QUOTE_EXPIRED');
    assert.equal((await getPerpStore().getAction(lapsed.id))?.status, 'expired');
  });

  test('refusals name the problem: no price, no oracle, balance, leverage, flag off', async () => {
    const { user } = await newUser();
    await rejects(core.quotePerpOpen(user, { symbol: 'GOOGL', side: 'long', collateral: 100, leverage: 2 }), 'MARKET_CLOSED');
    await rejects(core.quotePerpOpen(user, { symbol: 'CORN', side: 'long', collateral: 100, leverage: 2 }), 'NOT_TRADABLE');
    await rejects(core.quotePerpOpen(user, { symbol: 'ETH', side: 'long', collateral: 20_000, leverage: 2 }), 'INSUFFICIENT_BALANCE');
    await rejects(core.quotePerpOpen(user, { symbol: 'ETH', side: 'long', collateral: 100, leverage: 21 }), 'BAD_REQUEST');
    await rejects(core.quotePerpOpen(user, { symbol: 'NOPE', side: 'long', collateral: 100, leverage: 2 }), 'NOT_FOUND');
    // Paper orders fill at once: nothing ever waits, so nothing can be taken back.
    assert.deepEqual(await core.perpWaitingOrders(user), []);
    process.env.FEATURE_PERPS = 'false';
    try {
      await rejects(core.quotePerpOpen(user, { symbol: 'ETH', side: 'long', collateral: 100, leverage: 2 }), 'FEATURE_DISABLED');
    } finally {
      process.env.FEATURE_PERPS = 'true';
    }
  });

  test('the keeper liquidates at 80% loss and pays the trader what is left after the 10% reward', async () => {
    const { account, user } = await newUser();
    const quote = await core.quotePerpOpen(user, { symbol: 'ETH', side: 'short', collateral: 1000, leverage: 10 });
    await core.recordPerpAction(user, { actionId: quote.id, signature: await sign(account, quote) });
    await setPrice('ETH', 3000 * 1.079);
    assert.equal((await core.runPaperKeeper()).liquidated, 0, 'not yet');
    await setPrice('ETH', 3000 * 1.085);
    assert.equal((await core.runPaperKeeper()).liquidated, 1);
    const [liq] = await core.perpHistory(user, { page: 1, limit: 5 });
    assert.equal(liq?.status, 'liquidated');
    // Loss 850 → 150 left → trader keeps 135.
    near(liq?.payout as number, 135, 1e-4);
    near((await core.perpAccount(user)).free, 10_000 - 1010 + 135, 1e-4);
    await setPrice('ETH', 3000);
  });

  test('funding accrues against longs and for shorts, and a rate change is never retroactive', async () => {
    const { account, user } = await newUser();
    const [eth] = [(await getPerpStore().listMarketStates()).find((m) => m.symbol === 'ETH')!];
    // An hour ago the index was 0; 0.01%/h since then.
    await getPerpStore().upsertMarketState({ ...eth, fundingRate: 0.0001, fundingIndex: 0, fundingUpdatedAt: new Date(Date.now() - 3_600_000).toISOString() });
    process.env.PERPS_FUNDING_RATE_PER_HOUR = '0.0001';
    const quote = await core.quotePerpOpen(user, { symbol: 'ETH', side: 'long', collateral: 1000, leverage: 10 });
    await core.recordPerpAction(user, { actionId: quote.id, signature: await sign(account, quote) });
    // Jump the index forward by ten hours' worth.
    const now = (await getPerpStore().listMarketStates()).find((m) => m.symbol === 'ETH')!;
    await getPerpStore().upsertMarketState({ ...now, fundingIndex: now.fundingIndex + 0.001 });
    const [pos] = await core.perpPositions(user);
    near(pos!.fundingAccrued, 10, 0.01);

    // Rate change: accrued at the old rate up to now, then the new one.
    process.env.PERPS_FUNDING_RATE_PER_HOUR = '0.00005';
    assert.ok((await core.maintainPaperMarkets()).includes('ETH'));
    const after = (await getPerpStore().listMarketStates()).find((m) => m.symbol === 'ETH')!;
    assert.equal(after.fundingRate, 0.00005);
    assert.ok(after.fundingIndex >= now.fundingIndex + 0.001 + 0.0001 - 1e-6, 'the old rate accrued up to the change');
    // Past the contract's 0.01%/hour cap, a configured rate is refused (falls back to the default, 0).
    process.env.PERPS_FUNDING_RATE_PER_HOUR = '0.0002';
    assert.equal(core.fundingRatePerHour('ETH'), 0);
    process.env.PERPS_FUNDING_RATE_PER_HOUR = '0';
    await core.maintainPaperMarkets();
  });

  test('the faucet stops at its cap', async () => {
    const { user } = await newUser(false);
    process.env.PERPS_FAUCET_CAP_USDC = '20000';
    try {
      await core.perpFaucet(user);
      await core.perpFaucet(user);
      await rejects(core.perpFaucet(user), 'BAD_REQUEST');
      assert.equal((await core.perpAccount(user)).canFaucet, false);
    } finally {
      delete process.env.PERPS_FAUCET_CAP_USDC;
    }
  });
});
