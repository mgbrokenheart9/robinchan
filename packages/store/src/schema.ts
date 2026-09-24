/**
 * Robinchan — Postgres schema (dev brief §10), applied by `ensureSchema()`.
 *
 * The seven tables from the brief, the three the Trade/Heat/Portfolio brief
 * adds (`portfolio_snapshots`, `cost_basis_overrides`, `heat_reads`, plus
 * new `orders` columns), and two that stand in for Redis now that the whole
 * store lives in one Vercel Postgres (Neon) database: `kv_cache` holds the
 * `rc:<domain>:<key>` cache entries (prices included, which is why they no
 * longer need a separate Redis), and `rate_limits` holds the per-IP request
 * windows shared by every serverless instance.
 *
 * Every statement is idempotent (`if not exists`), so an existing database
 * picks up the additions on the next boot without a migration step.
 *
 * Kept as a TypeScript string rather than a `.sql` file: this module is
 * bundled into the Next.js server, where reading a file relative to
 * `import.meta.url` no longer points at the source tree.
 */
export const SCHEMA_SQL = `
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  wallet_address text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint wallet_lowercase check (wallet_address = lower(wallet_address))
);

create table if not exists chat_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant', 'system')),
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_user_idx on chat_messages (user_id, created_at desc);

create table if not exists orders (
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
create index if not exists orders_user_idx on orders (user_id, created_at desc);

create table if not exists news_items (
  id           text primary key,
  external_id  text not null unique,
  title_hash   text not null,
  cat          text not null check (cat in ('SEC', 'NEWS', 'CHAIN', 'SOCIAL')),
  title        text not null,
  short        text not null,
  symbols      text[] not null default '{}',
  sentiment    real not null default 0,
  url          text not null,
  source       text not null,
  pinned       boolean not null default false,
  published_at timestamptz not null
);
create index if not exists news_items_published_idx on news_items (published_at desc);
create index if not exists news_items_symbols_idx on news_items using gin (symbols);
create index if not exists news_items_title_hash_idx on news_items (title_hash, published_at desc);

create table if not exists heat_scores (
  symbol      text primary key,
  score       real not null,
  components  jsonb not null,
  computed_at timestamptz not null default now()
);
create index if not exists heat_scores_score_idx on heat_scores (score desc);

create table if not exists calendar_events (
  id       text primary key,
  date     date not null,
  title    text not null,
  subtitle text not null default '',
  kind     text not null check (kind in ('earnings', 'macro', 'chain')),
  symbol   text
);
create index if not exists calendar_events_date_idx on calendar_events (date asc);

create table if not exists watchlists (
  user_id  uuid not null references users(id) on delete cascade,
  symbol   text not null,
  added_at timestamptz not null default now(),
  primary key (user_id, symbol)
);

-- ---- Trade / Heat / Portfolio additions ------------------------------------
-- The \`orders\` table serves all three pages: the Trade page's tabs, the
-- Portfolio history, and cost basis (Trade-Heat-Portfolio brief §9).
alter table orders add column if not exists address       text;
alter table orders add column if not exists order_type    text not null default 'market';
alter table orders add column if not exists source        text not null default 'form';
alter table orders add column if not exists venue         text not null default 'paper';
alter table orders add column if not exists quote_price   numeric;
alter table orders add column if not exists fill_price    numeric;
alter table orders add column if not exists est_total     numeric;
alter table orders add column if not exists fee           numeric;
alter table orders add column if not exists slippage_bps  integer;
-- The quote exactly as issued, execution payload included: recording a
-- signature or hash is checked against this, never against client state.
alter table orders add column if not exists quote         jsonb;
alter table orders add column if not exists tx_hashes     text[] not null default '{}';
alter table orders add column if not exists signature     text;
alter table orders add column if not exists error         text;
alter table orders add column if not exists expires_at    timestamptz;
alter table orders add column if not exists submitted_at  timestamptz;
alter table orders add column if not exists filled_at     timestamptz;
alter table orders add column if not exists updated_at    timestamptz not null default now();
alter table orders add column if not exists notified_at   timestamptz;
alter table orders add column if not exists checked_at    timestamptz;
-- Nonce of the sent transaction, once seen on the network — how a replaced
-- (sped-up / cancelled) transaction is told apart from one still waiting.
alter table orders add column if not exists nonce         integer;

-- The original check only knew parsed/quoted/signed/failed/expired.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'orders_status_check'
       and pg_get_constraintdef(oid) not like '%cancelled%'
  ) then
    alter table orders drop constraint orders_status_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_status_check') then
    alter table orders add constraint orders_status_check check (status in
      ('parsed', 'quoted', 'signed', 'pending', 'open', 'filled', 'failed', 'expired', 'cancelled'));
  end if;
end $$;

-- Cost basis is computed per symbol.
create index if not exists orders_user_symbol_idx on orders (user_id, symbol, created_at);
-- The worker's monitors only ever look at orders still in flight.
create index if not exists orders_live_idx on orders (status) where status in ('quoted', 'pending', 'open');

create table if not exists portfolio_snapshots (
  user_id         uuid not null references users(id) on delete cascade,
  date            date not null,
  total_value_usd numeric not null,
  holdings        jsonb not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, date)
);

create table if not exists cost_basis_overrides (
  user_id    uuid not null references users(id) on delete cascade,
  symbol     text not null,
  avg_price  numeric not null check (avg_price > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, symbol)
);

-- Robinchan's cached read per symbol. Generated by the worker when the heat
-- score is recomputed, never on the click that opens a row.
create table if not exists heat_reads (
  symbol      text primary key,
  text        text not null,
  source      text not null default 'llm',
  inputs_hash text not null default '',
  computed_at timestamptz not null default now()
);

-- \`json\`, not \`jsonb\`: values are only ever read back whole, and \`json\`
-- keeps the exact text written, so API responses come back byte-for-byte.
create table if not exists kv_cache (
  key        text primary key,
  value      json not null,
  written_at timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists kv_cache_expires_idx on kv_cache (expires_at);

create table if not exists rate_limits (
  key      text primary key,
  count    integer not null,
  reset_at timestamptz not null
);
create index if not exists rate_limits_reset_idx on rate_limits (reset_at);
`;
