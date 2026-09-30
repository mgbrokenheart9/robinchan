import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PERP_MARKETS, perpComingSoon, reportedSource } from '@robinchan/shared';

import { parseYahooMeta, reportedCadence, reportedRoundMarkets, toFeedPrice } from '../src/perps/reported';

describe('Reported agri prices: Yahoo Finance quotes', () => {
  test('US-cent quotes (grains, coffee, sugar, cotton) become USD; USD quotes (cocoa, rice) stay', () => {
    assert.deepEqual(parseYahooMeta('KCZ26.NYB', { regularMarketPrice: 278.1, regularMarketTime: 1_790_000_000, currency: 'USX' }), {
      symbol: 'KCZ26.NYB',
      price: 2.781,
      quotedAt: 1_790_000_000,
    });
    assert.equal(parseYahooMeta('CCZ26.NYB', { regularMarketPrice: 5603, regularMarketTime: 1, currency: 'USD' })?.price, 5603);
    assert.equal(toFeedPrice(2.781), 278_100_000n);
    assert.equal(toFeedPrice(0.1854), 18_540_000n);
  });

  test('no price, a non-positive one, or no quote time: no quote', () => {
    assert.equal(parseYahooMeta('X', undefined), null);
    assert.equal(parseYahooMeta('X', { regularMarketPrice: 0, regularMarketTime: 1, currency: 'USD' }), null);
    assert.equal(parseYahooMeta('X', { regularMarketPrice: 5, currency: 'USD' }), null);
  });
});

describe('Reported agri markets in the registry', () => {
  test('every agri market but palm oil has Yahoo months; coming soon until its feed is deployed', () => {
    const agri = PERP_MARKETS.filter((m) => m.category === 'agri');
    for (const m of agri) {
      if (m.symbol === 'PALM') {
        assert.equal(m.reported, undefined, 'palm oil: not on Yahoo Finance');
        continue;
      }
      assert.ok(m.reported && m.reported.months.length > 0, m.symbol);
      for (const month of m.reported.months) assert.match(month.symbol, /^[A-Z]{2}[FGHJKMNQUVXZ]\d{2}\.(CBT|NYB)$/, `${m.symbol} ${month.symbol}`);
      // Roll times come in order, and only the last month may lack one.
      const rolls = m.reported.months.map((x) => x.rollAt);
      assert.ok(rolls.slice(0, -1).every((r) => r !== null), `${m.symbol}: only the last month has no roll time`);
      const times = rolls.filter((r): r is string => r !== null).map((r) => Date.parse(r));
      assert.deepEqual(times, [...times].sort((a, b) => a - b), `${m.symbol}: rolls in order`);
      if (!m.reported.roundFeed && !m.pyth?.roundFeed) assert.ok(perpComingSoon(m) && m.unavailable, `${m.symbol} is coming soon`);
    }
    assert.equal(reportedSource('KCZ26.NYB'), 'Yahoo Finance KCZ26.NYB (delayed)');
    assert.deepEqual(
      reportedRoundMarkets().map((m) => m.symbol),
      PERP_MARKETS.filter((m) => m.reported?.roundFeed).map((m) => m.symbol),
    );
  });
});

describe('Reported agri prices: gas spent where it matters', () => {
  test('an order waiting: a round every 2 minutes; positions open: 0.2% or 10 minutes; quiet: 1% or an hour', () => {
    assert.deepEqual(reportedCadence({ orderWaiting: true, openInterest: 0 }), { move: 0.002, heartbeatSec: 120 });
    assert.deepEqual(reportedCadence({ orderWaiting: true, openInterest: 50 }), { move: 0.002, heartbeatSec: 120 });
    assert.deepEqual(reportedCadence({ orderWaiting: false, openInterest: 50 }), { move: 0.002, heartbeatSec: 600 });
    assert.deepEqual(reportedCadence({ orderWaiting: false, openInterest: 0 }), { move: 0.01, heartbeatSec: 3_600 });
  });

  test('the quiet heartbeat is configurable, never under 10 minutes', () => {
    process.env.PERPS_REPORTED_QUIET_SEC = '7200';
    try {
      assert.equal(reportedCadence({ orderWaiting: false, openInterest: 0 }).heartbeatSec, 7_200);
      process.env.PERPS_REPORTED_QUIET_SEC = '60';
      assert.equal(reportedCadence({ orderWaiting: false, openInterest: 0 }).heartbeatSec, 3_600);
    } finally {
      delete process.env.PERPS_REPORTED_QUIET_SEC;
    }
  });
});
