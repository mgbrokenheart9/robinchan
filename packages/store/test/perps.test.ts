/**
 * The perps tables and PgPerpStore on PGlite (real Postgres in WASM): the
 * schema applied on top of an existing database, the paper venue's atomic
 * money moves, the on-chain mirror's idempotent upsert, and the queries the
 * Perps page and the keeper run.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';

import { PgDb } from '../src/db';
import { PgPerpStore, type PerpPositionInsert } from '../src/perps';
import { SCHEMA_SQL } from '../src/schema';

function poolFrom(pg: PGlite): Pool {
  const run = async (sql: string, params?: unknown[]) => {
    if (!params || params.length === 0) {
      const results = await pg.exec(sql);
      const last = results.at(-1);
      return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 };
    }
    const r = await pg.query(sql, params as never[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  return {
    query: run,
    connect: async () => ({ query: run, release() {} }),
    end: async () => {},
    on() {},
  } as unknown as Pool;
}

const pg = new PGlite();
const pool = poolFrom(pg);
const db = new PgDb(pool);
const store = new PgPerpStore(pool);
await db.migrate();
// Applying it again must be a no-op, whoever gets there second.
await pg.exec(SCHEMA_SQL);

const alice = await db.upsertUser('0x00000000000000000000000000000000000000a1');
const bob = await db.upsertUser('0x00000000000000000000000000000000000000b2');

function position(userId: string | null, patch: Partial<PerpPositionInsert> = {}): PerpPositionInsert {
  return {
    userId,
    address: '0x00000000000000000000000000000000000000a1',
    venue: 'paper',
    chainId: null,
    chainPositionId: null,
    symbol: 'COFF',
    category: 'agri',
    side: 'long',
    collateral: 100,
    size: 1000,
    leverage: 10,
    entryPrice: 3.85,
    entryIndex: 3.85,
    entryFunding: 0,
    reserve: 900,
    fee: 1,
    status: 'open',
    exitPrice: null,
    exitIndex: null,
    realizedPnl: null,
    fundingPaid: null,
    payout: null,
    liquidationReward: null,
    txOpen: null,
    txClose: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    ...patch,
  };
}

async function quotedAction(userId: string, kind: 'open' | 'close' = 'open') {
  return store.insertAction({
    id: randomUUID(),
    userId,
    address: '0x00000000000000000000000000000000000000a1',
    kind,
    venue: 'paper',
    symbol: 'COFF',
    positionId: null,
    amount: 100,
    status: 'quoted',
    quote: { any: 'shape', nested: { kept: true } },
    chainOrderId: null,
    txHash: null,
    txHashes: [],
    signature: null,
    error: null,
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    checkedAt: null,
  });
}

describe('perps store (Postgres)', () => {
  test('market state round-trips, and funding history records', async () => {
    const at = new Date().toISOString();
    await store.upsertMarketState({ symbol: 'COFF', feedId: '0xabc', rollFactor: 1, fundingRate: 0.0000125, fundingIndex: 0, fundingUpdatedAt: at, rolledAt: null });
    await store.upsertMarketState({ symbol: 'COFF', feedId: '0xdef', rollFactor: 1.0285714, fundingRate: 0.00002, fundingIndex: 0.0004, fundingUpdatedAt: at, rolledAt: at });
    const [m] = await store.listMarketStates();
    assert.equal(m?.feedId, '0xdef');
    assert.equal(m?.rollFactor, 1.0285714);
    assert.equal(m?.fundingIndex, 0.0004);
    await store.recordFunding('COFF', 0.00002);
  });

  test('the faucet adds test USDC up to its cap', async () => {
    assert.equal(await store.paperFaucet(alice.id, 10_000, 25_000), 10_000);
    assert.equal(await store.paperFaucet(alice.id, 10_000, 25_000), 20_000);
    assert.equal(await store.paperFaucet(alice.id, 10_000, 25_000), null, 'past the cap');
    assert.deepEqual(await store.getPaperAccount(alice.id), { free: 20_000, faucetTotal: 20_000 });
  });

  test('opening debits collateral + fee, inserts the position and completes the action — in one step', async () => {
    const action = await quotedAction(alice.id);
    const opened = await store.paperOpen({ actionId: action.id, signature: '0xsig', debit: 101, position: position(alice.id) });
    assert.ok(typeof opened === 'object');
    assert.equal((await store.getPaperAccount(alice.id)).free, 20_000 - 101);
    const done = await store.getAction(action.id);
    assert.equal(done?.status, 'done');
    assert.equal(done?.positionId, opened.id);
    assert.deepEqual(done?.quote, { any: 'shape', nested: { kept: true } });

    // The same signed action can't open twice.
    assert.equal(await store.paperOpen({ actionId: action.id, signature: '0xsig', debit: 101, position: position(alice.id) }), 'conflict');
    assert.equal((await store.getPaperAccount(alice.id)).free, 20_000 - 101, 'nothing debited by the refused retry');
  });

  test('a short balance refuses the open and leaves everything as it was', async () => {
    const action = await quotedAction(bob.id);
    assert.equal(await store.paperOpen({ actionId: action.id, signature: '0x', debit: 5, position: position(bob.id) }), 'insufficient');
    assert.equal((await store.getAction(action.id))?.status, 'quoted');
    assert.equal((await store.listPositions({ userId: bob.id, limit: 10 })).length, 0);
  });

  test('settling pays out once; a second settle (close racing liquidation) gets nothing', async () => {
    const [open] = await store.listPositions({ userId: alice.id, statuses: ['open'], limit: 1 });
    assert.ok(open);
    const action = await quotedAction(alice.id, 'close');
    const closed = await store.paperSettle({
      positionId: open.id,
      patch: { status: 'closed', exitPrice: 4.04, exitIndex: 4.04, realizedPnl: 49.35, fundingPaid: 0.02, payout: 149.33, closedAt: new Date().toISOString() },
      payout: 149.33,
      action: { id: action.id, signature: '0xclose' },
    });
    assert.equal(closed?.status, 'closed');
    assert.equal((await store.getPaperAccount(alice.id)).free, 20_000 - 101 + 149.33);
    assert.equal((await store.getAction(action.id))?.status, 'done');

    const again = await store.paperSettle({ positionId: open.id, patch: { status: 'liquidated' }, payout: 10 });
    assert.equal(again, null);
    assert.equal((await store.getPaperAccount(alice.id)).free, 20_000 - 101 + 149.33, 'no double payout');
  });

  test('on-chain positions upsert idempotently and pick up the user once known', async () => {
    const chain = { venue: 'agri-perp' as const, chainId: 31337, chainPositionId: '7', address: '0x00000000000000000000000000000000000000b2' };
    const first = await store.upsertChainPosition({ ...position(null, chain), chainId: 31337, chainPositionId: '7' });
    const second = await store.upsertChainPosition({ ...position(bob.id, { ...chain, txOpen: '0xtx' }), chainId: 31337, chainPositionId: '7' });
    assert.equal(first.id, second.id);
    assert.equal(second.userId, bob.id);
    assert.equal(second.txOpen, '0xtx');
    assert.equal((await store.getChainPosition(31337, '7'))?.id, first.id);
    assert.equal(await store.updatePosition(first.id, { status: 'closed' }, ['liquidated']), null, 'guarded update');
    assert.equal((await store.updatePosition(first.id, { status: 'liquidated', liquidationReward: 1.5 }, ['open']))?.liquidationReward, 1.5);
  });

  test('open interest, volume and history queries', async () => {
    await store.insertPosition(position(alice.id, { side: 'short', size: 500, symbol: 'ETH', category: 'crypto' }));
    await store.insertPosition(position(alice.id, { side: 'short', size: 250, symbol: 'ETH', category: 'crypto' }));
    const oi = await store.openInterest('paper');
    assert.deepEqual(oi.find((x) => x.symbol === 'ETH' && x.side === 'short')?.size, 750);
    const volume = await store.volumeSince('paper', new Date(Date.now() - 86_400_000));
    assert.equal(volume.find((x) => x.symbol === 'ETH')?.size, 750);
    const history = await store.listPositions({ userId: alice.id, statuses: ['closed', 'liquidated'], orderBy: 'closed', limit: 10 });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.payout, 149.33);
    assert.equal((await store.listPositions({ address: '0x00000000000000000000000000000000000000A1', limit: 50 })).length, 3, 'address match is case-insensitive');
  });

  test('actions list by user, status and kind', async () => {
    const live = await store.listActions({ userId: bob.id, statuses: ['quoted'], limit: 10 });
    assert.equal(live.length, 1);
    const updated = await store.updateAction(live[0]!.id, { status: 'pending', txHash: '0xhash', txHashes: ['0xhash'], chainOrderId: '42' }, ['quoted']);
    assert.deepEqual(updated?.txHashes, ['0xhash']);
    assert.equal(updated?.chainOrderId, '42');
    assert.equal(updated?.cancelRequestedAt, null, 'not asked back');
    // The trader asks the order back: the worker notes when, as the chain recorded it.
    const asked = await store.updateAction(live[0]!.id, { cancelRequestedAt: '2026-09-26T10:00:00.000Z', checkedAt: new Date().toISOString() }, ['pending']);
    assert.equal(asked?.cancelRequestedAt, '2026-09-26T10:00:00.000Z');
    assert.equal((await store.listActions({ userId: bob.id, statuses: ['pending'], limit: 10 }))[0]?.cancelRequestedAt, '2026-09-26T10:00:00.000Z');
    assert.equal((await store.listActions({ kinds: ['close'], limit: 10 })).length, 1);
  });

  test('Multichain brief: rows by chain — Base’s are Base’s, the primary keeps its rows from before chain ids', async () => {
    const carol = await db.upsertUser('0x00000000000000000000000000000000000000c3');
    const addr = '0x00000000000000000000000000000000000000c3';
    await store.insertPosition(position(carol.id, { address: addr, symbol: 'BTC', category: 'crypto' }));
    await store.upsertChainPosition({ ...position(carol.id, { address: addr, venue: 'agri-perp', symbol: 'ETH', category: 'crypto' }), chainId: 4663, chainPositionId: '1' });
    // Base's gold: the 'commodities' category, which the category check now takes.
    await store.upsertChainPosition({ ...position(carol.id, { address: addr, venue: 'agri-perp', symbol: 'XAU', category: 'commodities', size: 300 }), chainId: 8453, chainPositionId: '1' });

    const symbols = async (chain: { chainId: number; legacy: boolean }) =>
      (await store.listPositions({ chain, address: addr, limit: 10 })).map((p) => p.symbol).sort();
    assert.deepEqual(await symbols({ chainId: 4663, legacy: true }), ['BTC', 'ETH']);
    assert.deepEqual(await symbols({ chainId: 8453, legacy: false }), ['XAU']);
    assert.equal((await store.getChainPosition(8453, '1'))?.symbol, 'XAU', 'one position id on two chains, two positions');
    assert.equal((await store.getChainPosition(4663, '1'))?.symbol, 'ETH');

    const base = { chainId: 8453, legacy: false };
    assert.deepEqual(await store.openInterest('agri-perp', base), [{ symbol: 'XAU', side: 'long', size: 300 }]);
    assert.deepEqual(await store.volumeSince('agri-perp', new Date(Date.now() - 60_000), base), [{ symbol: 'XAU', size: 300 }]);

    const legacy = await quotedAction(carol.id);
    const { createdAt: _c, updatedAt: _u, ...fields } = legacy;
    const onBase = await store.insertAction({ ...fields, id: randomUUID(), venue: 'agri-perp', chainId: 8453 });
    assert.equal(onBase.chainId, 8453);
    assert.equal(legacy.chainId, null, 'an action from before chain ids');
    const ids = async (chain: { chainId: number; legacy: boolean }) => (await store.listActions({ chain, userId: carol.id, limit: 10 })).map((a) => a.id).sort();
    assert.deepEqual(await ids(base), [onBase.id]);
    assert.deepEqual(await ids({ chainId: 4663, legacy: true }), [legacy.id]);
  });

  test('the category check upgrades in place: an RH-era table takes commodities after migrate', async () => {
    const old = new PGlite();
    const oldPool = poolFrom(old);
    await old.exec(`create table perp_positions (id uuid primary key default gen_random_uuid(), category text not null);
      alter table perp_positions add constraint perp_positions_category_check check (category in ('agri', 'crypto', 'stocks', 'rh'));`);
    await assert.rejects(old.exec(`insert into perp_positions (category) values ('commodities')`));
    // Only the upgrade block of the schema: the rest would need the whole table.
    const block = SCHEMA_SQL.slice(SCHEMA_SQL.indexOf('do $$\nbegin\n  if exists (\n    select 1 from pg_constraint\n     where conname = \'perp_positions_category_check\''));
    await oldPool.query(block.slice(0, block.indexOf('end $$;') + 'end $$;'.length));
    await old.exec(`insert into perp_positions (category) values ('commodities')`);
    await assert.rejects(old.exec(`insert into perp_positions (category) values ('bonds')`));
  });
});
