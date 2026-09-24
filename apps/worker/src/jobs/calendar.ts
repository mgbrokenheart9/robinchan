import { cacheKey, getCache, getDb } from '@robinchan/store';

import { fetchEarnings } from '../providers/finnhub.js';
import { fixtureCalendar, fixturesEnabled } from '../providers/fixtures.js';
import { log } from '../lib/log.js';

export const CALENDAR_TTL_SEC = 7200;
const HORIZON_DAYS = 21;

export async function runCalendar(): Promise<void> {
  const db = getDb();
  let events = [] as Awaited<ReturnType<typeof fetchEarnings>>;

  try {
    events = await fetchEarnings(HORIZON_DAYS);
  } catch (err) {
    if (!fixturesEnabled()) throw err;
    log.debug('calendar', `provider unavailable (${(err as Error).message})`);
    events = fixtureCalendar();
  }

  if (events.length === 0) {
    log.warn('calendar', 'no events; leaving old data in place');
    return;
  }

  await db.upsertCalendar(events);
  const upcoming = await db.listCalendar(12);
  await getCache().set(cacheKey('calendar', 'upcoming'), upcoming, CALENDAR_TTL_SEC);
  log.info('calendar', `${events.length} events, ${upcoming.length} upcoming`);
}
