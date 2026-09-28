import type { MarketIndex, Ticker } from '@robinchan/shared';
import { MARKET_STRIP, SYMBOL_NAMES, WATCHED_SYMBOLS } from '@robinchan/shared';
import { oracleClient, roundHistory } from '@robinchan/core';
import { cacheKey, getCache } from '@robinchan/store';

import { fetchTokenStats } from '../providers/dexscreener.js';
import { fetchQuotes, type RawQuote } from '../providers/finnhub.js';
import { fixtureQuotes, fixtureSpark, fixturesEnabled } from '../providers/fixtures.js';
import { log } from '../lib/log.js';

/** Brief §8: prices & index every 10 seconds, 30-second Redis TTL. */
export const PRICE_TTL_SEC = 30;

const SPARK_POINTS = 24;

function toTicker(q: RawQuote, names: Record<string, string>): Ticker {
  return {
    symbol: q.symbol,
    name: names[q.symbol] ?? q.symbol,
    price: q.price,
    change: q.change,
    changePct: q.changePct,
    currency: 'USD',
  };
}

async function quotesFor(symbols: readonly string[], providerId?: string): Promise<RawQuote[]> {
  try {
    return await fetchQuotes(symbols, providerId);
  } catch (err) {
    if (!fixturesEnabled()) throw err;
    log.debug('prices', `provider unavailable, using fixture (${(err as Error).message})`);
    return fixtureQuotes(symbols);
  }
}

export async function runPrices(): Promise<void> {
  const cache = getCache();

  // The strip first: it comes from Chainlink (Finnhub's free plan has no
  // indices) and $RCHAN from a DEX, so a Finnhub 429 below mustn't hold it
  // up. Neither is ever invented outside dev: a card with no real number
  // isn't shown.
  const indices = await chainlinkStrip();
  const rchan = await rchanIndex();
  if (rchan) indices.push(rchan);
  await cache.set(cacheKey('market', 'indices'), indices, PRICE_TTL_SEC);

  const equities = await quotesFor(WATCHED_SYMBOLS);
  const tickers = equities.map((q) => toTicker(q, SYMBOL_NAMES));
  await Promise.all(tickers.map((t) => cache.set(cacheKey('price', t.symbol), t, PRICE_TTL_SEC)));

  // The "Market now" panel on Home only needs the top five (brief §4).
  const snapshot = [...tickers]
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5);
  await cache.set(cacheKey('market', 'snapshot'), snapshot, PRICE_TTL_SEC);
  log.info('prices', `${tickers.length} tickers, ${indices.length} indices updated`);
}

const STRIP_NAMES: Record<string, string> = Object.fromEntries(MARKET_STRIP.map((s) => [s.symbol, s.name]));

/**
 * Chainlink Data Feeds on Robinhood Chain — the same public proxies the perps
 * read (Chainlink's feed directory, checked on chain). SPY and QQQ stand in
 * for their indices; their feeds follow US hours, so they sit still over the
 * weekend.
 */
const STRIP_FEEDS: Array<{ symbol: string; feed: `0x${string}` }> = [
  { symbol: 'SPY', feed: '0x319724394D3A0e3669269846abE664Cd621f9f6A' },
  { symbol: 'QQQ', feed: '0x80901d846d5D7B030F26B480776EE3b29374C2ae' },
  { symbol: 'BTC', feed: '0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251' },
  { symbol: 'ETH', feed: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9' },
];

/** A feed moves on a 0.5% deviation: a minute between reads loses nothing. */
const STRIP_REFRESH_MS = 60_000;
let strip: { at: number; rows: MarketIndex[] } | null = null;

async function chainlinkStrip(): Promise<MarketIndex[]> {
  if (strip && Date.now() - strip.at < STRIP_REFRESH_MS) return [...strip.rows];
  const client = oracleClient();
  const now = Math.floor(Date.now() / 1000);
  const since = now - 86_400;
  const read = await Promise.all(
    STRIP_FEEDS.map(async ({ symbol, feed }): Promise<MarketIndex | null> => {
      if (!client) return null;
      try {
        // Oldest first, starting with the round in force a day ago.
        const history = await roundHistory(client, feed, since);
        const first = history[0];
        const last = history.at(-1);
        if (!first || !last) return null;
        const change = last.price - first.price;
        return {
          symbol,
          name: STRIP_NAMES[symbol] ?? symbol,
          price: last.price,
          change,
          changePct: first.price ? (change / first.price) * 100 : 0,
          currency: 'USD',
          spark: sparkOf(history, since, now),
        };
      } catch (err) {
        log.debug('prices', `${symbol}: Chainlink unavailable (${(err as Error).message.split('\n')[0]})`);
        return null;
      }
    }),
  );
  // A feed that didn't answer this time keeps its last row rather than vanish.
  const rows = STRIP_FEEDS.map(({ symbol }, i) => read[i] ?? strip?.rows.find((r) => r.symbol === symbol) ?? null).filter(
    (r): r is MarketIndex => r !== null,
  );
  if (!rows.length && fixturesEnabled()) {
    return fixtureQuotes(STRIP_FEEDS.map((f) => f.symbol)).map((q) => ({ ...toTicker(q, STRIP_NAMES), spark: fixtureSpark(q.symbol, SPARK_POINTS) }));
  }
  strip = { at: Date.now(), rows };
  return [...rows];
}

/** The price in force at each of SPARK_POINTS even steps across the day. */
function sparkOf(history: Array<{ timeSec: number; price: number }>, since: number, now: number): number[] {
  const out: number[] = [];
  let i = 0;
  for (let k = 0; k < SPARK_POINTS; k++) {
    const t = since + ((now - since) * k) / (SPARK_POINTS - 1);
    while (i + 1 < history.length && (history[i + 1] as { timeSec: number }).timeSec <= t) i++;
    out.push((history[i] as { price: number }).price);
  }
  return out;
}

async function rchanIndex(): Promise<MarketIndex | null> {
  try {
    const stats = await fetchTokenStats();
    return {
      symbol: 'RCHAN',
      name: STRIP_NAMES.RCHAN ?? '$RCHAN / USD',
      price: stats.priceUsd,
      change: (stats.priceUsd * stats.changePct24h) / 100,
      changePct: stats.changePct24h,
      currency: 'USD',
      // DexScreener's pair gives no history: no line rather than an invented one.
      spark: fixturesEnabled() ? fixtureSpark('RCHAN', SPARK_POINTS) : [],
    };
  } catch {
    // The contract address only exists after launch on Pons (open decision #2).
    // Until then only dev shows a stand-in.
    if (!fixturesEnabled()) return null;
    const [q] = fixtureQuotes(['RCHAN']);
    return { ...toTicker(q as RawQuote, STRIP_NAMES), spark: fixtureSpark('RCHAN', SPARK_POINTS) };
  }
}
