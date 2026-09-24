import type { Address } from '@robinchan/shared';
import { todayUtc, writeDailySnapshot } from '@robinchan/core';
import { cacheKey, getCache, getDb } from '@robinchan/store';

import { log } from '../lib/log.js';

/**
 * Daily portfolio snapshot, 00:00 UTC (Portfolio §8). Historical value
 * can't be recomputed cheaply from chain, so one total per active user per
 * day is stored — and the chart starts on the first one, never earlier.
 *
 * "Active" = seen in the last 30 days. The last completed date is
 * remembered so a worker that was down at midnight catches up on boot
 * instead of leaving a hole.
 */
const ACTIVE_DAYS = 30;
const LAST_RUN_KEY = cacheKey('job', 'snapshots:last');

export async function runSnapshots(opts: { onlyIfDue?: boolean } = {}): Promise<void> {
  const today = todayUtc();
  if (opts.onlyIfDue) {
    const last = await getCache().get<{ date: string }>(LAST_RUN_KEY);
    if (last?.date === today) return;
  }

  const users = await getDb().listActiveUsers(new Date(Date.now() - ACTIVE_DAYS * 86_400_000));
  let ok = 0;
  let failed = 0;
  for (const user of users) {
    try {
      await writeDailySnapshot({ id: user.id, address: user.address as Address }, today);
      ok += 1;
    } catch (err) {
      failed += 1;
      log.warn('snapshot', `${user.address}: ${(err as Error).message}`);
    }
  }
  await getCache().set(LAST_RUN_KEY, { date: today }, 3 * 86_400);
  log.info('snapshot', `${today}: ${ok} portfolio snapshot(s)${failed ? `, ${failed} failed` : ''}`);
}

/** Milliseconds until the next 00:00 UTC. */
export function msUntilMidnightUtc(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
  return next - now.getTime();
}
