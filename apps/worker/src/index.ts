import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { cacheBackend, dbBackend, getDb, repoRoot } from '@robinchan/store';

loadEnv({ path: join(repoRoot(), '.env'), quiet: true });

const { runPrices } = await import('./jobs/prices.js');
const { runNews } = await import('./jobs/news.js');
const { runHeat } = await import('./jobs/heat.js');
const { runHeatReads } = await import('./jobs/reads.js');
const { runCandles } = await import('./jobs/candles.js');
const { runOrders } = await import('./jobs/orders.js');
const { runPerpOrders, runPerpPrices, runPerpUpkeep } = await import('./jobs/perps.js');
const { perpPriceIntervalMs } = await import('@robinchan/core');
const { runSnapshots, msUntilMidnightUtc } = await import('./jobs/snapshots.js');
const { runCalendar } = await import('./jobs/calendar.js');
const { runChannels, runClips } = await import('./jobs/media.js');
const { log } = await import('./lib/log.js');

/** Worker schedule — brief §8, plus the Trade/Heat/Portfolio brief §9. */
type Job = {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
};

const JOBS: Record<string, Job> = {
  // Brief §8 specifies 10s, but Finnhub's free tier has no batch quote
  // endpoint — one run fetches ~12 symbols individually (WATCHED_SYMBOLS +
  // INDEX_SYMBOLS), and at 10s that's ~72 req/min against a 60 req/min cap.
  // 20s keeps it at ~36 req/min with headroom for the news/calendar jobs'
  // occasional Finnhub calls too. This is exactly the check brief §11 asks
  // devs to do themselves before relying on an interval.
  prices: { name: 'prices', everyMs: 20_000, run: runPrices },
  news: { name: 'news', everyMs: 60_000, run: runNews },
  candles: { name: 'candles', everyMs: 60_000, run: runCandles },
  // Robinchan's reads follow the heat score's schedule (Heat §9).
  heat: {
    name: 'heat',
    everyMs: 5 * 60_000,
    run: async () => {
      await runHeat();
      await runHeatReads();
    },
  },
  // Expired quotes, pending transactions, limit orders.
  orders: { name: 'orders', everyMs: 30_000, run: runOrders },
  // Perps (Agri Perps brief §5D, §11): every market's Chainlink price in one
  // multicall, then chart bars; and the keeper — quotes, transactions in
  // flight, the contract's events, liquidations and funding. A 20× position
  // can be liquidated by a 4% move, so these run in seconds.
  perpPrices: { name: 'perp-prices', everyMs: perpPriceIntervalMs(), run: runPerpPrices },
  perps: { name: 'perps', everyMs: 5_000, run: runPerpUpkeep },
  // On chain, an order fills within 20 s of its round or not at all.
  perpOrders: { name: 'perp-orders', everyMs: 3_000, run: runPerpOrders },
  channels: { name: 'channels', everyMs: 10 * 60_000, run: runChannels },
  // 15 min, not 5: new uploads from these channels land a few times an
  // hour at most, and each run spends YouTube quota (see providers/youtube.ts).
  clips: { name: 'clips', everyMs: 15 * 60_000, run: runClips },
  calendar: { name: 'calendar', everyMs: 6 * 60 * 60_000, run: runCalendar },
  retention: {
    name: 'retention',
    everyMs: 12 * 60 * 60_000,
    run: () => getDb().pruneRetention(),
  },
};

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();
let stopping = false;

async function safeRun(job: Job): Promise<void> {
  if (stopping) return;
  // A slow run (an LLM call, a provider timing out) must not stack a second
  // copy of itself on the next tick.
  if (running.has(job.name)) {
    log.warn('worker', `${job.name} still running, skipping this tick`);
    return;
  }
  running.add(job.name);
  const started = Date.now();
  try {
    await job.run();
  } catch (err) {
    // One job failing must not bring down the process — other jobs keep running.
    log.error('worker', `${job.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running.delete(job.name);
    const ms = Date.now() - started;
    if (ms > 5000) log.warn('worker', `${job.name} took ${ms}ms`);
  }
}

const snapshotJob: Job = { name: 'snapshots', everyMs: 24 * 60 * 60_000, run: () => runSnapshots() };

/** 00:00 UTC every day (Portfolio §9), not "every 24h from whenever the worker started". */
function scheduleDaily(): void {
  const timer = setTimeout(() => {
    void safeRun(snapshotJob);
    scheduleDaily();
  }, msUntilMidnightUtc());
  timers.push(timer);
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  log.info(
    'worker',
    `cache=${cacheBackend()} db=${dbBackend()} env=${process.env.RC_ENV ?? 'dev'}`,
  );

  await getDb().migrate();

  // Initial order matters: news first so heat has material; prices before
  // candles, which anchor to them; heat before its reads.
  await safeRun(JOBS.news as Job);
  await Promise.all([
    safeRun(JOBS.prices as Job),
    safeRun(JOBS.channels as Job),
    safeRun(JOBS.clips as Job),
  ]);
  await safeRun(JOBS.candles as Job);
  await safeRun(JOBS.calendar as Job);
  await safeRun(JOBS.heat as Job);
  await safeRun(JOBS.orders as Job);
  await safeRun(JOBS.perpPrices as Job);
  await safeRun(JOBS.perps as Job);
  await safeRun(JOBS.perpOrders as Job);
  // Catch up if the worker was down at midnight.
  await safeRun({ ...snapshotJob, run: () => runSnapshots({ onlyIfDue: true }) });

  if (once) {
    log.info('worker', '--once mode complete');
    await getDb().close();
    return;
  }

  for (const job of Object.values(JOBS)) {
    timers.push(setInterval(() => void safeRun(job), job.everyMs));
  }
  scheduleDaily();
  log.info('worker', `${Object.keys(JOBS).length} interval jobs + daily snapshot scheduled`);
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log.info('worker', `${signal} received, stopping`);
  for (const timer of timers) clearInterval(timer);
  void getDb()
    .close()
    .finally(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await main();
