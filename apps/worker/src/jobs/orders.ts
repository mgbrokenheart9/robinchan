import { expireQuotes, runLimitWatcher, runPendingMonitor } from '@robinchan/core';

import { log } from '../lib/log.js';

/**
 * Every 30 seconds (Trade §9: "Pantau limit order"):
 *
 * - quotes nobody signed are marked expired;
 * - sent transactions are checked against the chain, so an order's status
 *   is right even if the user signed and closed the tab (Trade §4);
 * - resting limit orders are checked against the price and executed —
 *   from the signature the user gave when placing them — when it crosses.
 *
 * Runs whether or not `FEATURE_TRADING` is on: switching trading off must
 * not orphan orders that are already on their way.
 */
export async function runOrders(): Promise<void> {
  const expired = await expireQuotes();
  const pending = await runPendingMonitor();
  const limits = await runLimitWatcher();
  const moved = expired + pending.filled + pending.failed + pending.cancelled + limits.filled + limits.expired;
  if (moved > 0) {
    log.info(
      'orders',
      `quotes expired ${expired}; tx filled ${pending.filled}, failed ${pending.failed}, cancelled ${pending.cancelled}; limits filled ${limits.filled}, expired ${limits.expired}`,
    );
  } else if (pending.unchanged > 0) {
    log.debug('orders', `${pending.unchanged} transaction(s) still pending`);
  }
}
