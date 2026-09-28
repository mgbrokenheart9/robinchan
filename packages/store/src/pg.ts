import { createHash } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';

import pg from 'pg';

import { SCHEMA_SQL } from './schema';

/**
 * Vercel Postgres (Neon) connection string. The Vercel ↔ Neon integration
 * injects the pooled URL as both `DATABASE_URL` and `POSTGRES_URL`, so either
 * is accepted. Empty means the file fallback in `.data/` (local dev only).
 */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

type PgState = { pool?: pg.Pool; schema?: Promise<void> };

/**
 * One pool per process, parked on `globalThis` so the Next.js dev server's
 * module reloads reuse it instead of leaking a fresh pool on every edit.
 */
const state = ((globalThis as unknown as Record<symbol, unknown>)[
  Symbol.for('robinchan.store.pg')
] ??= {}) as PgState;

/**
 * Node tries a host's addresses one after another and gives each 250 ms to
 * connect ("happy eyeballs"). Neon's pooler is in Singapore: from a server
 * far from it a TCP handshake can take longer, every address "times out",
 * and the connect fails with an AggregateError of ETIMEDOUTs and an empty
 * message — the worker died at boot on it (2026-09-27 and -28). Each attempt
 * gets 3 s, and IPv4 goes first (the hosts here have no IPv6 route).
 */
function patientConnections(): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout?.(3_000);
  dns.setDefaultResultOrder('ipv4first');
}

export function getPgPool(): pg.Pool | null {
  const url = databaseUrl();
  if (!url) return null;
  if (!state.pool) {
    patientConnections();
    const pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 10_000 });
    // Neon closes idle connections when its compute scales to zero. Without a
    // listener, that error on an idle client would crash the whole process.
    pool.on('error', (err) => {
      console.warn(`[store] idle Postgres client dropped: ${err.message}`);
    });
    state.pool = pool;
  }
  return state.pool;
}

/**
 * Apply the schema once per process, before the first query. Both the web
 * server and the worker may boot at the same moment against a fresh
 * database, so the DDL runs under an advisory lock — two concurrent
 * `create table if not exists` can still collide on the system catalog.
 *
 * On serverless (Vercel) every cold start is a new process, so this runs
 * constantly — and an instance can be frozen mid-transaction while holding
 * the lock. That once parked every request on every instance behind a dead
 * session for minutes, and the DDL's `alter table` also queued behind the
 * worker's writes, blocking all reads behind it. Hence:
 *
 * - A version check first: once this exact schema is applied, no process
 *   takes any lock at all.
 * - When DDL does run, `lock_timeout` makes waiters give up instead of
 *   queueing, and `idle_in_transaction_session_timeout` lets Postgres kill
 *   a holder that stalls. Giving up is not an error for the request: the
 *   schema is being applied elsewhere, so it proceeds and retries later.
 */
export function ensureSchema(pool: pg.Pool): Promise<void> {
  state.schema ??= applySchema(pool).catch((err: unknown) => {
    state.schema = undefined;
    // 55P03 lock_not_available: another process holds the schema lock.
    if ((err as { code?: string }).code === '55P03') return;
    throw err;
  });
  return state.schema;
}

const SCHEMA_LOCK_ID = 7_243_150;
const SCHEMA_VERSION = createHash('sha256').update(SCHEMA_SQL).digest('hex').slice(0, 16);

async function schemaIsCurrent(q: pg.Pool | pg.PoolClient): Promise<boolean> {
  try {
    const r = await q.query('select 1 from rc_schema_version where version = $1', [SCHEMA_VERSION]);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false; // table not there yet: first run on this database
  }
}

async function applySchema(pool: pg.Pool): Promise<void> {
  if (await schemaIsCurrent(pool)) return;

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local idle_in_transaction_session_timeout = '15s'");
    await client.query('select pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
    await client.query(
      'create table if not exists rc_schema_version (version text primary key, applied_at timestamptz not null default now())',
    );
    // Re-check under the lock: another process may have just finished.
    if (!(await schemaIsCurrent(client))) {
      await client.query(SCHEMA_SQL);
      await client.query('insert into rc_schema_version (version) values ($1) on conflict do nothing', [
        SCHEMA_VERSION,
      ]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Idempotent: the cache and the db share this pool, and both may close it. */
export async function closePgPool(): Promise<void> {
  const pool = state.pool;
  if (!pool) return;
  state.pool = undefined;
  state.schema = undefined;
  await pool.end();
}
