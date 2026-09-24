import type {
  Address,
  CompanionNotice,
  OrderIntent,
  OrderQuote,
  OrderRecord,
  OrderSource,
  TierId,
} from '@robinchan/shared';
import {
  LIMIT_DEVIATION_MAX,
  LIMIT_ORDER_TTL_DAYS,
  QUOTE_TTL_SEC,
  formatPct,
  formatPriceSmart,
  symbolInfo,
  tierAtLeast,
} from '@robinchan/shared';
import { getDb, newId, type OrderRow } from '@robinchan/store';
import { verifyTypedData, type Hex } from 'viem';

import { explorerTx, publicClient } from '../chain';
import { maxOrderUsd, protocolFeeBps, slippageBps, tradingEnabled } from '../env';
import { invalidateHoldings, readHoldings } from '../holdings';
import { QUOTE_PRICE_MAX_AGE_SEC, getPrice } from '../prices';
import { OrderError } from './errors';
import { getVenue, withinSlippage } from './venues';

/**
 * The one order pipeline. The Trade page's form and Robinchan's chat both
 * produce an `OrderIntent` and hand it here — there is no second path to
 * audit or to drift (Trade §1). The same intent from either source yields
 * the same quote and the same transaction; only `source` differs.
 *
 * Invariants:
 * - Every value in a quote is computed here, from server-side prices and
 *   balances. Nothing from browser state reaches a transaction.
 * - A quote is bound to one address and lives 30 seconds.
 * - Nothing executes without a fresh signature from the user for that order.
 */

export type OrderUser = { id: string; address: Address; tier: TierId };

const QUOTE_GRACE_MS = 5_000;
/** An in-flight transaction this old with no trace on the network is given up on. */
const DROPPED_AFTER_MS = 30 * 60_000;

function assertTrading(): void {
  if (!tradingEnabled()) {
    throw new OrderError('FEATURE_DISABLED', 'Trading is not live yet.', 403);
  }
}

/** Structural checks on an intent, wherever it came from. Throws on the first problem. */
export function normalizeIntent(raw: OrderIntent): OrderIntent {
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  const info = symbolInfo(symbol);
  if (!info) throw new OrderError('NOT_FOUND', `${symbol || 'That symbol'} isn't a symbol Robinchan knows.`, 404, 'symbol');
  if (!info.tradable) {
    throw new OrderError('NOT_TRADABLE', info.untradableReason ?? `${symbol} can't be traded here.`, 400, 'symbol');
  }
  if (raw.side !== 'buy' && raw.side !== 'sell') throw new OrderError('BAD_REQUEST', 'Choose buy or sell.', 400, 'side');
  const qty = Number(raw.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new OrderError('BAD_REQUEST', 'Enter an amount above zero.', 400, 'qty');
  if (qty > 1_000_000) throw new OrderError('BAD_REQUEST', 'That amount is far above any sensible order.', 400, 'qty');
  const orderType = raw.orderType === 'limit' ? 'limit' : 'market';
  let limitPrice: number | null = null;
  if (orderType === 'limit') {
    limitPrice = Number(raw.limitPrice);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      throw new OrderError('BAD_REQUEST', 'Enter a limit price above zero.', 400, 'limitPrice');
    }
  }
  return { side: raw.side, symbol, qty: Number(qty.toFixed(8)), orderType, limitPrice };
}

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

export async function quoteOrder(params: {
  user: OrderUser;
  intent: OrderIntent;
  source: OrderSource;
}): Promise<OrderQuote> {
  assertTrading();
  const venue = getVenue();
  if (!venue) throw new OrderError('NOT_CONFIGURED', 'No execution venue is configured.', 503);

  const intent = normalizeIntent(params.intent);
  const { user } = params;

  if (intent.orderType === 'limit') {
    if (!venue.supportsLimit) {
      throw new OrderError('NOT_CONFIGURED', "Limit orders aren't available on this venue yet.", 400, 'limitPrice');
    }
    // Main brief §14: limit orders open at Tier 3.
    if (!tierAtLeast(user.tier, 'tier3')) {
      throw new OrderError('TIER_REQUIRED', 'Limit orders open at Tier 3.', 403, 'limitPrice');
    }
  }

  // Two orders back to back collide on the nonce and one fails without
  // explanation (Trade §4) — so while one is on its way, no new quote.
  const inFlight = await getDb().listOrders({ userId: user.id, statuses: ['pending'], limit: 1 });
  if (inFlight.length) {
    throw new OrderError(
      'ORDER_IN_FLIGHT',
      'Your previous order is still waiting on the network. Let it finish, or speed it up or cancel it first.',
      409,
    );
  }

  const live = await getPrice(intent.symbol);
  if (!live || live.ageSec > QUOTE_PRICE_MAX_AGE_SEC) {
    throw new OrderError('UPSTREAM_DOWN', `The ${intent.symbol} price feed is stale right now, so it can't be quoted.`, 503);
  }

  const refPrice = intent.orderType === 'limit' ? (intent.limitPrice as number) : live.price;
  if (intent.qty * refPrice > maxOrderUsd()) {
    throw new OrderError('BAD_REQUEST', `One order can be at most $${maxOrderUsd().toLocaleString('en-US')}.`, 400, 'qty');
  }

  let ack: OrderQuote['ack'] = null;
  if (intent.orderType === 'limit') {
    const deviation = ((intent.limitPrice as number) - live.price) / live.price;
    if (Math.abs(deviation) > LIMIT_DEVIATION_MAX) {
      ack = {
        code: 'LIMIT_DEVIATION',
        message: `Your limit is ${formatPct(Math.abs(deviation) * 100).slice(1)} ${deviation < 0 ? 'below' : 'above'} the market price of ${formatPriceSmart(live.price)}.`,
      };
    }
  }

  const feeBps = protocolFeeBps();
  const slip = intent.orderType === 'limit' ? 0 : slippageBps();
  const id = newId();
  const quotedAt = new Date();
  const expiresAt = new Date(quotedAt.getTime() + QUOTE_TTL_SEC * 1000).toISOString();

  const venueQuote = await venue.quote({
    orderId: id,
    intent,
    address: user.address,
    marketPrice: live.price,
    slippageBps: slip,
    expiresAt,
  });

  const notional = intent.qty * venueQuote.estPrice;
  const fee = (notional * feeBps) / 10_000;
  const estTotal = intent.side === 'buy' ? notional + fee : notional - fee;

  // Balances are read here, on the server — the form's own check is only
  // for showing the message early.
  const holdings = await readHoldings(user.address, user.id);
  if (intent.side === 'buy') {
    const cash = holdings.cash?.qty ?? 0;
    const need = intent.orderType === 'limit' ? intent.qty * (intent.limitPrice as number) + fee : estTotal * (1 + slip / 10_000);
    if (cash + 1e-9 < need) {
      throw new OrderError(
        'INSUFFICIENT_BALANCE',
        `Not enough ${holdings.cash?.symbol ?? 'USDC'}: this needs about $${formatPriceSmart(need)} and you have $${formatPriceSmart(cash)}.`,
        400,
        'qty',
      );
    }
  } else {
    const held = holdings.holdings.find((h) => h.symbol === intent.symbol && h.supported)?.qty ?? 0;
    if (held + 1e-9 < intent.qty) {
      throw new OrderError('INSUFFICIENT_BALANCE', `You hold ${held} ${intent.symbol}.`, 400, 'qty');
    }
  }
  if (venueQuote.gasNative > 0 && holdings.native.qty < venueQuote.gasNative) {
    throw new OrderError(
      'INSUFFICIENT_GAS',
      `You need about ${venueQuote.gasNative.toPrecision(2)} ${holdings.native.symbol} for the network fee, and you have ${holdings.native.qty.toPrecision(2)}.`,
      400,
      'gas',
    );
  }

  const warnings: string[] = [];
  if (live.ageSec > 30) warnings.push(`The ${intent.symbol} price is ${live.ageSec}s old.`);

  const quote: OrderQuote = {
    id,
    intent,
    address: user.address,
    venue: venue.id,
    estPrice: venueQuote.estPrice,
    estTotal,
    estGas: venueQuote.gasNative,
    gasSymbol: holdings.native.symbol,
    protocolFee: fee,
    feeBps,
    slippageBps: slip,
    quotedAt: quotedAt.toISOString(),
    expiresAt,
    warnings,
    ack,
    execution: venueQuote.execution,
  };

  await getDb().insertOrder({
    id,
    userId: user.id,
    address: user.address.toLowerCase(),
    side: intent.side,
    symbol: intent.symbol,
    qty: intent.qty,
    orderType: intent.orderType,
    limitPrice: intent.limitPrice,
    status: 'quoted',
    source: params.source,
    venue: venue.id,
    quotePrice: venueQuote.estPrice,
    fillPrice: null,
    estTotal,
    fee,
    slippageBps: slip,
    quote,
    txHash: null,
    txHashes: [],
    signature: null,
    error: null,
    expiresAt,
    submittedAt: null,
    filledAt: null,
    notifiedAt: null,
    checkedAt: null,
    nonce: null,
  });
  return quote;
}

/* ------------------------------------------------------------------ */
/* Record                                                              */
/* ------------------------------------------------------------------ */

async function ownOrder(user: OrderUser, orderId: string): Promise<OrderRow> {
  const order = await getDb().getOrder(orderId);
  if (!order || order.userId !== user.id) throw new OrderError('NOT_FOUND', 'Order not found.', 404);
  // Quotes are bound to the address they were issued for: a wallet switch
  // mid-flow invalidates it (Trade §4).
  if (order.address !== user.address.toLowerCase()) {
    throw new OrderError('ADDRESS_MISMATCH', 'This quote belongs to a different wallet address.', 409);
  }
  return order;
}

/**
 * After the user signs. A signature (typed data) settles right here; a
 * transaction hash moves the order to `pending`, and from then on the
 * server watches it — the tab can close (Trade §4).
 */
export async function recordOrder(params: {
  user: OrderUser;
  orderId: string;
  signature?: Hex;
  txHash?: Hex;
  /** Index into `execution.txs` for multi-step quotes (approve, then swap). */
  step?: number;
}): Promise<OrderRecord> {
  assertTrading();
  const db = getDb();
  const order = await ownOrder(params.user, params.orderId);
  const quote = order.quote;
  if (!quote) throw new OrderError('BAD_REQUEST', 'This order has no quote to sign.', 400);

  if (quote.execution.kind === 'signature') {
    if (!params.signature) throw new OrderError('BAD_REQUEST', 'A signature is required.', 400);
    if (order.status !== 'quoted') throw new OrderError('CONFLICT', `This order is already ${order.status}.`, 409);
    if (Date.now() > Date.parse(quote.expiresAt) + QUOTE_GRACE_MS) {
      await db.updateOrder(order.id, { status: 'expired' }, ['quoted']);
      throw new OrderError('QUOTE_EXPIRED', 'The quote expired before it was signed. Refresh the price.', 410);
    }
    const valid = await checkSignature(params.user.address, quote, params.signature);
    if (!valid) throw new OrderError('BAD_REQUEST', "The signature doesn't match this order.", 400);

    if (order.orderType === 'limit') {
      const expires = new Date(Date.now() + LIMIT_ORDER_TTL_DAYS * 86_400_000).toISOString();
      const opened = await db.updateOrder(
        order.id,
        { status: 'open', signature: params.signature, submittedAt: new Date().toISOString(), expiresAt: expires, notifiedAt: new Date().toISOString() },
        ['quoted'],
      );
      if (!opened) throw new OrderError('CONFLICT', 'This order changed while signing.', 409);
      return toRecord(opened);
    }

    const signed = await db.updateOrder(order.id, { signature: params.signature, submittedAt: new Date().toISOString() }, ['quoted']);
    if (!signed) throw new OrderError('CONFLICT', 'This order changed while signing.', 409);
    // The user is watching this happen, so there's nothing to tell them later.
    return toRecord(await fillNow(signed, { notify: false }));
  }

  // Transaction path.
  const hash = params.txHash;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new OrderError('BAD_REQUEST', 'A transaction hash is required.', 400);
  const txs = quote.execution.txs;
  const step = params.step ?? txs.length - 1;
  if (!Number.isInteger(step) || step < 0 || step >= txs.length) throw new OrderError('BAD_REQUEST', 'Unknown step.', 400);

  // The hash is recorded even if the quote lapsed while the wallet was
  // open: the transaction is already on its way, and losing track of it is
  // worse. The contract-level slippage bound is what protects the price.
  const hashes = order.txHashes.includes(hash) ? order.txHashes : [...order.txHashes, hash];
  if (step < txs.length - 1) {
    const updated = await db.updateOrder(order.id, { txHashes: hashes }, ['quoted', 'expired']);
    if (!updated) throw new OrderError('CONFLICT', `This order is already ${order.status}.`, 409);
    return toRecord(updated);
  }
  const pending = await db.updateOrder(
    order.id,
    { status: 'pending', txHash: hash, txHashes: hashes, submittedAt: order.submittedAt ?? new Date().toISOString() },
    ['quoted', 'expired', 'pending'],
  );
  if (!pending) throw new OrderError('CONFLICT', `This order is already ${order.status}.`, 409);
  return toRecord(pending);
}

async function checkSignature(address: Address, quote: OrderQuote, signature: Hex): Promise<boolean> {
  if (quote.execution.kind !== 'signature') return false;
  const { domain, types, primaryType, message } = quote.execution.typedData;
  const fields = { address, domain, types, primaryType, message, signature };
  try {
    if (await verifyTypedData(fields as Parameters<typeof verifyTypedData>[0])) return true;
  } catch {
    /* fall through to the contract-wallet check */
  }
  // Smart-contract wallets sign through ERC-1271, which needs the chain.
  const client = publicClient();
  if (!client) return false;
  try {
    return await client.verifyTypedData(fields as unknown as Parameters<typeof client.verifyTypedData>[0]);
  } catch {
    return false;
  }
}

/** Paper fills: at the current price, inside the quote's slippage bound, with the balance re-checked. */
async function fillNow(order: OrderRow, opts: { notify: boolean; atPrice?: number }): Promise<OrderRow> {
  const db = getDb();
  const live = await getPrice(order.symbol);
  const fail = async (error: string) =>
    (await db.updateOrder(order.id, { status: 'failed', error, notifiedAt: opts.notify ? null : new Date().toISOString() }, ['quoted', 'open', 'pending'])) ?? order;

  if (!live || live.ageSec > QUOTE_PRICE_MAX_AGE_SEC) return fail('No fresh price was available to fill against, so nothing was filled.');
  const price = opts.atPrice ?? live.price;
  if (order.orderType === 'market' && !withinSlippage(order.side, order.quotePrice ?? price, price, order.slippageBps ?? 0)) {
    return fail(`The price moved beyond your ${((order.slippageBps ?? 0) / 100).toFixed(2)}% slippage limit, so nothing was filled.`);
  }

  const holdings = await readHoldings(order.address as Address, order.userId);
  const fee = (order.qty * price * protocolFeeBps()) / 10_000;
  if (order.side === 'buy' && (holdings.cash?.qty ?? 0) + 1e-9 < order.qty * price + fee) {
    return fail(`Not enough ${holdings.cash?.symbol ?? 'USDC'} left in the wallet when the order came to fill.`);
  }
  if (order.side === 'sell') {
    const held = holdings.holdings.find((h) => h.symbol === order.symbol && h.supported)?.qty ?? 0;
    if (held + 1e-9 < order.qty) return fail(`The wallet no longer holds ${order.qty} ${order.symbol}.`);
  }

  const filled = await db.updateOrder(
    order.id,
    {
      status: 'filled',
      fillPrice: price,
      filledAt: new Date().toISOString(),
      notifiedAt: opts.notify ? null : new Date().toISOString(),
    },
    ['quoted', 'open', 'pending'],
  );
  await invalidateHoldings(order.address);
  return filled ?? order;
}

/* ------------------------------------------------------------------ */
/* Cancel                                                              */
/* ------------------------------------------------------------------ */

export async function cancelOrder(user: OrderUser, orderId: string): Promise<OrderRecord> {
  const order = await ownOrder(user, orderId);
  if (order.status !== 'open') {
    throw new OrderError('CONFLICT', order.status === 'filled' ? 'This order already filled.' : `Only open limit orders can be cancelled (this one is ${order.status}).`, 409);
  }
  const cancelled = await getDb().updateOrder(order.id, { status: 'cancelled', notifiedAt: new Date().toISOString() }, ['open']);
  // Lost the race to the limit watcher: report what actually happened.
  if (!cancelled) {
    const now = await getDb().getOrder(order.id);
    throw new OrderError('CONFLICT', now?.status === 'filled' ? 'This order filled a moment before the cancel.' : 'This order changed before it could be cancelled.', 409);
  }
  return toRecord(cancelled);
}

/* ------------------------------------------------------------------ */
/* Monitoring — the worker every 30s, and on read while pending        */
/* ------------------------------------------------------------------ */

type ReceiptCheck = 'unchanged' | 'filled' | 'failed' | 'cancelled';

/**
 * One pending order against the chain: which of its hashes (original, or a
 * speed-up / cancel replacement) was mined, and what that means.
 */
export async function checkPendingOrder(order: OrderRow): Promise<ReceiptCheck> {
  const db = getDb();
  const client = publicClient();
  const venue = getVenue();
  if (!client || !venue || order.status !== 'pending' || order.quote?.execution.kind !== 'transactions') return 'unchanged';
  const final = order.quote.execution.txs.at(-1);
  if (!final) return 'unchanged';

  for (const hash of [...order.txHashes].reverse()) {
    const receipt = await client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
    if (!receipt) continue;
    const tx = await client.getTransaction({ hash: hash as Hex }).catch(() => null);
    if (!tx || tx.from.toLowerCase() !== order.address) continue;

    const isCancel = tx.to?.toLowerCase() === order.address && tx.value === 0n && (tx.input === '0x' || tx.input === '0x0');
    const matchesQuote = tx.to?.toLowerCase() === final.to.toLowerCase() && tx.input.toLowerCase() === final.data.toLowerCase();

    if (receipt.status !== 'success') {
      await db.updateOrder(order.id, { status: 'failed', txHash: hash, error: 'The transaction reverted on chain. Nothing was filled; only the network fee was spent.' }, ['pending']);
      return 'failed';
    }
    if (isCancel && !matchesQuote) {
      await db.updateOrder(order.id, { status: 'cancelled', txHash: hash, error: 'Cancelled: a replacement transaction took its place.' }, ['pending']);
      return 'cancelled';
    }
    if (!matchesQuote) {
      await db.updateOrder(order.id, { status: 'failed', txHash: hash, error: "The mined transaction doesn't match the quoted order." }, ['pending']);
      return 'failed';
    }
    const settlement = await venue.settle(order, receipt);
    if (!settlement.ok) {
      await db.updateOrder(order.id, { status: 'failed', txHash: hash, error: settlement.error }, ['pending']);
      return 'failed';
    }
    await db.updateOrder(order.id, { status: 'filled', txHash: hash, fillPrice: settlement.fillPrice, filledAt: new Date().toISOString() }, ['pending']);
    await invalidateHoldings(order.address);
    return 'filled';
  }

  // Not mined yet. Remember the nonce while the network still knows the
  // transaction; once the account's nonce passes it with none of our hashes
  // mined, something else replaced it.
  const patch: Parameters<typeof db.updateOrder>[1] = { checkedAt: new Date().toISOString() };
  let nonce = order.nonce;
  if (nonce == null && order.txHash) {
    const tx = await client.getTransaction({ hash: order.txHash as Hex }).catch(() => null);
    if (tx) nonce = patch.nonce = tx.nonce;
  }
  if (nonce != null) {
    const confirmed = await client.getTransactionCount({ address: order.address as Address, blockTag: 'latest' }).catch(() => null);
    if (confirmed != null && confirmed > nonce) {
      await db.updateOrder(order.id, { status: 'failed', error: 'The transaction was replaced from the wallet outside Robinchan, so this order never went through.' }, ['pending']);
      return 'failed';
    }
  } else if (order.submittedAt && Date.now() - Date.parse(order.submittedAt) > DROPPED_AFTER_MS) {
    await db.updateOrder(order.id, { status: 'failed', error: 'The transaction never reached the network.' }, ['pending']);
    return 'failed';
  }
  await db.updateOrder(order.id, patch, ['pending']);
  return 'unchanged';
}

/** Quotes left unsigned past their window. */
export async function expireQuotes(): Promise<number> {
  const db = getDb();
  const quoted = await db.listOrders({ statuses: ['quoted'], limit: 500 });
  let n = 0;
  for (const o of quoted) {
    // Transaction quotes get a longer leash: an approval may still be confirming.
    const leash = o.quote?.execution.kind === 'transactions' ? 10 * 60_000 : 60_000;
    if (o.expiresAt && Date.now() > Date.parse(o.expiresAt) + leash) {
      if (await db.updateOrder(o.id, { status: 'expired', notifiedAt: new Date().toISOString() }, ['quoted'])) n += 1;
    }
  }
  return n;
}

/**
 * Limit orders (Trade §4: "Pantau limit order", 30s). The user signed the
 * order when placing it; when the price crosses, the backend executes that
 * signed order — never anything unsigned — and Robinchan tells the user
 * next time they're back.
 */
export async function runLimitWatcher(): Promise<{ filled: number; expired: number }> {
  const db = getDb();
  const open = await db.listOrders({ statuses: ['open'], limit: 500 });
  let filled = 0;
  let expired = 0;
  for (const o of open) {
    if (o.expiresAt && Date.now() > Date.parse(o.expiresAt)) {
      if (await db.updateOrder(o.id, { status: 'expired', error: 'The limit order reached its expiry unfilled.' }, ['open'])) expired += 1;
      continue;
    }
    const live = await getPrice(o.symbol);
    if (!live || live.ageSec > QUOTE_PRICE_MAX_AGE_SEC || o.limitPrice == null) continue;
    const crossed = o.side === 'buy' ? live.price <= o.limitPrice : live.price >= o.limitPrice;
    if (!crossed || o.venue !== 'paper') continue;
    const result = await fillNow(o, { notify: true, atPrice: live.price });
    if (result.status === 'filled') filled += 1;
  }
  return { filled, expired };
}

export async function runPendingMonitor(): Promise<Record<ReceiptCheck, number>> {
  const counts: Record<ReceiptCheck, number> = { unchanged: 0, filled: 0, failed: 0, cancelled: 0 };
  const pending = await getDb().listOrders({ statuses: ['pending'], limit: 200 });
  for (const o of pending) counts[await checkPendingOrder(o)] += 1;
  return counts;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function toRecord(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    side: row.side,
    symbol: row.symbol,
    qty: row.qty,
    orderType: row.orderType,
    limitPrice: row.limitPrice,
    status: row.status,
    source: row.source,
    venue: row.venue,
    quotePrice: row.quotePrice,
    fillPrice: row.fillPrice,
    estTotal: row.estTotal,
    fee: row.fee,
    txHashes: row.txHashes,
    txHash: row.txHash,
    explorerUrl: explorerTx(row.txHash),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    filledAt: row.filledAt,
    expiresAt: row.expiresAt,
  };
}

/** Order results the user hasn't been told about — Robinchan says them on return. */
export async function pendingNotices(userId: string): Promise<CompanionNotice[]> {
  const rows = await getDb().listOrders({ userId, unnotified: true, limit: 10 });
  return rows.map((o) => ({
    id: o.id,
    orderId: o.id,
    symbol: o.symbol,
    at: o.filledAt ?? o.updatedAt,
    text:
      o.status === 'filled'
        ? `Your ${o.orderType} ${o.side} of ${o.qty} ${o.symbol} filled at ${formatPriceSmart(o.fillPrice)}.`
        : `Your ${o.orderType} ${o.side} of ${o.qty} ${o.symbol} didn't go through: ${o.error ?? 'it failed.'}`,
  }));
}

export async function ackNotices(userId: string, ids: string[]): Promise<void> {
  const db = getDb();
  for (const id of ids.slice(0, 50)) {
    const o = await db.getOrder(id);
    if (o && o.userId === userId && o.notifiedAt == null) {
      await db.updateOrder(id, { notifiedAt: new Date().toISOString() });
    }
  }
}
