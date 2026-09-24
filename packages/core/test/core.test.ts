import './setup';

import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import type { HeatComponentsDetail, NewsItem, OrderQuote, Ticker } from '@robinchan/shared';
import { HEAT_SYMBOLS, SYMBOL_NAMES } from '@robinchan/shared';
import { cacheKey, getCache, getDb, type HeatRow, type OrderRow } from '@robinchan/store';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const core = await import('../src/index');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PRICES: Record<string, number> = {
  AAPL: 238.4, NVDA: 176.2, TSLA: 412.9, MSFT: 511, AMZN: 229.6, META: 742.1, GOOGL: 253.5, COIN: 318.9,
};

async function seedPrices(): Promise<void> {
  const cache = getCache();
  for (const [symbol, price] of Object.entries(PRICES)) {
    const t: Ticker = { symbol, name: SYMBOL_NAMES[symbol] ?? symbol, price, change: price * 0.01, changePct: 1, currency: 'USD' };
    await cache.set(cacheKey('price', symbol), t, 30);
  }
  await cache.set(
    cacheKey('market', 'indices'),
    [{ symbol: 'RCHAN', name: '$RCHAN / USD', price: 0.0421, change: 0, changePct: 0.5, currency: 'USD', spark: [] }],
    30,
  );
}

async function setPrice(symbol: string, price: number): Promise<void> {
  await getCache().set(
    cacheKey('price', symbol),
    { symbol, name: symbol, price, change: 0, changePct: 0, currency: 'USD' } satisfies Ticker,
    30,
  );
}

function components(onchain: number, news: number, drivers: string[]): HeatComponentsDetail {
  return {
    onchain: { score: onchain, volumeRatio: onchain * 2, holderGrowth: 0.02, liquidityHealth: 0.8, note: `Volume ${(onchain * 2).toFixed(1)}× the 20-day average`, source: 'fixture' },
    news: { score: news, count24h: drivers.length, avgSentiment: 0.3, drivers, note: `${drivers.length} stories in 24h` },
    social: { score: null, reason: 'belum_aktif' },
    weights: { onchain: 0.5625, news: 0.4375, social: 0 },
    events: [{ id: 'ev1', title: 'Volume spike', at: new Date().toISOString(), url: null }],
  };
}

async function seedHeat(): Promise<void> {
  const now = new Date().toISOString();
  const news: NewsItem[] = HEAT_SYMBOLS.map((s, i) => ({
    id: `n_${s}`,
    cat: 'NEWS',
    title: `${s} headline number ${i}`,
    short: `${s} headline`,
    symbols: [s],
    sentiment: 0.4,
    url: `https://example.com/${s}`,
    source: 'test',
    publishedAt: now,
  }));
  await getDb().upsertNews(news);
  const rows: HeatRow[] = HEAT_SYMBOLS.map((symbol, i) => ({
    symbol,
    score: 91.3 - i * 7.3,
    components: components(0.9 - i * 0.05, 0.6 - i * 0.03, [`n_${symbol}`]),
    computedAt: now,
  }));
  await getDb().upsertHeat(rows);
  await getCache().set(cacheKey('heat', 'top'), rows, 600);
}

async function makeUser(tier: 'free' | 'tier1' | 'tier3' = 'free') {
  const account = privateKeyToAccount(generatePrivateKey());
  const row = await getDb().upsertUser(account.address);
  return { account, user: { id: row.id, address: account.address, tier } };
}

async function signQuote(account: ReturnType<typeof privateKeyToAccount>, quote: OrderQuote) {
  assert.equal(quote.execution.kind, 'signature');
  if (quote.execution.kind !== 'signature') throw new Error('unreachable');
  const { domain, types, primaryType, message } = quote.execution.typedData;
  return account.signTypedData({ domain, types, primaryType, message } as Parameters<typeof account.signTypedData>[0]);
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof core.OrderError, `expected OrderError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

await seedPrices();
await seedHeat();

/* ------------------------------------------------------------------ */
/* Cost basis — Portfolio §8                                           */
/* ------------------------------------------------------------------ */

function filled(side: 'buy' | 'sell', qty: number, price: number, fee = 0, at = Date.now()): OrderRow {
  const iso = new Date(at).toISOString();
  return {
    id: `o${Math.random()}`, userId: 'u', address: '0x', side, symbol: 'NVDA', qty, orderType: 'market', limitPrice: null,
    status: 'filled', source: 'form', venue: 'paper', quotePrice: price, fillPrice: price, estTotal: null, fee,
    slippageBps: 50, quote: null, txHash: null, txHashes: [], signature: null, error: null, createdAt: iso, updatedAt: iso,
    expiresAt: null, submittedAt: iso, filledAt: iso, notifiedAt: null, checkedAt: null, nonce: null,
  };
}

describe('cost basis', () => {
  test('average cost across buys, fees included; sells draw the known units down first', () => {
    const t = Date.now();
    const pos = core.positionsFromOrders([
      filled('buy', 2, 100, 0.2, t),
      filled('buy', 2, 110, 0, t + 1),
      filled('sell', 1, 120, 0, t + 2),
    ]).get('NVDA');
    assert.equal(pos?.qty, 3);
    assert.ok(Math.abs((pos?.avgCost ?? 0) - 105.05) < 1e-9);

    const gone = core.positionsFromOrders([filled('buy', 2, 100, 0, t), filled('sell', 5, 90, 0, t + 1)]).get('NVDA');
    assert.equal(gone?.qty, 0);
    assert.equal(gone?.avgCost, null);
  });

  test('known, partial, manual and unknown — never a guess', () => {
    const pos = { qty: 3, avgCost: 105 };
    assert.deepEqual(core.applyBasis(3, pos, null), { state: 'known', avgCost: 105, knownQty: 3 });
    // Moved some out: what's left is still all Robinchan-bought.
    assert.equal(core.applyBasis(2, pos, null).state, 'known');
    assert.deepEqual(core.applyBasis(7, pos, null), { state: 'partial', avgCost: 105, knownQty: 3 });
    const mixed = core.applyBasis(7, pos, 90);
    assert.equal(mixed.state, 'manual');
    assert.equal(mixed.knownQty, 7);
    assert.ok(Math.abs((mixed.avgCost ?? 0) - (105 * 3 + 90 * 4) / 7) < 1e-9);
    assert.deepEqual(core.applyBasis(5, undefined, null), { state: 'unknown', avgCost: null, knownQty: 0 });
    assert.deepEqual(core.applyBasis(5, undefined, 80), { state: 'manual', avgCost: 80, knownQty: 5 });
  });
});

/* ------------------------------------------------------------------ */
/* Describes, doesn't advise — Heat §6, Portfolio §7                   */
/* ------------------------------------------------------------------ */

describe('advice guard', () => {
  test('flags advice, in English and Indonesian', () => {
    for (const text of [
      'This is the time to buy NVDA.',
      'You should diversify your portfolio.',
      'Consider trimming your TSLA position.',
      'Sebaiknya kamu diversifikasi.',
      'Saatnya beli sekarang, jangan sampai ketinggalan.',
      'I recommend taking profit here.',
      'Layak dibeli di harga ini.',
    ]) {
      assert.equal(core.soundsLikeAdvice(text), true, text);
    }
  });

  test('leaves descriptions alone', () => {
    for (const text of [
      'Volume is running at three times its 20-day average and the news tone is positive.',
      '62% of your portfolio is in one asset.',
      'Selling pressure eased after the filing; buy volume picked up in the afternoon.',
      'Volume naik tiga kali lipat dan beritanya positif.',
    ]) {
      assert.equal(core.soundsLikeAdvice(text), false, text);
    }
  });

  test('acceptRead rejects advice and trims to one short paragraph', () => {
    assert.equal(core.acceptRead('[happy] You should buy it now.'), null);
    const ok = core.acceptRead('[focused] **NVDA** is hot: volume is 3.2× its average and seven stories landed today.');
    assert.equal(ok, 'NVDA is hot: volume is 3.2× its average and seven stories landed today.');
  });
});

/* ------------------------------------------------------------------ */
/* The order pipeline — Trade §4                                       */
/* ------------------------------------------------------------------ */

describe('order pipeline (paper venue)', () => {
  test('market buy: quote → user signs the quote → filled at the live price', async () => {
    const { account, user } = await makeUser();
    const quote = await core.quoteOrder({
      user,
      intent: { side: 'buy', symbol: 'nvda', qty: 2, orderType: 'market', limitPrice: null },
      source: 'form',
    });
    assert.equal(quote.intent.symbol, 'NVDA');
    assert.equal(quote.address, account.address);
    assert.ok(Date.parse(quote.expiresAt) - Date.now() <= 30_000);
    assert.ok(Math.abs(quote.protocolFee - 2 * 176.2 * 0.001) < 1e-9);
    const signature = await signQuote(account, quote);
    const record = await core.recordOrder({ user, orderId: quote.id, signature });
    assert.equal(record.status, 'filled');
    assert.equal(record.fillPrice, 176.2);
    // A fill the user watched isn't announced again later.
    assert.equal((await core.pendingNotices(user.id)).length, 0);
  });

  test('the same intent from the chat and from the form builds the same order', async () => {
    const { user } = await makeUser();
    const intent = { side: 'buy' as const, symbol: 'AAPL', qty: 1, orderType: 'market' as const, limitPrice: null };
    const a = await core.quoteOrder({ user, intent, source: 'form' });
    const b = await core.quoteOrder({ user, intent, source: 'chat' });
    assert.deepEqual(a.intent, b.intent);
    for (const k of ['estPrice', 'estTotal', 'protocolFee', 'feeBps', 'slippageBps', 'venue', 'address'] as const) {
      assert.deepEqual(a[k], b[k], k);
    }
    assert.equal(a.execution.kind, b.execution.kind);
    if (a.execution.kind === 'signature' && b.execution.kind === 'signature') {
      const { orderId: _a, expiresAt: _ae, ...ma } = a.execution.typedData.message;
      const { orderId: _b, expiresAt: _be, ...mb } = b.execution.typedData.message;
      assert.deepEqual(ma, mb);
    }
  });

  test('refuses: untradable, unknown, not enough cash, not enough shares, no limit below Tier 3', async () => {
    const { user } = await makeUser();
    await rejects(core.quoteOrder({ user, intent: { side: 'buy', symbol: 'RCHAN', qty: 1, orderType: 'market', limitPrice: null }, source: 'form' }), 'NOT_TRADABLE');
    await rejects(core.quoteOrder({ user, intent: { side: 'buy', symbol: 'SPX', qty: 1, orderType: 'market', limitPrice: null }, source: 'form' }), 'NOT_TRADABLE');
    await rejects(core.quoteOrder({ user, intent: { side: 'buy', symbol: 'ZZZZ', qty: 1, orderType: 'market', limitPrice: null }, source: 'form' }), 'NOT_FOUND');
    await rejects(core.quoteOrder({ user, intent: { side: 'buy', symbol: 'NVDA', qty: 0, orderType: 'market', limitPrice: null }, source: 'form' }), 'BAD_REQUEST');
    await rejects(core.quoteOrder({ user, intent: { side: 'buy', symbol: 'META', qty: 60, orderType: 'market', limitPrice: null }, source: 'form' }), 'INSUFFICIENT_BALANCE');
    await rejects(core.quoteOrder({ user, intent: { side: 'sell', symbol: 'META', qty: 50, orderType: 'market', limitPrice: null }, source: 'form' }), 'INSUFFICIENT_BALANCE');
    // Past the per-order ceiling, before balances even matter.
    await rejects(core.quoteOrder({ user, intent: { side: 'sell', symbol: 'META', qty: 10_000, orderType: 'market', limitPrice: null }, source: 'form' }), 'BAD_REQUEST');
    await rejects(core.quoteOrder({ user, intent: { side: 'buy', symbol: 'NVDA', qty: 1, orderType: 'limit', limitPrice: 170 }, source: 'form' }), 'TIER_REQUIRED');
  });

  test('a quote is bound to its address, its signer, and its 30 seconds', async () => {
    const { account, user } = await makeUser();
    const quote = await core.quoteOrder({ user, intent: { side: 'buy', symbol: 'NVDA', qty: 1, orderType: 'market', limitPrice: null }, source: 'form' });
    const signature = await signQuote(account, quote);

    // Wallet switched mid-flow.
    const other = privateKeyToAccount(generatePrivateKey());
    await rejects(core.recordOrder({ user: { ...user, address: other.address }, orderId: quote.id, signature }), 'ADDRESS_MISMATCH');
    // Signed by someone else.
    const forged = await signQuote(other, quote);
    await rejects(core.recordOrder({ user, orderId: quote.id, signature: forged }), 'BAD_REQUEST');
    // Too late: two minutes on, the signature no longer counts.
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
    try {
      await rejects(core.recordOrder({ user, orderId: quote.id, signature }), 'QUOTE_EXPIRED');
    } finally {
      mock.timers.reset();
    }
    assert.equal((await getDb().getOrder(quote.id))?.status, 'expired');
  });

  test('limit order: signed now, rests, fills when the price crosses, and Robinchan is told', async () => {
    const { account, user } = await makeUser('tier3');
    // 30% above market: accepted, but it has to be acknowledged.
    const quote = await core.quoteOrder({ user, intent: { side: 'buy', symbol: 'MSFT', qty: 1, orderType: 'limit', limitPrice: 511 * 1.3 }, source: 'form' });
    assert.equal(quote.ack?.code, 'LIMIT_DEVIATION');
    const opened = await core.recordOrder({ user, orderId: quote.id, signature: await signQuote(account, quote) });
    assert.equal(opened.status, 'open');

    const below = await core.quoteOrder({ user, intent: { side: 'buy', symbol: 'AMZN', qty: 1, orderType: 'limit', limitPrice: 200 }, source: 'form' });
    assert.equal(below.ack, null);
    const resting = await core.recordOrder({ user, orderId: below.id, signature: await signQuote(account, below) });
    assert.equal(resting.status, 'open');

    const run1 = await core.runLimitWatcher();
    assert.ok(run1.filled >= 1, 'the MSFT limit above market fills at once');
    assert.equal((await getDb().getOrder(resting.id))?.status, 'open', 'AMZN at 200 waits');

    await setPrice('AMZN', 199.5);
    await core.runLimitWatcher();
    const amzn = await getDb().getOrder(resting.id);
    assert.equal(amzn?.status, 'filled');
    assert.equal(amzn?.fillPrice, 199.5);

    const notices = await core.pendingNotices(user.id);
    assert.ok(notices.some((n) => n.orderId === resting.id && /filled/.test(n.text)));
    await core.ackNotices(user.id, notices.map((n) => n.id));
    assert.equal((await core.pendingNotices(user.id)).length, 0);
    await setPrice('AMZN', 229.6);
  });

  test('cancel: only open limit orders, and a cancel racing a fill reports the fill', async () => {
    const { account, user } = await makeUser('tier3');
    const q = await core.quoteOrder({ user, intent: { side: 'buy', symbol: 'GOOGL', qty: 1, orderType: 'limit', limitPrice: 240 }, source: 'form' });
    const open = await core.recordOrder({ user, orderId: q.id, signature: await signQuote(account, q) });
    const cancelled = await core.cancelOrder(user, open.id);
    assert.equal(cancelled.status, 'cancelled');
    await rejects(core.cancelOrder(user, open.id), 'CONFLICT');

    const q2 = await core.quoteOrder({ user, intent: { side: 'buy', symbol: 'GOOGL', qty: 1, orderType: 'limit', limitPrice: 240 }, source: 'form' });
    await core.recordOrder({ user, orderId: q2.id, signature: await signQuote(account, q2) });
    await getDb().updateOrder(q2.id, { status: 'filled', fillPrice: 240 }, ['open']);
    await assert.rejects(core.cancelOrder(user, q2.id), /already filled/);
  });

  test('trading switched off refuses to quote', async () => {
    const { user } = await makeUser();
    process.env.FEATURE_TRADING = 'false';
    try {
      await rejects(core.quoteOrder({ user, intent: { side: 'buy', symbol: 'NVDA', qty: 1, orderType: 'market', limitPrice: null }, source: 'form' }), 'FEATURE_DISABLED');
    } finally {
      process.env.FEATURE_TRADING = 'true';
    }
  });
});

/* ------------------------------------------------------------------ */
/* Heat gating — Heat §6, API §9                                       */
/* ------------------------------------------------------------------ */

describe('heat board gating', () => {
  test('no wallet: top 5, rounded to 10, closed; the rest are placeholders with nothing in them', async () => {
    const board = await core.buildHeatBoard({ access: 'anon', userId: null }, { filter: 'all', sort: 'score', page: 1 });
    const visible = board.rows.filter((r) => !r.locked);
    const locked = board.rows.filter((r) => r.locked);
    assert.equal(visible.length, 5);
    assert.equal(locked.length, HEAT_SYMBOLS.length - 5);
    for (const r of visible) {
      if (r.locked) continue;
      assert.equal(r.score % 10, 0);
      assert.equal(r.components, null);
      assert.equal(r.expandable, false);
    }
    for (const r of locked) assert.deepEqual(Object.keys(r).sort(), ['locked', 'requiredTier']);
    await assert.rejects(core.buildHeatDetail({ access: 'anon', userId: null }, 'NVDA'), core.HeatAccessError);
  });

  test('wallet: top 15 with full scores and components; triggers and read stay locked', async () => {
    const board = await core.buildHeatBoard({ access: 'wallet', userId: 'u' }, { filter: 'all', sort: 'score', page: 1 });
    assert.equal(board.rows.filter((r) => !r.locked).length, Math.min(15, HEAT_SYMBOLS.length));
    const first = board.rows[0];
    assert.ok(first && !first.locked && first.components && first.score % 10 !== 0);
    const { detail } = await core.buildHeatDetail({ access: 'wallet', userId: 'u' }, 'NVDA');
    assert.equal(detail.triggers, null);
    assert.equal(detail.readLocked, true);
    const social = detail.components.find((c) => c.key === 'social');
    assert.equal(social?.score, null);
    assert.equal(social?.inactive, 'belum_aktif');
    await assert.rejects(
      core.buildHeatBoard({ access: 'wallet', userId: 'u' }, { filter: 'watchlist', sort: 'score', page: 1 }),
      core.HeatAccessError,
    );
  });

  test('Tier 1: triggers from the stored drivers, the watchlist filter, and filters/sorts', async () => {
    const { user } = await makeUser('tier1');
    const { detail, readMissing } = await core.buildHeatDetail({ access: 'tier1', userId: user.id }, 'NVDA');
    assert.ok(detail.triggers && detail.triggers.some((t) => t.id === 'n_NVDA' && t.url === 'https://example.com/NVDA'));
    assert.equal(readMissing, true);
    await getDb().setWatchlist(user.id, ['TSLA', 'RCHAN']);
    const watch = await core.buildHeatBoard({ access: 'tier1', userId: user.id }, { filter: 'watchlist', sort: 'score', page: 1 });
    assert.deepEqual(watch.rows.map((r) => (r.locked ? null : r.symbol)).sort(), ['RCHAN', 'TSLA']);
    const chain = await core.buildHeatBoard({ access: 'tier1', userId: user.id }, { filter: 'chain', sort: 'score', page: 1 });
    assert.deepEqual(chain.rows.map((r) => (r.locked ? null : r.symbol)), ['RCHAN']);
    const stocks = await core.buildHeatBoard({ access: 'tier1', userId: user.id }, { filter: 'stocks', sort: 'score', page: 1 });
    assert.ok(stocks.rows.every((r) => !r.locked && r.kind === 'stock'));
  });
});

/* ------------------------------------------------------------------ */
/* Portfolio — §7–8                                                    */
/* ------------------------------------------------------------------ */

describe('portfolio', () => {
  test('value, dust folded, unsupported apart, unknown cost basis never guessed', async () => {
    const { account, user } = await makeUser();
    const before = await core.buildPortfolio(user);
    assert.equal(before.source, 'fixture');
    assert.ok(before.dust.length >= 1 && before.dust.every((h) => (h.value ?? 0) < 1));
    assert.ok(before.unsupported.some((h) => h.symbol === 'AIRDROP'));
    const risky = [...before.holdings, ...before.dust, ...before.unsupported].filter((h) => h.costBasis !== 'cash');
    // Nothing was bought through Robinchan yet: every PnL is unknown, none invented.
    assert.ok(risky.every((h) => h.costBasis === 'unknown' && h.avgCost == null && h.pnl == null));
    assert.equal(before.unrealizedPnl, null);
    assert.equal(before.excludedFromPnl, risky.length);
    const sorted = before.holdings.map((h) => h.value ?? -1);
    assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));

    // Buy through Robinchan something the sample wallet already holds.
    const heldSymbol = before.holdings.find((h) => h.supported && h.costBasis === 'unknown' && h.symbol !== 'RCHAN')?.symbol ?? 'NVDA';
    const q = await core.quoteOrder({ user, intent: { side: 'buy', symbol: heldSymbol, qty: 1, orderType: 'market', limitPrice: null }, source: 'form' });
    await core.recordOrder({ user, orderId: q.id, signature: await signQuote(account, q) });
    await core.invalidateHoldings(user.address);
    const after = await core.buildPortfolio(user);
    const h = after.holdings.find((x) => x.symbol === heldSymbol);
    assert.equal(h?.costBasis, 'partial');
    assert.equal(h?.knownQty, 1);
    assert.ok(after.partialInPnl >= 1 && after.unrealizedPnl != null);
    const cashBefore = before.holdings.find((x) => x.costBasis === 'cash')?.qty ?? 0;
    const cashAfter = after.holdings.find((x) => x.costBasis === 'cash')?.qty ?? 0;
    assert.ok(cashAfter < cashBefore);

    // The user's own price for something bought elsewhere.
    const unknown = after.holdings.find((x) => x.costBasis === 'unknown' && x.price != null);
    assert.ok(unknown);
    await getDb().setCostBasis(user.id, unknown.symbol, 100);
    const manual = (await core.buildPortfolio(user)).holdings.find((x) => x.symbol === unknown.symbol);
    assert.equal(manual?.costBasis, 'manual');
    assert.equal(manual?.avgCost, 100);
  });

  test('the chart starts on the first day it is seen, never earlier', async () => {
    const { user } = await makeUser();
    const history = await core.portfolioHistory(user, 'all');
    assert.equal(history.trackedSince, core.todayUtc());
    assert.ok(history.points.length >= 1);
    assert.ok(history.points.every((p) => p.time >= Date.parse(`${core.todayUtc()}T00:00:00Z`) / 1000));
  });

  test('the portfolio read describes, and the fallback template never advises', async () => {
    const { user } = await makeUser();
    const p = await core.buildPortfolio(user);
    const text = core.portfolioReadTemplate(p);
    assert.match(text, /largest position/);
    assert.equal(core.soundsLikeAdvice(text), false);
  });
});

/* ------------------------------------------------------------------ */
/* Order parsing cross-check (no model needed for these)               */
/* ------------------------------------------------------------------ */

describe('order parsing', () => {
  test('pre-filter only sends order-shaped messages to the model', () => {
    assert.equal(core.looksLikeOrder('buy 4 NVDA at 172'), true);
    assert.equal(core.looksLikeOrder('beli 2 lembar tesla'), true);
    assert.equal(core.looksLikeOrder("how's nvda doing today?"), false);
    assert.equal(core.looksLikeOrder('what does an 8-K filing mean?'), false);
  });
});
