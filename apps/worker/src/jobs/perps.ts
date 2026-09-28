import type { Candle, CandleInterval, CandleSeries } from '@robinchan/shared';
import { CANDLE_INTERVALS, perpSessionOpen, scheduledContract } from '@robinchan/shared';
import {
  CANDLES_KEPT,
  DAY_AGO_KEY,
  INTERVAL_SEC,
  PERP_CANDLES_TTL_SEC,
  applyTick,
  bucketStart,
  expirePerpQuotes,
  keeperKey,
  maintainPaperMarkets,
  oracleClient,
  perpCandlesKey,
  perpMarks,
  perpsEnabled,
  perpsOracleMode,
  perpsVenue,
  priceDayAgo,
  readOraclePrices,
  roundHistory,
  runChainKeeper,
  runMockOracle,
  runOrderExecutor,
  runPaperKeeper,
  runPerpIndexer,
  runPerpMonitor,
  runPythRounds,
  runReportedRounds,
  stepBars,
  writeFeedPrices,
  type Mark,
  type OraclePrice,
} from '@robinchan/core';
import { getCache, getPerpStore } from '@robinchan/store';

import { callProvider } from '../providers/adapter.js';
import { fixturesEnabled } from '../providers/fixtures.js';
import { fixtureOraclePrices, fixtureValue } from '../providers/perps-fixtures.js';
import { describeError } from '../lib/describe-error.js';
import { log } from '../lib/log.js';

/**
 * Perps, on the worker (brief §5D, §11 step 3):
 *
 * - `runPerpPrices` — every few seconds, every market's latest Chainlink
 *   round, read in one multicall, into the cache the API reads; then each
 *   market's price goes into its chart bars.
 * - `runPerpOrders` — on chain, every few seconds: the keeper executes
 *   orders whose round is out (they fill within 20 s of it or not at all),
 *   releases the ones their traders asked back, and cancels the ones past
 *   their deadline. On a local chain (mock mode) it's also the oracle.
 * - `runPerpUpkeep` — lapsed quotes, transactions in flight, the contract's
 *   events, liquidations, delisted markets, and the paper venue's funding.
 *
 * Both keep running with the flag off while positions are still open, so
 * switching perps off never strands a position without its keeper.
 */

async function active(): Promise<boolean> {
  if (perpsEnabled()) return true;
  if (!perpsVenue()) return false;
  const open = await getPerpStore().listPositions({ statuses: ['open'], limit: 1 });
  return open.length > 0;
}

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

export async function runPerpPrices(): Promise<void> {
  if (!(await active())) return;
  let prices: OraclePrice[];
  try {
    prices = await callProvider({ id: 'chainlink', configured: true }, () => readOraclePrices());
  } catch (err) {
    if (!fixturesEnabled()) throw err;
    prices = fixtureOraclePrices();
    log.debug('perps', `Chainlink unreachable, using fixtures (${(err as Error).message})`);
  }
  await writeFeedPrices(prices);
  await updateCandles(await perpMarks());
}

/* ------------------------------------------------------------------ */
/* Chart bars from the price                                           */
/* ------------------------------------------------------------------ */

type Book = { series: Map<CandleInterval, Candle[]> };
const books = new Map<string, Book>();
let lastFlush = 0;
const FLUSH_MS = 60_000;

async function loadBook(mark: Mark): Promise<Book> {
  const cache = getCache();
  const series = new Map<CandleInterval, Candle[]>();
  for (const interval of CANDLE_INTERVALS) {
    const hit = await cache.get<CandleSeries>(perpCandlesKey(mark.symbol, interval)).catch(() => null);
    series.set(interval, hit?.candles ?? []);
  }
  const book: Book = { series };
  if ((series.get('1H') ?? []).length === 0) {
    await seedHistory(mark, book).catch((err) => log.warn('perps', `${mark.symbol}: no chart history (${(err as Error).message})`));
  }
  return book;
}

/**
 * First bars for a market that has none, so the chart and the 24h change
 * aren't empty for a day after launch. In dev, the fixture walk itself,
 * sampled back in time; otherwise the feed's own rounds from the last two
 * days (PERPS_BACKFILL_HOURS), read from Robinhood Chain.
 */
async function seedHistory(mark: Mark, book: Book): Promise<void> {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  if (mark.source === 'fixture') {
    // Anchored so the last bar meets the mark.
    const scale = mark.price / (fixtureValue(mark.symbol, nowMs) ?? mark.price);
    for (const interval of CANDLE_INTERVALS) {
      const size = INTERVAL_SEC[interval];
      const last = bucketStart(now, interval);
      const bars: Candle[] = [];
      for (let i = CANDLES_KEPT - 1; i >= 1; i -= 1) {
        const time = last - i * size;
        const samples = [0.05, 0.35, 0.7, 0.95].map((f) => (fixtureValue(mark.symbol, (time + size * f) * 1000) ?? 0) * scale);
        bars.push({ time, open: samples[0] as number, high: Math.max(...samples), low: Math.min(...samples), close: samples[3] as number, volume: 0 });
      }
      book.series.set(interval, bars);
    }
    return;
  }
  const feed = scheduledContract(mark.def)?.feedId;
  const client = oracleClient();
  if (!feed || !client) return;
  const hours = Number(process.env.PERPS_BACKFILL_HOURS ?? 48);
  const since = now - hours * 3600;
  const rounds = await roundHistory(client, feed, since);
  const open = (t: number) => perpSessionOpen(mark.def, t * 1000);
  for (const interval of CANDLE_INTERVALS) {
    // Minute bars over two days would be thousands: those start from now.
    if (INTERVAL_SEC[interval] < 3600) continue;
    book.series.set(interval, stepBars(rounds, interval, since, now, open));
  }
}

async function updateCandles(allMarks: Map<string, Mark>): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const mark of allMarks.values()) {
    let book = books.get(mark.symbol);
    if (!book) {
      book = await loadBook(mark);
      books.set(mark.symbol, book);
    }
    // A shut market's last price isn't a new trade. An open one's latest
    // round is the price of record until the next: it holds, bar to bar.
    if (!mark.fresh) continue;
    for (const interval of CANDLE_INTERVALS) {
      book.series.set(interval, applyTick(book.series.get(interval) ?? [], interval, nowSec, mark.price));
    }
  }
  if (Date.now() - lastFlush >= FLUSH_MS) {
    await flushCandles(nowSec);
    lastFlush = Date.now();
  }
}

async function flushCandles(nowSec: number): Promise<void> {
  const entries: Array<{ key: string; value: CandleSeries; ttlSec: number }> = [];
  const dayAgo: Record<string, number> = {};
  for (const [symbol, book] of books) {
    for (const [interval, candles] of book.series) {
      if (!candles.length) continue;
      entries.push({
        key: perpCandlesKey(symbol, interval),
        value: { symbol, interval, candles, source: 'provider' },
        ttlSec: PERP_CANDLES_TTL_SEC,
      });
    }
    const ref = priceDayAgo(book.series.get('1H') ?? [], nowSec);
    if (ref != null) dayAgo[symbol] = ref;
  }
  if (!entries.length) return;
  await getCache().setMany([...entries, { key: DAY_AGO_KEY, value: dayAgo, ttlSec: 3600 }]);
  log.debug('perps', `${entries.length} chart series flushed`);
}

/* ------------------------------------------------------------------ */
/* Upkeep                                                              */
/* ------------------------------------------------------------------ */

export async function runPerpUpkeep(): Promise<void> {
  if (!(await active())) return;
  const venue = perpsVenue();
  const expired = await expirePerpQuotes();
  const moved: string[] = [];
  if (expired) moved.push(`${expired} quotes expired`);

  if (venue === 'paper') {
    const changed = await maintainPaperMarkets();
    if (changed.length) moved.push(`funding rate changed: ${changed.join(', ')}`);
    const keeper = await runPaperKeeper();
    if (keeper.liquidated) moved.push(`${keeper.liquidated} paper positions liquidated`);
  } else if (venue === 'agri-perp') {
    // Orders run on their own, faster job (runPerpOrders). Each part runs
    // whatever the others did: an RPC refusing the indexer's reads mustn't
    // hold up liquidations.
    const monitor = await part('monitor', runPerpMonitor);
    if (monitor && (monitor.done || monitor.failed)) moved.push(`requests: ${monitor.done} settled, ${monitor.failed} failed`);
    const indexed = await part('indexer', runPerpIndexer);
    if (indexed?.events) moved.push(`${indexed.events} contract events indexed`);
    const keeper = await part('keeper', runChainKeeper);
    if (keeper?.settled) moved.push(`${keeper.settled} positions on delisted markets settled`);
    if (keeper?.txs.length) moved.push(`${keeper.liquidated} positions liquidated (${keeper.txs.join(', ')})`);
    else if (keeper?.candidates && !keeperKey()) log.warn('perps', `${keeper.candidates} liquidatable positions, but no KEEPER_PRIVATE_KEY — anyone may liquidate them`);
  }
  if (moved.length) log.info('perps', moved.join('; '));
}

async function part<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    log.error('perps', `${name} failed: ${describeError(err)}`);
    return null;
  }
}

/**
 * The agri markets' Pyth feeds: each round brought on chain from Hermes as
 * its slot opens, and the futures rolls carried out (core/perps/pyth.ts).
 * Nothing to do until a PythRoundFeed is deployed and in the registry.
 */
export async function runPythFeeds(): Promise<void> {
  if (perpsVenue() !== 'agri-perp' || !(await active())) return;
  const r = await runPythRounds();
  const moved: string[] = [];
  if (r.pushed) moved.push(`${r.pushed} Pyth rounds pushed`);
  if (r.rolled) moved.push(`${r.rolled} futures rolls carried out`);
  if (r.scheduled) moved.push(`${r.scheduled} rolls announced`);
  if (moved.length) log.info('perps', moved.join('; '));
}

/**
 * The agri markets the operator prices: Yahoo Finance quotes posted with the
 * time the exchange quoted them, and the contract-month rolls
 * (core/perps/reported.ts). Nothing to do until a ReportedRoundFeed is
 * deployed and in the registry.
 */
export async function runReportedFeeds(): Promise<void> {
  if (perpsVenue() !== 'agri-perp' || !(await active())) return;
  const r = await runReportedRounds();
  const moved: string[] = [];
  if (r.reported) moved.push(`${r.reported} agri prices posted`);
  if (r.rolled) moved.push(`${r.rolled} agri months rolled`);
  if (moved.length) log.info('perps', moved.join('; '));
}

/**
 * On chain, the keeper's order execution, on its own short schedule: an
 * order fills within 20 s of its round or the contract cancels it, so it
 * can't wait behind the rest of the upkeep. In mock mode (a local chain) the
 * worker first posts the cached prices into the local feeds.
 */
export async function runPerpOrders(): Promise<void> {
  if (perpsVenue() !== 'agri-perp' || !(await active())) return;
  const moved: string[] = [];
  if (perpsOracleMode() === 'mock') {
    const posted = await runMockOracle();
    if (posted) log.debug('perps', `${posted} mock rounds posted`);
  }
  const orders = await runOrderExecutor();
  if (orders.executed) moved.push(`${orders.executed} orders executed`);
  if (orders.cancelled) moved.push(`${orders.cancelled} orders expired, cancelled or released`);
  if (moved.length) log.info('perps', moved.join('; '));
}
