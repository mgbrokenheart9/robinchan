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

export function getPgPool(): pg.Pool | null {
  const url = databaseUrl();
  if (!url) return null;
  if (!state.pool) {
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
 */
export function ensureSchema(pool: pg.Pool): Promise<void> {
  state.schema ??= applySchema(pool).catch((err: unknown) => {
    state.schema = undefined;
    throw err;
  });
  return state.schema;
}

const SCHEMA_LOCK_ID = 7_243_150;

async function applySchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
    await client.query(SCHEMA_SQL);
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
