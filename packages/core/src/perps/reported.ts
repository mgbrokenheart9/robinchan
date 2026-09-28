import type { PerpMarketDef, PerpReportedFeed } from '@robinchan/shared';
import { PERP_MARKETS, reportedSource } from '@robinchan/shared';

import { publicClient } from '../chain';
import { REPORTED_ROUND_FEED_ABI } from './abi';
import { chainNow } from './chain';
import { perpsVenue } from './config';
import { keeperWallet } from './keeper';

/**
 * The agri markets the operator prices (contracts/contracts/oracles/ReportedRoundFeed.sol):
 * the keeper reads each market's contract month from Yahoo Finance — delayed
 * about 10 minutes — and posts it with the time the exchange quoted it. An
 * order settles on the first round quoted after it, so the delay makes fills
 * slower, never predictable. Traders trust the operator for these prices;
 * the UI says where they come from.
 *
 * A round goes up when the price moved RECORD_MOVE since the last one, or
 * HEARTBEAT_SEC of market time passed — a closed market quotes nothing new,
 * and posts nothing. A move past the contract's cap (15%) is left for the
 * owner to check and post (`reportUnchecked`).
 */

const YAHOO_URL = (): string => (process.env.YAHOO_CHART_URL?.trim() || 'https://query1.finance.yahoo.com/v8/finance/chart').replace(/\/+$/, '');
/** A move this large (0.2%) makes a round without waiting for the heartbeat. */
const RECORD_MOVE = 0.002;
/** Market time between rounds while the price holds still. */
const HEARTBEAT_SEC = 600;
/** ReportedRoundFeed.MAX_QUOTE_AGE, less a margin: an older quote would be refused. */
const MAX_QUOTE_AGE_SEC = 3_300;
/** The contract's default cap on one round's move (constructor's maxMoveBps). */
const MAX_MOVE = 0.15;
/** Both months' quotes for a roll: no further apart than this. */
const ROLL_QUOTES_APART_SEC = 900;

type ReportedDef = PerpMarketDef & { reported: PerpReportedFeed & { roundFeed: `0x${string}` } };

export type YahooQuote = { symbol: string; price: number; quotedAt: number };

/** The markets with a deployed ReportedRoundFeed. */
export function reportedRoundMarkets(): ReportedDef[] {
  return PERP_MARKETS.filter((m): m is ReportedDef => Boolean(m.reported?.roundFeed));
}

/**
 * The last trade of `symbol` on Yahoo Finance, in USD (US-cent quotes scaled),
 * with the time the exchange printed it. Null when Yahoo has no price.
 */
export async function yahooQuote(symbol: string): Promise<YahooQuote | null> {
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
  if (perpsVenue() !== 'agri-perp' || markets.length === 0) return out;
  const client = publicClient();
  const wallet = keeperWallet();
  if (!client || !wallet) return out;

  for (const def of markets) {
    const on = { address: def.reported.roundFeed, abi: REPORTED_ROUND_FEED_ABI } as const;
    try {
      const [reporter, source, rounds, rollFactor] = await Promise.all([
        client.readContract({ ...on, functionName: 'reporter' }),
        client.readContract({ ...on, functionName: 'source' }),
        client.readContract({ ...on, functionName: 'roundCount' }),
        client.readContract({ ...on, functionName: 'rollFactor' }),
      ]);
      if (reporter.toLowerCase() !== wallet.account.address.toLowerCase()) {
        warnOnce(`reported:reporter:${def.symbol}`, `[perps] ${def.symbol}: the keeper isn't this feed's reporter (${reporter})`);
        continue;
      }
      const i = def.reported.months.findIndex((m) => reportedSource(m.symbol) === source);
      const month = def.reported.months[i];
      if (!month) {
        warnOnce(`reported:source:${def.symbol}`, `[perps] ${def.symbol}: the feed reads "${source}", which isn't a month in the registry`);
        continue;
      }
      const now = await chainNow();

      // The next contract month, once its roll time comes: both months quoted together set the factor.
      const next = def.reported.months[i + 1];
      const rollAt = month.rollAt ? Math.floor(Date.parse(month.rollAt) / 1000) : null;
      if (rollAt != null && now >= rollAt) {
        if (!next) {
          warnOnce(`reported:last:${def.symbol}`, `[perps] ${def.symbol}: ${month.symbol} is past its roll time and no next month is listed — add it, or pause the market before expiry`);
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
          warnOnce(`reported:move:${def.symbol}`, `[perps] ${def.symbol}: ${month.symbol} moved ${(move * 100).toFixed(1)}% since the last round — past the cap, the owner has to check and post it (reportUnchecked)`);
          continue;
        }
        if (move < RECORD_MOVE && quote.quotedAt - Number(lastQuotedAt) < HEARTBEAT_SEC) continue;
      }
      const hash = await wallet.writeContract({ ...on, functionName: 'report', args: [price, BigInt(quote.quotedAt)] });
      await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      out.reported += 1;
    } catch (err) {
      warnOnce(`reported:err:${def.symbol}`, `[perps] ${def.symbol} reported round failed: ${(err as Error).message.split('\n')[0]}`, 300_000);
    }
  }
  return out;
}
