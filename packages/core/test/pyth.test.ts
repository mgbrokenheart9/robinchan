import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { firstPrintAtOrAfter, pythRoundMarkets, type HermesPrint } from '../src/perps/pyth';
import { PERP_MARKETS, perpComingSoon } from '@robinchan/shared';

const FEED = '0xa61c21c0ca93300f50f231b52f59e9a6f47a07d33e78c1a9b8f84bd5928a3e8f' as const;

/**
 * A market printing every second while open: Friday until `close`, then
 * nothing until `reopen`, then every second up to `last`. Hermes answers for
 * a second something printed in, 404 (null) otherwise.
 */
function hermesStub(close: number, reopen: number, last: number) {
  const printed = (t: number) => t <= close || (t >= reopen && t <= last);
  const calls: number[] = [];
  const at = async (_id: string, t: number): Promise<HermesPrint | null> => {
    calls.push(t);
    if (!printed(t)) return null;
    const prev = t === reopen ? close : t - 1;
    return { data: `0x${t.toString(16)}`, publishTime: t, prevPublishTime: prev };
  };
  const latest = async () => last;
  return { at, latest, calls };
}

describe('Pyth: the first print at or after a slot', () => {
  test('while the market trades, it is the print at that second', async () => {
    const h = hermesStub(1_000, 200_000, 300_000);
    const p = await firstPrintAtOrAfter(FEED, 900, h.at, h.latest);
    assert.equal(p?.publishTime, 900);
    assert.equal(h.calls.length, 1);
  });

  test('over a closure, it is the reopening print — found by bisecting, not by walking every second', async () => {
    const h = hermesStub(1_000, 200_000, 300_000);
    const p = await firstPrintAtOrAfter(FEED, 1_200, h.at, h.latest);
    assert.equal(p?.publishTime, 200_000);
    assert.ok(p && p.prevPublishTime < 1_200, 'the print before it came before the slot');
    assert.ok(h.calls.length < 40, `${h.calls.length} Hermes calls`);
  });

  test('nothing printed since the slot opened: none yet', async () => {
    const h = hermesStub(1_000, 200_000, 150_000);
    assert.equal(await firstPrintAtOrAfter(FEED, 1_200, h.at, h.latest), null);
  });
});

describe('Pyth agri markets in the registry', () => {
  test('coffee, cocoa and sugar carry their Pyth months; coming soon until a round feed of theirs is deployed', () => {
    for (const symbol of ['COFF', 'COCC', 'SUGA']) {
      const def = PERP_MARKETS.find((m) => m.symbol === symbol)!;
      assert.ok(def.pyth && def.pyth.months.length > 0, symbol);
      for (const m of def.pyth.months) assert.match(m.feedId, /^0x[0-9a-f]{64}$/, `${symbol} ${m.pythSymbol}`);
      if (!def.pyth.roundFeed && !def.reported?.roundFeed) assert.ok(perpComingSoon(def) && def.unavailable, `${symbol} is coming soon`);
      else assert.ok(!def.unavailable, `${symbol} trades on a round feed`);
    }
    for (const symbol of ['CORN', 'SOYB', 'WEAT', 'PALM', 'RICE', 'COTT']) {
      assert.equal(PERP_MARKETS.find((m) => m.symbol === symbol)?.pyth, undefined, `${symbol} has no Pyth feed`);
    }
    assert.deepEqual(
      pythRoundMarkets().map((m) => m.symbol),
      PERP_MARKETS.filter((m) => m.pyth?.roundFeed).map((m) => m.symbol),
    );
  });
});
