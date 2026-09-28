import type { GapBoard, GapRow, StockToken, UsSession } from '@robinchan/shared';
import { STOCK_TOKENS, perpMarket, usSession } from '@robinchan/shared';
import {
  appendGapHistory,
  buildGapBoard,
  fetchDexPairs,
  gapRow,
  gapSpark,
  oracleClient,
  readOraclePrices,
  type DexPair,
  type GapHistoryStore,
  type GapReference,
} from '@robinchan/core';
import { cacheKey, getCache } from '@robinchan/store';

import { log } from '../lib/log.js';
import { fixturesEnabled } from '../providers/fixtures.js';
import { fetchLastPrices } from '../providers/yahoo.js';
import { STRIP_FEEDS } from './prices.js';

/**
 * The Gap board (every 2 minutes): each Robinhood stock token's price across
 * its pools on Robinhood Chain against the last price its stock traded at.
 * Writes the board, and a point of gap history per 10 minutes.
 */
export const GAP_TTL_SEC = 300;
const HISTORY_TTL_SEC = 5 * 86_400;

const LISTED = STOCK_TOKENS.filter((t) => !t.unlisted);

/* ---- on chain: every token's pools ---- */

async function poolsFor(tokens: StockToken[]): Promise<Map<string, DexPair[]>> {
  const out = new Map<string, DexPair[]>();
  let failed = 0;
  // Five at a time: DexScreener allows 300 requests a minute, and 40 tokens
  // every two minutes stays far under it.
  for (let i = 0; i < tokens.length; i += 5) {
    await Promise.all(
      tokens.slice(i, i + 5).map(async (t) => {
        try {
          out.set(t.symbol, (await fetchDexPairs(t.address)).filter((p) => p.baseToken.address.toLowerCase() === t.address.toLowerCase()));
        } catch {
          failed += 1;
        }
      }),
    );
  }
  if (failed) log.warn('gap', `DexScreener: ${failed} of ${tokens.length} tokens unavailable this run`);
  return out;
}

/* ---- off chain: each stock's own price ---- */

/**
 * The stock's regular-session price from Yahoo Finance, refreshed as often
 * as it can move: every run while Wall Street is open, every quarter hour
 * otherwise (a close only changes once a day). Chainlink's Robinhood Chain
 * feed fills in for a stock Yahoo didn't answer for — it moves only on a
 * 0.5% change, so it's the fallback, not the source.
 */
const refs = new Map<string, GapReference & { fetchedAt: number }>();

function refreshEveryMs(session: UsSession): number {
  return session.state === 'regular' ? 60_000 : 15 * 60_000;
}

const CHAINLINK_FEEDS: Array<{ symbol: string; feed: `0x${string}` }> = LISTED.flatMap((t) => {
  const market = perpMarket(t.symbol);
  const feed = market?.category === 'stocks' ? market.contracts[0]?.feedId : STRIP_FEEDS.find((f) => f.symbol === t.symbol)?.feed;
  return feed ? [{ symbol: t.symbol, feed }] : [];
});

async function referencesFor(tokens: StockToken[], session: UsSession, now: number): Promise<Map<string, GapReference>> {
  if (!refs.size) {
    const saved = await getCache().get<Record<string, GapReference & { fetchedAt: number }>>(cacheKey('gap', 'refs'));
    for (const [symbol, ref] of Object.entries(saved ?? {})) refs.set(symbol, ref);
  }
  const due = tokens.filter((t) => {
    const ref = refs.get(t.symbol);
    return !ref || ref.source !== 'yahoo' || now - ref.fetchedAt > refreshEveryMs(session);
  });
  if (due.length) {
    try {
      for (const q of await fetchLastPrices(due.map((t) => t.symbol))) {
        refs.set(q.symbol, { price: q.price, at: q.at, source: 'yahoo', fetchedAt: now });
      }
    } catch (err) {
      log.warn('gap', `Yahoo Finance unavailable (${(err as Error).message}); Chainlink fills in where it can`);
    }
    // A Yahoo close from a few hours ago still beats Chainlink's coarser feed.
    const needed = (r: (GapReference & { fetchedAt: number }) | undefined) => !r || r.source !== 'yahoo' || now - r.fetchedAt > 6 * 3_600_000;
    const missing = CHAINLINK_FEEDS.filter((f) => due.some((t) => t.symbol === f.symbol) && needed(refs.get(f.symbol)));
    if (missing.length) {
      const read = await readOraclePrices(missing, oracleClient()).catch(() => []);
      for (const p of read) refs.set(p.symbol, { price: p.price, at: p.publishTime, source: 'chainlink', fetchedAt: now });
    }
    await getCache().set(cacheKey('gap', 'refs'), Object.fromEntries(refs), HISTORY_TTL_SEC);
  }
  return new Map([...refs].map(([symbol, { price, at, source }]) => [symbol, { price, at, source }]));
}

/* ---- dev stand-in ---- */

/** `RC_ENV=dev` with no pool reachable: a flagged sample, so the page can still be worked on. */
function sampleRows(now: number): GapRow[] {
  const minute = Math.floor(now / 60_000);
  return LISTED.slice(0, 16).map((t, i) => {
    const reference = 50 + ((i * 37) % 400);
    const gapPct = Math.sin(i * 1.7 + minute * 0.05) * (1.2 + (i % 4) * 0.6);
    return {
      symbol: t.symbol,
      name: t.name,
      token: t.address,
      onchain: reference * (1 + gapPct / 100),
      reference,
      referenceAt: new Date(now - 3_600_000).toISOString(),
      referenceSource: 'sample',
      gapPct,
      liquidityUsd: 40_000 + ((i * 71_000) % 3_000_000),
      volume24h: 10_000 + ((i * 53_000) % 900_000),
      pools: [],
      spark: Array.from({ length: 24 }, (_, k) => Math.sin(i * 1.7 + (minute - (24 - k) * 30) * 0.05) * (1.2 + (i % 4) * 0.6)),
    };
  });
}

/* ---- the run ---- */

export async function runGap(): Promise<void> {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const session = usSession(now);
  const cache = getCache();

  const [pools, references] = await Promise.all([poolsFor(LISTED), referencesFor(LISTED, session, now)]);
  let rows = LISTED.map((t) => gapRow(t, pools.get(t.symbol) ?? [], references.get(t.symbol) ?? null, []));
  let board: GapBoard;

  if (!rows.some((r) => r.onchain != null)) {
    if (!fixturesEnabled()) throw new Error('no stock token could be priced from its pools');
    board = buildGapBoard(session, sampleRows(now), 'sample', now);
    log.info('gap', 'no pool reachable: sample board (dev only)');
  } else {
    const gaps = Object.fromEntries(rows.flatMap((r) => (r.gapPct != null ? [[r.symbol, Number(r.gapPct.toFixed(4))]] : [])));
    const history = appendGapHistory(await cache.get<GapHistoryStore>(cacheKey('gap', 'history')), nowSec, gaps);
    rows = rows.map((r) => ({ ...r, spark: gapSpark(history, r.symbol, nowSec) }));
    board = buildGapBoard(session, rows, 'live', now);
    await cache.set(cacheKey('gap', 'history'), history, HISTORY_TTL_SEC);
  }

  await cache.set(cacheKey('gap', 'board'), board, GAP_TTL_SEC);
  const w = board.summary.widest;
  log.info(
    'gap',
    `${board.summary.tracked}/${board.rows.length} gaps (${session.label})` + (w ? `, widest ${w.symbol} ${w.gapPct.toFixed(2)}%` : ''),
  );
}
