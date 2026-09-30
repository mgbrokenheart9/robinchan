import type { PerpMarketDef, PerpReportedFeed } from '@robinchan/shared';
import { reportedSource } from '@robinchan/shared';

import { publicClient } from '../chain';
import { REPORTED_ROUND_FEED_ABI } from './abi';
import { chainNow, chainState } from './chain';
import { perpsVenue } from './config';
import { keeperWallet, waitingOrderMarkets } from './keeper';
import { marketsHere, perpNetwork } from './network';

/**
 * The agri markets the operator prices (contracts/contracts/oracles/ReportedRoundFeed.sol):
 * the keeper reads each market's contract month from Yahoo Finance — delayed
 * about 10 minutes — and posts it with the time the exchange quoted it. An
 * order settles on the first round quoted after it, so the delay makes fills
 * slower, never predictable. Traders trust the operator for these prices;
 * the UI says where they come from.
 *
 * A round goes up when the price moved enough since the last one, or enough
 * market time passed — how much depends on what rides on the market
 * (reportedCadence) — and a closed market quotes nothing new, and posts
 * nothing. A move past the contract's cap (15%) is left for the owner to
 * check and post (`reportUnchecked`).
 *
 * Each round is a keeper transaction. Posting every market every 10 minutes
 * cost ~736 transactions a day on Robinhood Chain (2026-09-30), about half
 * of them for markets that weren't even listed: now a market nobody trades
 * gets a round an hour, an unlisted one none once it has the round its
 * listing needs, and one with an order waiting a round every 2 minutes.
 */

const YAHOO_URL = (): string => (process.env.YAHOO_CHART_URL?.trim() || 'https://query1.finance.yahoo.com/v8/finance/chart').replace(/\/+$/, '');

/**
 * When a market's next round goes up: a move of `move` since the last, or
 * `heartbeatSec` of market time. An order waiting fills on the first round
 * quoted after it — Yahoo's quotes run ~10 minutes behind, so not the next
 * quote but one a while on: every 2 minutes gets it there soon without a
 * transaction per quote. Open positions need a price near the market to be
 * liquidated on (0.2% or 10 minutes, as before); a market nobody holds only
 * keeps its price shown — 1% or an hour (PERPS_REPORTED_QUIET_SEC).
 */
export function reportedCadence(state: { orderWaiting: boolean; openInterest: number }): { move: number; heartbeatSec: number } {
  if (state.orderWaiting) return { move: 0.002, heartbeatSec: 120 };
  if (state.openInterest > 0) return { move: 0.002, heartbeatSec: 600 };
  const quiet = Number(process.env.PERPS_REPORTED_QUIET_SEC);
  return { move: 0.01, heartbeatSec: Number.isFinite(quiet) && quiet >= 600 ? quiet : 3_600 };
}
/** ReportedRoundFeed.MAX_QUOTE_AGE, less a margin: an older quote would be refused. */
const MAX_QUOTE_AGE_SEC = 3_300;
/** The contract's default cap on one round's move (constructor's maxMoveBps). */
const MAX_MOVE = 0.15;
/** Both months' quotes for a roll: no further apart than this. */
const ROLL_QUOTES_APART_SEC = 900;

type ReportedDef = PerpMarketDef & { reported: PerpReportedFeed & { roundFeed: `0x${string}` } };

export type YahooQuote = { symbol: string; price: number; quotedAt: number };

/** The network in scope's markets with a deployed ReportedRoundFeed. */
export function reportedRoundMarkets(): ReportedDef[] {
  return marketsHere().filter((m): m is ReportedDef => Boolean(m.reported?.roundFeed));
}

/**
 * Each network posts the same months: one read of Yahoo serves them all for
 * a few seconds (a quote is minutes old anyway), so three networks don't
 * triple the requests Yahoo sees.
 */
const QUOTE_REUSE_MS = 15_000;
const recentQuotes = new Map<string, { at: number; quote: Promise<YahooQuote | null> }>();

/**
 * The last trade of `symbol` on Yahoo Finance, in USD (US-cent quotes scaled),
 * with the time the exchange printed it. Null when Yahoo has no price.
 */
export function yahooQuote(symbol: string): Promise<YahooQuote | null> {
  const hit = recentQuotes.get(symbol);
  if (hit && Date.now() - hit.at < QUOTE_REUSE_MS) return hit.quote;
  const quote = fetchYahooQuote(symbol);
  recentQuotes.set(symbol, { at: Date.now(), quote });
  // A failure isn't kept: the next network asks again.
  quote.catch(() => recentQuotes.delete(symbol));
  return quote;
}

async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  const res = await fetch(`${YAHOO_URL()}/${encodeURIComponent(symbol)}?interval=1m&range=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (robinchan keeper)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  const body = (await res.json()) as {
    chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number; currency?: string } }> };
  };
  return parseYahooMeta(symbol, body.chart?.result?.[0]?.meta);
}

/** Yahoo's chart meta as a quote in USD — exported for tests. */
export function parseYahooMeta(
  symbol: string,
  meta: { regularMarketPrice?: number; regularMarketTime?: number; currency?: string } | undefined,
): YahooQuote | null {
  const raw = meta?.regularMarketPrice;
  const at = meta?.regularMarketTime;
  if (raw == null || at == null || !Number.isFinite(raw) || raw <= 0) return null;
  // USX: US cents, the way CBOT and ICE quote grains, coffee, sugar and cotton.
  const price = meta?.currency === 'USX' ? raw / 100 : raw;
  return { symbol, price, quotedAt: at };
}

/** An 8-decimal USD price, as the feed takes it. */
export const toFeedPrice = (usd: number): bigint => BigInt(Math.round(usd * 1e8));

const warned = new Map<string, number>();
function warnOnce(key: string, message: string, everyMs = 3_600_000): void {
  const last = warned.get(key);
  if (last != null && Date.now() - last < everyMs) return;
  warned.set(key, Date.now());
  console.warn(message);
}

/**
 * Keeps every deployed ReportedRoundFeed current: rolls to the next contract
 * month when its time comes, and posts a round when the quote moved or the
 * heartbeat passed.
 */
export async function runReportedRounds(): Promise<{ reported: number; rolled: number }> {
  const out = { reported: 0, rolled: 0 };
  const markets = reportedRoundMarkets();
  const net = perpNetwork();
  const tag = net === 'robinhood' ? '' : `${net} `;
  if (perpsVenue() !== 'agri-perp' || markets.length === 0) return out;
  const client = publicClient();
  const wallet = keeperWallet();
  if (!client || !wallet) return out;
  const cs = await chainState({ maxAgeSec: 30 }).catch(() => null);
  const waiting = waitingOrderMarkets();

  for (const def of markets) {
    const on = { address: def.reported.roundFeed, abi: REPORTED_ROUND_FEED_ABI } as const;
    try {
      const [reporter, source, rounds, rollFactor] = await Promise.all([
        client.readContract({ ...on, functionName: 'reporter' }),
        client.readContract({ ...on, functionName: 'source' }),
        client.readContract({ ...on, functionName: 'roundCount' }),
        client.readContract({ ...on, functionName: 'rollFactor' }),
      ]);
      // Not listed on the perps contract: nobody can trade it, so no gas on it — once it has
      // the round its listing needs (list-agri-markets.ts). Months roll when it's back.
      const m = cs?.markets[def.symbol];
      if (m && !m.listed && rounds > 0n) continue;
      const cadence = reportedCadence({ orderWaiting: waiting.has(def.symbol), openInterest: m ? m.longOi + m.shortOi : 0 });
      if (reporter.toLowerCase() !== wallet.account.address.toLowerCase()) {
        warnOnce(`reported:${net}:reporter:${def.symbol}`, `[perps] ${tag}${def.symbol}: the keeper isn't this feed's reporter (${reporter})`);
        continue;
      }
      const i = def.reported.months.findIndex((m) => reportedSource(m.symbol) === source);
      const month = def.reported.months[i];
      if (!month) {
        warnOnce(`reported:${net}:source:${def.symbol}`, `[perps] ${tag}${def.symbol}: the feed reads "${source}", which isn't a month in the registry`);
        continue;
      }
      const now = await chainNow();

      // The next contract month, once its roll time comes: both months quoted together set the factor.
      const next = def.reported.months[i + 1];
      const rollAt = month.rollAt ? Math.floor(Date.parse(month.rollAt) / 1000) : null;
      if (rollAt != null && now >= rollAt) {
        if (!next) {
          warnOnce(`reported:${net}:last:${def.symbol}`, `[perps] ${tag}${def.symbol}: ${month.symbol} is past its roll time and no next month is listed — add it, or pause the market before expiry`);
        } else {
          const [from, to] = await Promise.all([yahooQuote(month.symbol), yahooQuote(next.symbol)]);
          if (from && to && Math.abs(from.quotedAt - to.quotedAt) <= ROLL_QUOTES_APART_SEC && now - Math.min(from.quotedAt, to.quotedAt) <= MAX_QUOTE_AGE_SEC) {
            const hash = await wallet.writeContract({ ...on, functionName: 'roll', args: [toFeedPrice(from.price), toFeedPrice(to.price), reportedSource(next.symbol)] });
            await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
            out.rolled += 1;
          }
          continue;
        }
      }

      const quote = await yahooQuote(month.symbol);
      if (!quote || now - quote.quotedAt > MAX_QUOTE_AGE_SEC || quote.quotedAt > now) continue;
      const price = toFeedPrice(quote.price);
      const answer = (price * rollFactor) / 10n ** 18n;
      if (rounds > 0n) {
        const [, last, lastQuotedAt] = await client.readContract({ ...on, functionName: 'latestRoundData' });
        if (quote.quotedAt <= Number(lastQuotedAt)) continue;
        const move = Math.abs(Number(answer - last)) / Number(last);
        if (move > MAX_MOVE) {
          warnOnce(`reported:${net}:move:${def.symbol}`, `[perps] ${tag}${def.symbol}: ${month.symbol} moved ${(move * 100).toFixed(1)}% since the last round — past the cap, the owner has to check and post it (reportUnchecked)`);
          continue;
        }
        if (move < cadence.move && quote.quotedAt - Number(lastQuotedAt) < cadence.heartbeatSec) continue;
      }
      const hash = await wallet.writeContract({ ...on, functionName: 'report', args: [price, BigInt(quote.quotedAt)] });
      await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      out.reported += 1;
    } catch (err) {
      warnOnce(`reported:${net}:err:${def.symbol}`, `[perps] ${tag}${def.symbol} reported round failed: ${(err as Error).message.split('\n')[0]}`, 300_000);
    }
  }
  return out;
}
