import type { NewsItem } from '@robinchan/shared';
import { WATCHED_SYMBOLS } from '@robinchan/shared';
import { cacheKey, getCache, getDb } from '@robinchan/store';

import { fetchFilings } from '../providers/edgar.js';
import { fetchNews } from '../providers/finnhub.js';
import { fixtureNews, fixturesEnabled } from '../providers/fixtures.js';
import { log } from '../lib/log.js';

export const NEWS_TTL_SEC = 120;
const FEED_SIZE = 40;

/**
 * Two news providers, merged and handed off to the Db layer's dedupe. One
 * provider failing must not take down the other — the Market page has to
 * keep rendering sensibly when a single source is switched off (brief §17, M2).
 */
export async function runNews(): Promise<void> {
  const collected: NewsItem[] = [];

  const results = await Promise.allSettled([
    fetchNews(FEED_SIZE),
    fetchFilings(WATCHED_SYMBOLS, 12),
  ]);
  for (const result of results) {
    if (result.status === 'fulfilled') collected.push(...result.value);
    else log.debug('news', result.reason instanceof Error ? result.reason.message : 'failed');
  }

  if (collected.length === 0 && fixturesEnabled()) {
    collected.push(...fixtureNews(12));
  }

  if (collected.length === 0) {
    log.warn('news', 'no new items; leaving the old cache in place');
    return;
  }

  // The tape only shows headlines flagged as pinned (brief §6).
  const pinnedCount = collected.filter((n) => n.pinned).length;
  if (pinnedCount === 0) {
    for (const item of pickForTape(collected)) item.pinned = true;
  }

  const db = getDb();
  const inserted = await db.upsertNews(collected);
  const feed = await db.listNews({ limit: FEED_SIZE });
  await getCache().set(cacheKey('news', 'latest'), feed, NEWS_TTL_SEC);

  log.info('news', `${collected.length} fetched, ${inserted} new, feed ${feed.length}`);
}

/** The six most recent items with the strongest sentiment — enough for one tape loop. */
function pickForTape(items: NewsItem[]): NewsItem[] {
  return [...items]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 16)
    .sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))
    .slice(0, 6);
}
