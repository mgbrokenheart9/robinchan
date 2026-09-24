/**
 * The Postgres implementation, run against a real Postgres compiled to WASM
 * (PGlite) — no server needed. Covers the schema (applied twice, and as an
 * upgrade of the original `orders` table) and every Db / Cache method the
 * Trade, Heat and Portfolio pages use.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';

import { PgCache } from '../src/cache';
import { PgDb, type OrderInsert } from '../src/db';
import { SCHEMA_SQL } from '../src/schema';

/** Just enough of `pg.Pool` for the store: query, connect/release. */
function poolFrom(pg: PGlite): Pool {
  const run = async (sql: string, params?: unknown[]) => {
    if (!params || params.length === 0) {
      // Simple protocol: multi-statement DDL, DO blocks, begin/commit.
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

/** The first version of the schema, as an existing database would have it. */
const ORIGINAL = `
create table users (
  id            uuid primary key default gen_random_uuid(),
  wallet_address text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint wallet_lowercase check (wallet_address = lower(wallet_address))
);
create table orders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  side        text not null check (side in ('buy', 'sell')),
  symbol      text not null,
  qty         numeric not null check (qty > 0),
  limit_price numeric,
  status      text not null check (status in ('parsed', 'quoted', 'signed', 'failed', 'expired')),
  tx_hash     text,
  created_at  timestamptz not null default now()
);
`;

const pg = new PGlite();
await pg.exec(ORIGINAL);
const legacyUser = randomUUID();
await pg.query(`insert into users (id, wallet_address) values ($1, '0x00000000000000000000000000000000000000aa')`, [legacyUser]);
const legacyOrder = randomUUID();
await pg.query(`insert into orders (id, user_id, side, symbol, qty, status) values ($1, $2, 'buy', 'NVDA', 2, 'signed')`, [legacyOrder, legacyUser]);

const pool = poolFrom(pg);
const db = new PgDb(pool);
const cache = new PgCache(pool);

function order(userId: string, address: string, patch: Partial<OrderInsert> = {}): OrderInsert {
  return {
    id: randomUUID(), userId, address, side: 'buy', symbol: 'NVDA', qty: 1.5, orderType: 'market', limitPrice: null,
    status: 'quoted', source: 'form', venue: 'paper', quotePrice: 176.2, fillPrice: null, estTotal: 264.6, fee: 0.26,
    slippageBps: 50, quote: null, txHash: null, txHashes: [], signature: null, error: null,
    expiresAt: new Date(Date.now() + 30_000).toISOString(), submittedAt: null, filledAt: null, notifiedAt: null,
    checkedAt: null, nonce: null, ...patch,
  };
}

describe('Postgres store (PGlite)', () => {
  test('the schema upgrades an existing database, and applies again cleanly', async () => {
    await db.migrate();
    await pool.query(SCHEMA_SQL); // a second boot
    const legacy = await db.getOrder(legacyOrder);
    assert.equal(legacy?.status, 'signed');
    assert.equal(legacy?.orderType, 'market');
    assert.deepEqual(legacy?.txHashes, []);
    // The widened status check accepts the new states.
    await pool.query(`update orders set status = 'cancelled' where id = $1`, [legacyOrder]);
    await assert.rejects(pool.query(`update orders set status = 'bogus' where id = $1`, [legacyOrder]));
    for (const t of ['portfolio_snapshots', 'cost_basis_overrides', 'heat_reads', 'kv_cache', 'rate_limits']) {
      assert.ok((await pg.query(`select 1 from information_schema.tables where table_name = $1`, [t])).rows.length, t);
    }
  });

  test('users, watchlist, chat', async () => {
    const u = await db.upsertUser('0xABCDEF0000000000000000000000000000000001');
    assert.equal(u.address, '0xabcdef0000000000000000000000000000000001');
    assert.equal((await db.upsertUser('0xabcdef0000000000000000000000000000000001')).id, u.id);
    assert.ok((await db.listActiveUsers(new Date(Date.now() - 60_000))).some((x) => x.id === u.id));

    assert.deepEqual(await db.setWatchlist(u.id, ['nvda', 'AAPL', 'NVDA']), ['NVDA', 'AAPL']);
    assert.deepEqual(await db.setWatchlist(u.id, ['AAPL', 'TSLA']), ['AAPL', 'TSLA']);

    await db.appendChat(u.id, [
      { role: 'user', content: 'beli 2 lembar NVDA' },
      { role: 'assistant', content: 'Here is the preview.' },
    ]);
    const chat = await db.listChat(u.id, 10);
    assert.deepEqual(chat.map((c) => c.role), ['user', 'assistant']);
  });

  test('orders: insert, conditional update, listing, notices', async () => {
    const u = await db.upsertUser('0x00000000000000000000000000000000000000b2');
    const quoted = await db.insertOrder(order(u.id, u.address, { quote: { hello: 'world' } as never }));
    assert.equal(quoted.qty, 1.5);
    assert.deepEqual(quoted.quote, { hello: 'world' });

    // The worker and the web app race: only the first transition wins.
    const hashes = ['0x' + 'a'.repeat(64)];
    const pending = await db.updateOrder(quoted.id, { status: 'pending', txHash: hashes[0], txHashes: hashes }, ['quoted']);
    assert.equal(pending?.status, 'pending');
    assert.deepEqual(pending?.txHashes, hashes);
    assert.equal(await db.updateOrder(quoted.id, { status: 'cancelled' }, ['open']), null);
    const filled = await db.updateOrder(quoted.id, { status: 'filled', fillPrice: 176.1, filledAt: new Date().toISOString(), nonce: 7 }, ['pending']);
    assert.equal(filled?.fillPrice, 176.1);
    assert.equal(filled?.nonce, 7);

    await db.insertOrder(order(u.id, u.address, { symbol: 'AAPL', orderType: 'limit', limitPrice: 150, status: 'open' }));
    assert.equal((await db.listOrders({ userId: u.id, statuses: ['open'], limit: 10 })).length, 1);
    assert.equal((await db.listOrders({ userId: u.id, symbol: 'NVDA', limit: 10 })).length, 1);
    const notices = await db.listOrders({ userId: u.id, unnotified: true, limit: 10 });
    assert.deepEqual(notices.map((o) => o.id), [quoted.id]);
    await db.updateOrder(quoted.id, { notifiedAt: new Date().toISOString() });
    assert.equal((await db.listOrders({ userId: u.id, unnotified: true, limit: 10 })).length, 0);
    assert.equal(await db.getOrder('not-a-uuid'), null);
  });

  test('snapshots, cost basis, heat rows and reads, news', async () => {
    const u = await db.upsertUser('0x00000000000000000000000000000000000000c3');
    await db.upsertSnapshot({ userId: u.id, date: '2026-09-23', totalValueUsd: 1000.5, holdings: [{ symbol: 'NVDA', qty: 1, price: 170, value: 170 }] });
    await db.upsertSnapshot({ userId: u.id, date: '2026-09-24', totalValueUsd: 1010, holdings: [] });
    await db.upsertSnapshot({ userId: u.id, date: '2026-09-24', totalValueUsd: 1020, holdings: [] });
    const snaps = await db.listSnapshots(u.id);
    assert.deepEqual(snaps.map((s) => [s.date, s.totalValueUsd]), [['2026-09-23', 1000.5], ['2026-09-24', 1020]]);
    assert.equal((await db.listSnapshots(u.id, '2026-09-24')).length, 1);

    await db.setCostBasis(u.id, 'TSLA', 390.5);
    await db.setCostBasis(u.id, 'TSLA', 395);
    assert.deepEqual((await db.listCostBasis(u.id)).map((c) => [c.symbol, c.avgPrice]), [['TSLA', 395]]);
    await db.setCostBasis(u.id, 'TSLA', null);
    assert.equal((await db.listCostBasis(u.id)).length, 0);

    // A row in the old shape (bare numbers) still reads.
    await pool.query(`insert into heat_scores (symbol, score, components, computed_at) values ('OLD', 12.5, '{"onchain":0.3,"news":0.2,"social":null}', now())`, [] as never);
    await db.upsertHeat([{ symbol: 'NVDA', score: 72.4, computedAt: new Date().toISOString(), components: {
      onchain: { score: 0.8, volumeRatio: 3.2, holderGrowth: 0.01, liquidityHealth: 0.7, note: 'Volume 3.2×' },
      news: { score: 0.6, count24h: 7, avgSentiment: 0.4, drivers: ['n1'], note: '7 stories' },
      social: { score: null, reason: 'belum_aktif' }, weights: { onchain: 0.5625, news: 0.4375, social: 0 }, events: [],
    } }]);
    const heat = await db.listHeat(10);
    assert.equal(heat[0]?.symbol, 'NVDA');
    const old = heat.find((h) => h.symbol === 'OLD');
    assert.equal(old?.components.onchain.score, 0.3);
    assert.equal(old?.components.social.score, null);

    await db.upsertHeatRead({ symbol: 'NVDA', text: 'NVDA is hot.', source: 'llm', inputsHash: 'h1', computedAt: new Date().toISOString() });
    await db.upsertHeatRead({ symbol: 'NVDA', text: 'NVDA is still hot.', source: 'template', inputsHash: 'h2', computedAt: new Date().toISOString() });
    assert.equal((await db.getHeatRead('NVDA'))?.text, 'NVDA is still hot.');
    assert.equal((await db.listHeatReads()).length, 1);

    const inserted = await db.upsertNews([{ id: 'n1', cat: 'NEWS', title: 'NVDA files an 8-K', short: 'NVDA 8-K', symbols: ['NVDA'], sentiment: 0.2, url: 'https://example.com', source: 't', publishedAt: new Date().toISOString() }]);
    assert.equal(inserted, 1);
    assert.equal((await db.getNewsByIds(['n1', 'missing']))[0]?.title, 'NVDA files an 8-K');
  });

  test('cache: set, setMany, age, take once, delete, keys', async () => {
    await cache.set('rc:test:a', { x: 1 }, 30);
    await cache.setMany([
      { key: 'rc:test:b', value: [1, 2, 3], ttlSec: 30 },
      { key: 'rc:test:c', value: 'three', ttlSec: 30 },
    ]);
    assert.deepEqual(await cache.get('rc:test:a'), { x: 1 });
    assert.deepEqual((await cache.getWithAge('rc:test:b'))?.value, [1, 2, 3]);
    assert.deepEqual(await cache.keys('rc:test:'), ['rc:test:a', 'rc:test:b', 'rc:test:c']);
    assert.equal(await cache.take('rc:test:c'), 'three');
    assert.equal(await cache.take('rc:test:c'), null, 'a one-time value is gone after the first take');
    await cache.del('rc:test:a');
    assert.equal(await cache.get('rc:test:a'), null);
  });
});
