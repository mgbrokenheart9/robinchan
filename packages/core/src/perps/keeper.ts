import type { PerpCancelQuote, PerpCollateralQuote, PerpQuote } from '@robinchan/shared';
import {
  PERP_CANCEL_DELAY_SEC,
  PERP_MIN_LIQUIDATION_REWARD,
  perpIsLiquidatable,
  perpMarket,
  perpPayout,
  perpPricePnl,
  tradablePerpMarkets,
} from '@robinchan/shared';
import { cacheKey, getCache, getPerpStore, type PerpActionRow, type PerpPositionRow } from '@robinchan/store';
import { createWalletClient, http, parseEventLogs, type Hex, type Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { publicClient, viemChain } from '../chain';
import { chainConfig } from '../env';
import { AGRI_PERP_ABI, CHAINLINK_FEED_ABI, MOCK_AGGREGATOR_ABI } from './abi';
import { chainNow, chainState, explainRevert, marketKey, revertName, type ChainMarket, type ChainState } from './chain';
import { latestRound, orderRound, type FeedRound } from './chainlink';
import { agriPerpContracts, fundingRatePerHour, keeperKey, perpsOracleMode, perpsVenue } from './config';
import { perpMarks } from './markets';
import { feedPrice, readFeedPrices } from './prices';
import { fundingIndexAt, fundingOwed, paperMarketRows } from './state';

/**
 * The worker's side of perps (brief §5D and §11 step 3): quotes that lapsed,
 * requests in flight, the contract's events mirrored into the database, the
 * keeper's permissionless calls (executing and cancelling orders,
 * liquidating, settling delisted markets), and the paper venue's funding.
 * Everything here is safe to run next to the web app: state changes are
 * conditional on the state they expect, and the contract re-checks anything
 * the keeper sends.
 */

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const WAD = 1e18;
const USDC = 1e6;
/** AgriPerp.OBSERVATION_MARGIN: a round counts as observed after a request only from this long after it. */
const OBSERVATION_MARGIN_SEC = 2;
/** Chain reads at once. */
const PARALLEL_READS = 16;
/** An order sent this recently has a transaction in flight: it isn't sent again. */
const SENT_TTL_MS = 60_000;
/** AgriPerp.setLiquidation's lowest threshold: no position's own is lower. */
const LOOSEST_LIQUIDATION_THRESHOLD = 0.5;
/** Mock mode: a local feed gets a fresh round at least this often, like a live feed's heartbeat, shortened. */
const MOCK_HEARTBEAT_SEC = 3_600;

const warned = new Map<string, number>();
/** Logs a warning once per key — or once per `everyMs`, for a condition that may come back. */
function warnOnce(key: string, message: string, everyMs = Infinity): void {
  const last = warned.get(key);
  if (last != null && Date.now() - last < everyMs) return;
  warned.set(key, Date.now());
  console.warn(message);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

function keeperWallet() {
  const key = keeperKey();
  const chain = chainConfig();
  if (!key || !chain) return null;
  return createWalletClient({ account: privateKeyToAccount(key), chain: viemChain(chain), transport: http(chain.rpcUrl) });
}

/* ------------------------------------------------------------------ */
/* Quotes and requests in flight                                       */
/* ------------------------------------------------------------------ */

/** Quotes left unsigned past their window. Transaction quotes get longer: an approval may still be confirming. */
export async function expirePerpQuotes(): Promise<number> {
  const store = getPerpStore();
  let n = 0;
  for (const a of await store.listActions({ statuses: ['quoted'], limit: 500 })) {
    const quote = a.quote as PerpQuote | PerpCollateralQuote | PerpCancelQuote | null;
    const leash = quote?.execution.kind === 'transactions' ? 10 * 60_000 : 60_000;
    if (a.expiresAt && Date.now() > Date.parse(a.expiresAt) + leash) {
      if (await store.updateAction(a.id, { status: 'expired' }, ['quoted'])) n += 1;
    }
  }
  return n;
}

const DROPPED_AFTER_MS = 30 * 60_000;

/**
 * One pending action against the chain. First its transaction: reverted
 * (the reason, in words) or mined. A deposit or withdrawal is then done; an
 * open or close request has created an order, and waits for it to be
 * executed — done with its position, or failed with the reason it was
 * cancelled (the price broke its bound, it expired, the trader took it
 * back). While it waits, a cancel its trader asked for is noted on it.
 */
export async function checkPendingPerpAction(action: PerpActionRow): Promise<'unchanged' | 'done' | 'failed'> {
  const store = getPerpStore();
  const client = publicClient();
  const c = agriPerpContracts();
  if (!client || !c || action.status !== 'pending') return 'unchanged';

  let orderId = action.chainOrderId;
  if (orderId == null) {
    let mined = false;
    for (const hash of [...action.txHashes].reverse()) {
      const receipt = await client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
      if (!receipt) continue;
      const tx = await client.getTransaction({ hash: hash as Hex }).catch(() => null);
      if (!tx || tx.from.toLowerCase() !== action.address) continue;
      if (receipt.status !== 'success') {
        await store.updateAction(action.id, { status: 'failed', txHash: hash, error: await explainRevert(tx) }, ['pending']);
        return 'failed';
      }
      mined = true;
      const [requested] = parseEventLogs({ abi: AGRI_PERP_ABI, eventName: 'OrderRequested', logs: receipt.logs, strict: true });
      if (!requested) {
        // A deposit or a withdrawal: nothing further to wait for.
        await store.updateAction(action.id, { status: 'done', txHash: hash }, ['pending']);
        return 'done';
      }
      orderId = requested.args.orderId.toString();
      await store.updateAction(action.id, { chainOrderId: orderId, txHash: hash, checkedAt: new Date().toISOString() }, ['pending']);
      break;
    }
    if (!mined) {
      if (Date.now() - Date.parse(action.updatedAt) > DROPPED_AFTER_MS) {
        await store.updateAction(action.id, { status: 'failed', error: 'The transaction never confirmed. Check the wallet; nothing was recorded.' }, ['pending']);
        return 'failed';
      }
      await store.updateAction(action.id, { checkedAt: new Date().toISOString() }, ['pending']);
      return 'unchanged';
    }
  }

  const order = await client.readContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'getOrder', args: [BigInt(orderId as string)] });
  if (order.status === 1) {
    const asked = order.cancelRequestedAt > 0n && !action.cancelRequestedAt ? new Date(Number(order.cancelRequestedAt) * 1000).toISOString() : undefined;
    await store.updateAction(action.id, { checkedAt: new Date().toISOString(), cancelRequestedAt: asked }, ['pending']);
    return 'unchanged';
  }
  if (order.status === 3) {
    const reason = await cancelReason(BigInt(orderId as string), action.kind === 'close' ? 'close' : 'open');
    await store.updateAction(action.id, { status: 'failed', error: reason }, ['pending']);
    return 'failed';
  }
  // Executed: make sure the position it opened or closed is mirrored, then point the action at it.
  const chain = chainConfig();
  let row = chain ? await store.getChainPosition(chain.id, order.positionId.toString()) : null;
  if (!row || (action.kind === 'close' && row.status === 'open')) {
    await runPerpIndexer();
    row = chain ? await store.getChainPosition(chain.id, order.positionId.toString()) : null;
  }
  if (row && !row.userId) await store.updatePosition(row.id, { userId: action.userId });
  await store.updateAction(action.id, { status: 'done', positionId: row?.id ?? action.positionId }, ['pending']);
  return 'done';
}

/** The contract's cancel reasons, for the trader. */
export function cancelText(reason: string, kind: 'open' | 'close'): string {
  const after = kind === 'open' ? 'Your collateral is back.' : 'The position is still open.';
  switch (reason) {
    case 'price past limit':
      return `The price moved past your limit before the order executed, so nothing was filled. ${after}`;
    case 'cancelled by trader':
      return kind === 'open'
        ? 'You took the order back. Your collateral is back; the opening fee is kept, as the order held the pool’s liquidity while it waited.'
        : 'You took the close back. The position is still open.';
    case 'expired':
      return `Chainlink published no price for the order within its 25-hour window (the market may have been shut), so it was released. ${after}`;
    case 'feed upgraded':
      return `Chainlink moved the market's feed to a new aggregator before the order filled, so it was cancelled. ${after}`;
    case 'bad price':
      return `Chainlink's price for the order came out invalid, so it was cancelled. ${after}`;
    case 'market delisted':
      return kind === 'open'
        ? 'The market was delisted before the order executed. Your collateral is back.'
        : 'The market was delisted: the position settles at its last price instead.';
    case 'position no longer open':
      return 'The position was already closed (or liquidated) when the close executed.';
    default:
      return `The order was cancelled: ${reason || 'no reason given'}.`;
  }
}

async function cancelReason(orderId: bigint, kind: 'open' | 'close'): Promise<string> {
  const c = agriPerpContracts();
  const client = publicClient();
  if (!c || !client) return 'The order was cancelled.';
  const logs = await client
    .getContractEvents({ address: c.perp, abi: AGRI_PERP_ABI, eventName: 'OrderCancelled', args: { orderId }, fromBlock: deployBlock() })
    .catch(() => []);
  return cancelText(logs.at(-1)?.args.reason ?? '', kind);
}

function deployBlock(): bigint {
  const raw = process.env.AGRI_DEPLOY_BLOCK?.trim();
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

export async function runPerpMonitor(): Promise<{ done: number; failed: number; waiting: number }> {
  const counts = { done: 0, failed: 0, waiting: 0 };
  for (const a of await getPerpStore().listActions({ statuses: ['pending'], limit: 200 })) {
    const r = await checkPendingPerpAction(a);
    if (r === 'done') counts.done += 1;
    else if (r === 'failed') counts.failed += 1;
    else counts.waiting += 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* The contract's events, mirrored                                     */
/* ------------------------------------------------------------------ */

/**
 * PositionOpened / Closed / Liquidated into `perp_positions`, idempotently —
 * the monitor and the indexer may both see the same event.
 */
export async function applyPerpLogs(logs: Log[], opts: { userId?: string | null } = {}): Promise<PerpPositionRow[]> {
  const c = agriPerpContracts();
  const client = publicClient();
  const chain = chainConfig();
  if (!c || !client || !chain) return [];
  const store = getPerpStore();
  const events = parseEventLogs({
    abi: AGRI_PERP_ABI,
    eventName: ['PositionOpened', 'PositionClosed', 'PositionLiquidated'],
    logs: logs.filter((l) => l.address.toLowerCase() === c.perp.toLowerCase()),
    strict: true,
  });
  const touched: PerpPositionRow[] = [];

  const mirrorOpen = async (positionId: bigint, txOpen: string | null, fee: number) => {
    const onchain = await client.readContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'getPosition', args: [positionId] });
    const symbol = await client.readContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'symbolOf', args: [onchain.market] });
    const def = perpMarket(symbol);
    if (!def) return null;
    return store.upsertChainPosition({
      userId: opts.userId ?? null,
      address: onchain.trader.toLowerCase(),
      venue: 'agri-perp',
      chainId: chain.id,
      chainPositionId: positionId.toString(),
      symbol: def.symbol,
      category: def.category,
      side: onchain.isLong ? 'long' : 'short',
      collateral: Number(onchain.collateral) / USDC,
      size: Number(onchain.size) / USDC,
      leverage: Number(onchain.size / onchain.collateral),
      entryPrice: Number(onchain.entryPrice) / WAD,
      entryIndex: Number(onchain.entryIndex) / WAD,
      entryFunding: Number(onchain.entryFunding) / WAD,
      reserve: Number(onchain.reserve) / USDC,
      fee,
      status: 'open',
      exitPrice: null,
      exitIndex: null,
      realizedPnl: null,
      fundingPaid: null,
      payout: null,
      liquidationReward: null,
      txOpen,
      txClose: null,
      openedAt: new Date(Number(onchain.openedAt) * 1000).toISOString(),
      closedAt: null,
    });
  };

  for (const ev of events) {
    if (ev.eventName === 'PositionOpened') {
      const row = await mirrorOpen(ev.args.positionId, ev.transactionHash, Number(ev.args.fee) / USDC);
      if (row) touched.push(row);
      continue;
    }
    const id = ev.args.positionId.toString();
    // Closed before we saw it open (the indexer catching up): mirror the open first.
    const row = (await store.getChainPosition(chain.id, id)) ?? (await mirrorOpen(ev.args.positionId, null, 0));
    if (!row) continue;
    const payout = Number(ev.args.payout) / USDC;
    const updated = await store.updatePosition(
      row.id,
      {
        status: ev.eventName === 'PositionClosed' ? 'closed' : 'liquidated',
        exitPrice: Number(ev.args.exitPrice) / WAD,
        exitIndex: Number(ev.args.exitIndex) / WAD,
        realizedPnl: round6(payout - row.collateral),
        fundingPaid: round6(Number(ev.args.funding) / USDC),
        payout,
        liquidationReward: ev.eventName === 'PositionLiquidated' ? Number(ev.args.reward) / USDC : null,
        txClose: ev.transactionHash,
        closedAt: new Date().toISOString(),
      },
      ['open'],
    );
    touched.push(updated ?? row);
  }
  return touched;
}

/**
 * Follows the contract's events from the last block seen, so positions
 * opened from anywhere (another frontend, a script) and liquidations by
 * anyone show up in history, open interest and the keeper's list.
 */
export async function runPerpIndexer(): Promise<{ from: bigint; to: bigint; events: number } | null> {
  const c = agriPerpContracts();
  const client = publicClient();
  const chain = chainConfig();
  if (perpsVenue() !== 'agri-perp' || !c || !client || !chain) return null;
  const cursorKey = cacheKey('perp', `indexer:${chain.id}:${c.perp.toLowerCase()}`);
  const cache = getCache();
  const saved = await cache.get<{ next: string }>(cursorKey);
  const latest = await client.getBlockNumber();
  let from = saved ? BigInt(saved.next) : deployBlock() || (latest > 5_000n ? latest - 5_000n : 0n);
  if (from > latest) return { from, to: latest, events: 0 };
  const start = from;
  let events = 0;
  while (from <= latest) {
    const to = from + 1_999n < latest ? from + 1_999n : latest;
    const logs = await client.getLogs({ address: c.perp, fromBlock: from, toBlock: to });
    events += (await applyPerpLogs(logs)).length;
    from = to + 1n;
    // Kept for weeks: a worker that's been down resumes where it left off.
    await cache.set(cursorKey, { next: from.toString() }, 30 * 86_400);
  }
  return { from: start, to: latest, events };
}

/* ------------------------------------------------------------------ */
/* Keeper: orders, liquidations, delisted markets                      */
/* ------------------------------------------------------------------ */

function marketOf(cs: ChainState, market: Hex): ChainMarket | undefined {
  return Object.values(cs.markets).find((m) => marketKey(m.symbol) === market.toLowerCase());
}

/** Orders sent recently, by id, with when. */
const sentAt = new Map<number, number>();

/**
 * Settles every pending order its feed has decided, exactly as the contract
 * proves it. An order whose round has landed — the first observed after its
 * request, in its window and its feed's phase — is executed there, however
 * late. One whose window passed without such a round is expired, with the
 * round that proves it. One whose feed moved to a new aggregator, or whose
 * market was delisted, is cancelled, and one its trader asked back is
 * released once the cancel delay has passed with no round. The keeper earns
 * the execution fee each time. Orders are read side by side from a cursor at
 * the oldest one that may still be pending, each market's latest round once.
 */
export async function runOrderExecutor(): Promise<{ executed: number; cancelled: number; skipped: number }> {
  const none = { executed: 0, cancelled: 0, skipped: 0 };
  const c = agriPerpContracts();
  const client = publicClient();
  const chain = chainConfig();
  const wallet = keeperWallet();
  if (perpsVenue() !== 'agri-perp' || !c || !client || !chain || !wallet) return none;
  const cs = await chainState({ maxAgeSec: 5 });
  if (!cs) return none;
  const cursorKey = cacheKey('perp', `orders:${chain.id}:${c.perp.toLowerCase()}`);
  const cache = getCache();
  let cursor = Number((await cache.get<{ next: number }>(cursorKey))?.next ?? 1);
  const counts = { ...none };

  const ids = Array.from({ length: Math.max(0, cs.params.nextOrderId - cursor) }, (_, i) => cursor + i);
  const orders = await mapLimit(ids, PARALLEL_READS, (id) =>
    client.readContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'getOrder', args: [BigInt(id)] }),
  );
  type Order = (typeof orders)[number];
  const pending: Array<{ id: number; order: Order }> = [];
  let advancing = true;
  orders.forEach((order, i) => {
    const id = ids[i] as number;
    if (order.status !== 1) {
      if (advancing) cursor = id + 1;
      return;
    }
    advancing = false;
    pending.push({ id, order });
  });

  // Each market's latest round, read once.
  const latest = new Map<string, FeedRound>();
  const markets = new Map(pending.flatMap(({ order }) => {
    const m = marketOf(cs, order.market);
    return m && !m.delisted ? [[m.symbol, m] as const] : [];
  }));
  await Promise.all(
    [...markets.values()].map(async (m) => {
      const r = await latestRound(client, m.feed).catch(() => null);
      if (r) latest.set(m.symbol, r);
    }),
  );

  const now = await chainNow();
  // Mock mode: this keeper is also the local chain's oracle. A market with an
  // order due its round gets one now, the way a busy live feed would.
  if (perpsOracleMode() === 'mock' && pending.length) {
    const due = new Set<string>();
    for (const { order } of pending) {
      const m = marketOf(cs, order.market);
      const r = m ? latest.get(m.symbol) : undefined;
      const from = Number(order.requestedAt) + Math.max(order.terms.minDelay, OBSERVATION_MARGIN_SEC);
      if (m && r && now >= from && r.updatedAt < from) due.add(m.symbol);
    }
    for (const symbol of due) {
      const m = markets.get(symbol) as ChainMarket;
      await postMockRound(m, { force: true });
      const r = await latestRound(client, m.feed).catch(() => null);
      if (r) latest.set(symbol, r);
    }
  }

  type Job = { id: number; kind: 'execute' | 'expire' | 'cancel'; send: () => Promise<Hex> };
  const cancel = (id: number): Job => ({
    id,
    kind: 'cancel',
    send: () => wallet.writeContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'cancelOrder', args: [BigInt(id)] }),
  });
  const jobs = await mapLimit(pending, PARALLEL_READS, async ({ id, order }): Promise<Job | null> => {
    if ((sentAt.get(id) ?? 0) > Date.now() - SENT_TTL_MS) return null;
    const market = marketOf(cs, order.market);
    if (!market) return null;
    if (market.delisted) return cancel(id);
    const requestedAt = Number(order.requestedAt);
    const round = await orderRound(
      client,
      market.feed,
      {
        phase: order.phase,
        observedFrom: requestedAt + OBSERVATION_MARGIN_SEC,
        notBefore: requestedAt + order.terms.minDelay,
        notAfter: requestedAt + order.terms.maxDelay,
      },
      now,
      latest.get(market.symbol),
    ).catch(() => null);
    switch (round?.kind) {
      case 'upgraded':
        return cancel(id);
      case 'fill':
        return {
          id,
          kind: 'execute',
          send: () => wallet.writeContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'executeOrder', args: [BigInt(id), round.roundId] }),
        };
      case 'expire':
        return {
          id,
          kind: 'expire',
          send: () => wallet.writeContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'expireOrder', args: [BigInt(id), round.roundId] }),
        };
      case 'wait': {
        // Its trader asked for it back and the delay is up: release it.
        const asked = Number(order.cancelRequestedAt);
        return asked > 0 && now >= asked + PERP_CANCEL_DELAY_SEC ? cancel(id) : null;
      }
      default:
        return null;
    }
  });

  const sent: Array<{ job: Job; hash: Hex }> = [];
  for (const job of jobs) {
    if (!job) continue;
    try {
      sent.push({ job, hash: await job.send() });
      sentAt.set(job.id, Date.now());
    } catch (err) {
      counts.skipped += 1;
      warnOnce(`${job.kind}:${job.id}`, `[perps] order ${job.id} couldn't be ${job.kind === 'execute' ? 'executed' : job.kind === 'expire' ? 'expired' : 'cancelled'}: ${revertName(err) ?? (err as Error).message.split('\n')[0]}`, 10 * 60_000);
    }
  }
  for (const [id, at] of sentAt) if (at < Date.now() - SENT_TTL_MS) sentAt.delete(id);
  await Promise.all(
    sent.map(async ({ job, hash }) => {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 }).catch(() => null);
      if (receipt?.status !== 'success') {
        counts.skipped += 1;
        return;
      }
      if (job.kind === 'execute') {
        counts.executed += 1;
        await applyPerpLogs(receipt.logs);
      } else counts.cancelled += 1;
    }),
  );
  await cache.set(cursorKey, { next: cursor }, 30 * 86_400);
  return counts;
}

/**
 * On chain: open positions (as mirrored) checked against the fresh marks and
 * the contract's funding state. Each position keeps the liquidation threshold
 * it was opened under, so the ones near any threshold are confirmed with the
 * contract's own `positionState`; the liquidatable ones on each market go to
 * `liquidate` in one transaction — which settles on the feed's latest round
 * and re-checks each, skipping any that aren't. Positions on a delisted
 * market settle at its last price instead. Needs the keeper key; without
 * it, reports what it would have done (anyone else may liquidate).
 */
export async function runChainKeeper(): Promise<{ candidates: number; liquidated: number; settled: number; txs: Hex[] }> {
  const c = agriPerpContracts();
  const chain = chainConfig();
  const client = publicClient();
  const none = { candidates: 0, liquidated: 0, settled: 0, txs: [] as Hex[] };
  if (perpsVenue() !== 'agri-perp' || !c || !chain || !client) return none;
  const [open, allMarks, cs] = await Promise.all([
    getPerpStore().listPositions({ venue: 'agri-perp', statuses: ['open'], limit: 5_000 }),
    perpMarks(),
    chainState(),
  ]);
  if (!cs) return none;
  const settled = await settleDelisted(open.filter((row) => cs.markets[row.symbol]?.delisted));
  const near = open.filter((row) => {
    const mark = allMarks.get(row.symbol);
    if (!mark?.fresh || !row.chainPositionId || cs.markets[row.symbol]?.delisted) return false;
    const pnl = perpPricePnl({
      side: row.side,
      size: row.size,
      collateral: row.collateral,
      entry: row.entryIndex,
      mark: mark.index,
      maxProfitMultiple: row.reserve / row.collateral,
    });
    return perpIsLiquidatable({ collateral: row.collateral, pnl, fundingOwed: fundingOwed(row, fundingIndexAt(mark.state)), threshold: LOOSEST_LIQUIDATION_THRESHOLD });
  });
  const confirmed = await mapLimit(near, PARALLEL_READS, async (row) => {
    const state = await client
      .readContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'positionState', args: [BigInt(row.chainPositionId as string)] })
      .catch(() => null);
    return state?.[3] ? row : null;
  });
  const bySymbol = new Map<string, PerpPositionRow[]>();
  for (const row of confirmed) if (row) bySymbol.set(row.symbol, [...(bySymbol.get(row.symbol) ?? []), row]);
  const candidates = [...bySymbol.values()].reduce((n, rows) => n + rows.length, 0);
  const wallet = keeperWallet();
  if (!candidates || !wallet) return { candidates, liquidated: 0, settled, txs: [] };

  let liquidated = 0;
  const txs: Hex[] = [];
  for (const [symbol, rows] of bySymbol) {
    try {
      const hash = await wallet.writeContract({
        address: c.perp,
        abi: AGRI_PERP_ABI,
        functionName: 'liquidate',
        args: [symbol, rows.map((r) => BigInt(r.chainPositionId as string))],
      });
      txs.push(hash);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      liquidated += (await applyPerpLogs(receipt.logs)).filter((p) => p.status === 'liquidated').length;
    } catch (err) {
      console.warn(`[perps] liquidating ${symbol} failed: ${revertName(err) ?? (err as Error).message.split('\n')[0]}`);
    }
  }
  return { candidates, liquidated, settled, txs };
}

/** Positions on delisted markets, settled at the market's last price (permissionless, no close fee). */
async function settleDelisted(rows: PerpPositionRow[]): Promise<number> {
  const c = agriPerpContracts();
  const wallet = keeperWallet();
  const client = publicClient();
  const ids = rows.flatMap((r) => (r.chainPositionId ? [BigInt(r.chainPositionId)] : []));
  if (!ids.length || !c || !wallet || !client) return 0;
  try {
    const hash = await wallet.writeContract({ address: c.perp, abi: AGRI_PERP_ABI, functionName: 'settleDelisted', args: [ids] });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return (await applyPerpLogs(receipt.logs)).filter((p) => p.status === 'closed').length;
  } catch (err) {
    console.warn(`[perps] settling delisted positions failed: ${(err as Error).message.split('\n')[0]}`);
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Mock mode: the local chain's oracle                                 */
/* ------------------------------------------------------------------ */

const mockDecimals = new Map<string, number>();

/**
 * Posts a market's cached price into its local MockAggregator as a new
 * round — when it has moved from the feed's last answer, when the feed is
 * older than MOCK_HEARTBEAT_SEC, or (`force`) because an order waits on it.
 */
async function postMockRound(market: ChainMarket, opts: { force?: boolean } = {}): Promise<boolean> {
  const client = publicClient();
  const wallet = keeperWallet();
  if (!client || !wallet || !market.listed || market.delisted) return false;
  const cached = feedPrice((await readFeedPrices())?.feeds, market.symbol);
  if (!cached) return false;
  let decimals = mockDecimals.get(market.feed);
  if (decimals == null) {
    decimals = Number(await client.readContract({ address: market.feed, abi: CHAINLINK_FEED_ABI, functionName: 'decimals' }));
    mockDecimals.set(market.feed, decimals);
  }
  const [, answer, , updatedAt] = await client.readContract({ address: market.feed, abi: CHAINLINK_FEED_ABI, functionName: 'latestRoundData' });
  const next = BigInt(Math.round(cached.price * 10 ** decimals));
  const stale = (await chainNow()) - Number(updatedAt) >= MOCK_HEARTBEAT_SEC;
  if (!opts.force && next === answer && !stale) return false;
  const hash = await wallet.writeContract({ address: market.feed, abi: MOCK_AGGREGATOR_ABI, functionName: 'updateAnswer', args: [next] });
  await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  return true;
}

/**
 * Mock mode (local chains only): stands in for Chainlink's nodes, posting
 * each market's cached price into its MockAggregator when it moves — so
 * liquidations, closes and the market list see the same price the page
 * shows. Orders get their round from the executor.
 */
export async function runMockOracle(): Promise<number> {
  if (perpsVenue() !== 'agri-perp' || perpsOracleMode() !== 'mock') return 0;
  const cs = await chainState({ maxAgeSec: 30 });
  if (!cs) return 0;
  let posted = 0;
  for (const market of Object.values(cs.markets)) {
    try {
      if (await postMockRound(market)) posted += 1;
    } catch (err) {
      warnOnce(`mock:${market.symbol}`, `[perps] mock round for ${market.symbol} failed: ${(err as Error).message.split('\n')[0]}`, 60_000);
    }
  }
  return posted;
}

/* ------------------------------------------------------------------ */
/* Paper venue                                                         */
/* ------------------------------------------------------------------ */

/**
 * Paper: every open position against its fresh mark; past the threshold,
 * it's closed at that price, the house keeps the reward (10% of what's left,
 * at least 0.5% of collateral, like the contract), and the trader gets the
 * rest. A market without a fresh price (closed) is left alone.
 */
export async function runPaperKeeper(): Promise<{ checked: number; liquidated: number }> {
  if (perpsVenue() !== 'paper') return { checked: 0, liquidated: 0 };
  const store = getPerpStore();
  const [open, allMarks] = await Promise.all([store.listPositions({ venue: 'paper', statuses: ['open'], limit: 5_000 }), perpMarks()]);
  let liquidated = 0;
  for (const row of open) {
    const mark = allMarks.get(row.symbol);
    if (!mark?.fresh) continue;
    const pnl = perpPricePnl({
      side: row.side,
      size: row.size,
      collateral: row.collateral,
      entry: row.entryIndex,
      mark: mark.index,
      maxProfitMultiple: row.reserve / row.collateral,
    });
    const funding = fundingOwed(row, fundingIndexAt(mark.state));
    if (!perpIsLiquidatable({ collateral: row.collateral, pnl, fundingOwed: funding })) continue;
    const remaining = perpPayout({ collateral: row.collateral, pnl, fundingOwed: funding });
    const reward = round6(Math.max(remaining * 0.1, row.collateral * PERP_MIN_LIQUIDATION_REWARD));
    const payout = round6(Math.max(0, remaining - reward));
    const settled = await store.paperSettle({
      positionId: row.id,
      patch: {
        status: 'liquidated',
        exitPrice: mark.price,
        exitIndex: mark.index,
        realizedPnl: round6(payout - row.collateral),
        fundingPaid: round6(funding),
        payout,
        liquidationReward: reward,
        closedAt: new Date().toISOString(),
      },
      payout,
    });
    if (settled) liquidated += 1;
  }
  return { checked: open.length, liquidated };
}

/**
 * Paper venue upkeep, every worker cycle: a funding rate changed in the
 * configuration applies from now on — the index accrues at the old rate up
 * to this moment first (never retroactive), and the change is recorded in
 * the funding history. Returns the markets whose rate changed.
 */
export async function maintainPaperMarkets(): Promise<string[]> {
  if (perpsVenue() !== 'paper') return [];
  const store = getPerpStore();
  const rows = await paperMarketRows();
  const now = Date.now();
  const changed: string[] = [];
  for (const def of tradablePerpMarkets()) {
    const row = rows.get(def.symbol);
    if (!row) continue;
    const rate = fundingRatePerHour(def.symbol);
    if (rate === row.fundingRate) continue;
    const { updatedAt: _updatedAt, ...state } = row;
    await store.upsertMarketState({
      ...state,
      fundingIndex: fundingIndexAt({ fundingIndex: row.fundingIndex, fundingRate: row.fundingRate, fundingUpdatedAt: Date.parse(row.fundingUpdatedAt) }, now),
      fundingRate: rate,
      fundingUpdatedAt: new Date(now).toISOString(),
    });
    await store.recordFunding(def.symbol, rate);
    changed.push(def.symbol);
  }
  return changed;
}
