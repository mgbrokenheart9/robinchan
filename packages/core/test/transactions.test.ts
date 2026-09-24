import './setup';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';

import type { Address, OrderQuote, Ticker } from '@robinchan/shared';
import { cacheKey, getCache, getDb } from '@robinchan/store';
import type { PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Paper venue in its on-chain mode: a real (zero-value) transaction per order.
process.env.RC_PAPER_ONCHAIN = 'true';

const core = await import('../src/index');

/**
 * A scripted chain: transactions the "wallet" has broadcast, receipts for
 * the ones that got mined, and each account's confirmed nonce. The server
 * code under test only ever reads it — exactly its position with a real RPC.
 */
type FakeTx = { hash: `0x${string}`; from: Address; to: Address; input: `0x${string}`; value: bigint; nonce: number };
const chain = {
  txs: new Map<string, FakeTx>(),
  receipts: new Map<string, { status: 'success' | 'reverted'; logs: [] }>(),
  confirmed: new Map<string, number>(),
};
const notFound = () => Promise.reject(new Error('not found'));
core.setPublicClientForTests({
  getGasPrice: async () => 100_000_000n,
  estimateGas: async () => 25_000n,
  getTransaction: ({ hash }: { hash: string }) => (chain.txs.has(hash) ? Promise.resolve(chain.txs.get(hash)) : notFound()),
  getTransactionReceipt: ({ hash }: { hash: string }) =>
    chain.receipts.has(hash) ? Promise.resolve(chain.receipts.get(hash)) : notFound(),
  getTransactionCount: async ({ address }: { address: string }) => chain.confirmed.get(address.toLowerCase()) ?? 0,
} as unknown as PublicClient);

const hash = () => `0x${randomBytes(32).toString('hex')}` as `0x${string}`;

async function setPrice(symbol: string, price: number): Promise<void> {
  const t: Ticker = { symbol, name: symbol, price, change: 0, changePct: 0, currency: 'USD' };
  await getCache().set(cacheKey('price', symbol), t, 30);
}

async function newUser() {
  const account = privateKeyToAccount(generatePrivateKey());
  const row = await getDb().upsertUser(account.address);
  return { id: row.id, address: account.address, tier: 'free' as const };
}

/** What the browser does after the wallet sends: broadcast, then record the hash. */
async function send(
  user: Awaited<ReturnType<typeof newUser>>,
  quote: OrderQuote,
  nonce: number,
  override: Partial<FakeTx> = {},
): Promise<`0x${string}`> {
  assert.equal(quote.execution.kind, 'transactions');
  if (quote.execution.kind !== 'transactions') throw new Error('unreachable');
  const tx = quote.execution.txs.at(-1);
  assert.ok(tx);
  const h = hash();
  chain.txs.set(h, { hash: h, from: user.address, to: tx.to, input: tx.data, value: BigInt(tx.value), nonce, ...override });
  await core.recordOrder({ user, orderId: quote.id, txHash: h });
  return h;
}

const buy = (user: Awaited<ReturnType<typeof newUser>>, symbol = 'NVDA') =>
  core.quoteOrder({ user, intent: { side: 'buy', symbol, qty: 1, orderType: 'market', limitPrice: null }, source: 'form' });

await setPrice('NVDA', 176.2);
await setPrice('AAPL', 238.4);

describe('transactions, watched from the server (Trade §4 hard cases)', () => {
  test('the quote is a real transaction the wallet sends, with a gas estimate', async () => {
    const user = await newUser();
    const quote = await buy(user);
    assert.equal(quote.execution.kind, 'transactions');
    if (quote.execution.kind !== 'transactions') return;
    const [tx] = quote.execution.txs;
    assert.equal(tx?.to, user.address);
    assert.equal(tx?.value, '0');
    assert.ok(quote.estGas > 0);
  });

  test('signed, then the tab closed: the server finishes the job, and it is announced later', async () => {
    const user = await newUser();
    const quote = await buy(user);
    const h = await send(user, quote, 5);
    assert.equal((await getDb().getOrder(quote.id))?.status, 'pending');

    // Nobody's watching in a browser. The worker's monitor runs.
    assert.equal(await core.checkPendingOrder((await getDb().getOrder(quote.id))!), 'unchanged');
    assert.equal((await getDb().getOrder(quote.id))?.nonce, 5);
    chain.receipts.set(h, { status: 'success', logs: [] });
    await core.runPendingMonitor();
    const done = await getDb().getOrder(quote.id);
    assert.equal(done?.status, 'filled');
    assert.equal(done?.fillPrice, 176.2);
    assert.ok((await core.pendingNotices(user.id)).some((n) => n.orderId === quote.id));
  });

  test('two orders in quick succession: the second waits for the first', async () => {
    const user = await newUser();
    const first = await buy(user);
    const h = await send(user, first, 11);
    await assert.rejects(buy(user, 'AAPL'), (err: unknown) => err instanceof core.OrderError && err.code === 'ORDER_IN_FLIGHT');
    chain.receipts.set(h, { status: 'success', logs: [] });
    await core.runPendingMonitor();
    assert.ok(await buy(user, 'AAPL'));
  });

  test('stuck, then sped up: the replacement lands and settles the order', async () => {
    const user = await newUser();
    const quote = await buy(user);
    await send(user, quote, 6);
    const faster = await send(user, quote, 6); // same call, same nonce, higher fee
    chain.receipts.set(faster, { status: 'success', logs: [] });
    await core.runPendingMonitor();
    const row = await getDb().getOrder(quote.id);
    assert.equal(row?.status, 'filled');
    assert.equal(row?.txHash, faster);
    assert.equal(row?.txHashes.length, 2);
  });

  test('stuck, then cancelled: an empty transfer to self takes the nonce', async () => {
    const user = await newUser();
    const quote = await buy(user);
    await send(user, quote, 7);
    const cancel = await send(user, quote, 7, { to: user.address, input: '0x', value: 0n });
    chain.receipts.set(cancel, { status: 'success', logs: [] });
    await core.runPendingMonitor();
    assert.equal((await getDb().getOrder(quote.id))?.status, 'cancelled');
  });

  test('the price ran past the slippage limit before it was mined: nothing fills', async () => {
    const user = await newUser();
    const quote = await buy(user);
    const h = await send(user, quote, 8);
    await setPrice('NVDA', 176.2 * 1.02);
    chain.receipts.set(h, { status: 'success', logs: [] });
    await core.runPendingMonitor();
    const row = await getDb().getOrder(quote.id);
    assert.equal(row?.status, 'failed');
    assert.match(row?.error ?? '', /slippage/);
    await setPrice('NVDA', 176.2);
  });

  test('reverted on chain, replaced from the wallet, or not what was quoted: each fails with its reason', async () => {
    const user = await newUser();

    const reverted = await buy(user);
    const h1 = await send(user, reverted, 20);
    chain.receipts.set(h1, { status: 'reverted', logs: [] });
    await core.runPendingMonitor();
    assert.match((await getDb().getOrder(reverted.id))?.error ?? '', /reverted/);

    const replaced = await buy(user);
    await send(user, replaced, 21);
    await core.runPendingMonitor(); // sees nonce 21 while it's still in the mempool
    chain.confirmed.set(user.address.toLowerCase(), 22); // something else took nonce 21
    await core.runPendingMonitor();
    assert.match((await getDb().getOrder(replaced.id))?.error ?? '', /replaced from the wallet/);

    const other = await buy(user);
    const h3 = await send(user, other, 22, { input: '0xdeadbeef' });
    chain.receipts.set(h3, { status: 'success', logs: [] });
    await core.runPendingMonitor();
    assert.match((await getDb().getOrder(other.id))?.error ?? '', /doesn't match/);
  });
});
