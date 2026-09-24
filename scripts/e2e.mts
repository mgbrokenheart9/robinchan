/**
 * End-to-end check of the Trade / Heat / Portfolio surfaces over HTTP,
 * with real SIWE sign-ins from throwaway keys. Run it against a server
 * started with trading on and three dev tiers mapped to the test wallets:
 *
 *   E2E_ACCOUNTS=path/to/accounts.json BASE_URL=http://localhost:3100 npx tsx scripts/e2e.mts
 *
 * accounts.json: { "tier1": {"key": "0x…"}, "tier3": {"key": "0x…"} } (the free wallet is new each run)
 * and on the server: FEATURE_TRADING=true FEATURE_HEAT_READS=true
 * RC_DEV_TIER="<tier1 address>=tier1,<tier3 address>=tier3,*=free" RC_ENV=dev
 *
 * Point it at an isolated RC_DATA_DIR (or a scratch database): it creates
 * users and orders.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type {
  CompanionRead,
  HeatBoard,
  HeatDetail,
  OrderQuote,
  OrderRecord,
  PortfolioHistory,
  PortfolioSummary,
  SessionInfo,
  TierState,
} from '@robinchan/shared';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const ORIGIN = new URL(BASE).origin;
const CHAIN_ID = Number(process.env.E2E_CHAIN_ID ?? 421614);
const accounts = JSON.parse(readFileSync(process.env.E2E_ACCOUNTS ?? 'e2e-accounts.json', 'utf8')) as Record<
  'tier1' | 'tier3',
  { key: `0x${string}` }
>;

type Res<T> = { status: number; body: { data?: T; error?: { code: string; message: string; field?: string } } & Record<string, unknown>; setCookie: string | null };

class Client {
  cookie = '';
  constructor(readonly account: PrivateKeyAccount | null) {}

  async call<T>(path: string, init: { method?: string; json?: unknown; origin?: string } = {}): Promise<Res<T>> {
    for (;;) {
      const res = await this.once<T>(path, init);
      // The public per-IP limit (60/min) is about this script's pace, not
      // what's under test: wait it out. The per-wallet limit is left alone.
      const ipLimited = res.status === 429 && !/wallet/i.test(res.body.error?.message ?? '');
      if (!ipLimited) return res;
      const wait = Number(res.retryAfter ?? 5) + 1;
      console.log(`    (per-IP limit reached; waiting ${wait}s)`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  private async once<T>(
    path: string,
    init: { method?: string; json?: unknown; origin?: string },
  ): Promise<Res<T> & { retryAfter: string | null }> {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers: {
        accept: 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(init.json !== undefined ? { 'content-type': 'application/json', origin: init.origin ?? ORIGIN } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie?.startsWith('rc_session=')) {
      const value = setCookie.split(';')[0] as string;
      this.cookie = value === 'rc_session=' ? '' : value;
    }
    const body = (await res.json().catch(() => ({}))) as Res<T>['body'];
    return { status: res.status, body, setCookie, retryAfter: res.headers.get('retry-after') };
  }

  async signIn(overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}): Promise<Res<SessionInfo>> {
    assert.ok(this.account);
    const nonce = (await this.call<{ nonce: string }>('/api/auth/nonce')).body.data?.nonce;
    assert.ok(nonce, 'nonce issued');
    const message = createSiweMessage({
      address: this.account.address,
      chainId: CHAIN_ID,
      domain: new URL(BASE).host,
      uri: ORIGIN,
      nonce,
      version: '1',
      issuedAt: new Date(),
      ...overrides,
    });
    const signature = await this.account.signMessage({ message });
    return this.call<SessionInfo>('/api/auth/verify', { json: { message, signature } });
  }

  async signTypedQuote(quote: OrderQuote): Promise<`0x${string}`> {
    assert.ok(this.account);
    assert.equal(quote.execution.kind, 'signature');
    if (quote.execution.kind !== 'signature') throw new Error('unreachable');
    const { domain, types, primaryType, message } = quote.execution.typedData;
    return this.account.signTypedData({ domain, types, primaryType, message } as Parameters<PrivateKeyAccount['signTypedData']>[0]);
  }
}

/**
 * This script makes well over the public 60-requests-a-minute-per-IP from
 * one address. Before checks that count requests, wait for that window to
 * reset so the per-wallet limit is what's being measured.
 */
async function freshIpWindow(): Promise<void> {
  const res = await fetch(`${BASE}/api/market/symbols`);
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? 60);
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0);
  if (remaining < 30) {
    console.log(`    (waiting ${reset + 1}s for the per-IP window to reset)`);
    await new Promise((r) => setTimeout(r, (reset + 1) * 1000));
  }
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${(err as Error).message.split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}

const anon = new Client(null);
// A fresh wallet each run: the free tier comes from the `*=free` wildcard,
// and a new address means a new sample portfolio with nothing bought yet.
const free = new Client(privateKeyToAccount(generatePrivateKey()));
const tier1 = new Client(privateKeyToAccount(accounts.tier1.key));
const tier3 = new Client(privateKeyToAccount(accounts.tier3.key));

console.log(`E2E against ${BASE}`);

console.log('Pages');
await check('Heat, Portfolio and Trade render (trading flag on)', async () => {
  for (const path of ['/heat', '/portfolio', '/trade?symbol=NVDA']) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, path);
  }
  const heat = await (await fetch(`${BASE}/heat`)).text();
  assert.match(heat, /Showing the top 5/);
});

console.log('Sign-in (SIWE)');
await check('a valid signature gets an httpOnly session cookie', async () => {
  const res = await free.signIn();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.setCookie ?? '', /HttpOnly/i);
  assert.equal((await free.call<SessionInfo>('/api/auth/session')).body.data?.address, free.account?.address);
});
await check('a nonce works once; wrong domain, wrong chain and a forged signature are refused', async () => {
  const c = new Client(free.account);
  const nonce = (await c.call<{ nonce: string }>('/api/auth/nonce')).body.data?.nonce as string;
  const message = createSiweMessage({ address: free.account!.address, chainId: CHAIN_ID, domain: new URL(BASE).host, uri: ORIGIN, nonce, version: '1', issuedAt: new Date() });
  const signature = await free.account!.signMessage({ message });
  assert.equal((await c.call('/api/auth/verify', { json: { message, signature } })).status, 200);
  assert.equal((await c.call('/api/auth/verify', { json: { message, signature } })).status, 401, 'replay');
  assert.equal((await new Client(free.account).signIn({ domain: 'evil.example' })).status, 401, 'domain');
  assert.equal((await new Client(free.account).signIn({ chainId: 1 })).status, 401, 'chain');
  const forger = new Client(tier3.account);
  const n2 = (await forger.call<{ nonce: string }>('/api/auth/nonce')).body.data?.nonce as string;
  const m2 = createSiweMessage({ address: free.account!.address, chainId: CHAIN_ID, domain: new URL(BASE).host, uri: ORIGIN, nonce: n2, version: '1', issuedAt: new Date() });
  const forged = await tier3.account!.signMessage({ message: m2 });
  assert.equal((await forger.call('/api/auth/verify', { json: { message: m2, signature: forged } })).status, 401, 'forged');
});
await check('tiers come from the server', async () => {
  assert.equal((await tier1.signIn()).status, 200);
  assert.equal((await tier3.signIn()).status, 200);
  assert.equal((await free.call<TierState>('/api/user/tier')).body.data?.tier, 'free');
  assert.equal((await tier1.call<TierState>('/api/user/tier')).body.data?.tier, 'tier1');
  assert.equal((await tier3.call<TierState>('/api/user/tier')).body.data?.tier, 'tier3');
  assert.equal((await anon.call('/api/user/tier')).status, 401);
});

console.log('Heat gating (filtered on the server)');
await check('no wallet: 5 rows, rounded, closed; locked rows carry nothing', async () => {
  const board = (await anon.call<HeatBoard>('/api/heat/full')).body.data!;
  const visible = board.rows.filter((r) => !r.locked);
  assert.equal(visible.length, 5);
  for (const r of visible) if (!r.locked) assert.ok(r.score % 10 === 0 && r.components === null && !r.expandable);
  for (const r of board.rows.filter((x) => x.locked)) assert.deepEqual(Object.keys(r).sort(), ['locked', 'requiredTier']);
  assert.equal((await anon.call('/api/heat/NVDA')).status, 403);
});
await check('wallet: full scores and components; triggers and read locked; watchlist needs Tier 1', async () => {
  const board = (await free.call<HeatBoard>('/api/heat/full')).body.data!;
  assert.equal(board.access.level, 'wallet');
  assert.ok(board.rows.every((r) => !r.locked && r.components));
  const detail = (await free.call<HeatDetail>('/api/heat/NVDA')).body.data!;
  assert.equal(detail.triggers, null);
  assert.equal(detail.components.find((c) => c.key === 'social')?.inactive, 'belum_aktif');
  assert.equal((await free.call('/api/user/watchlist', { method: 'PUT', json: { symbols: ['NVDA'] } })).status, 403);
  assert.equal((await free.call('/api/heat/full?filter=watchlist')).status, 403);
});
await check('Tier 1: triggers, watchlist filter, and a cached read (never generated on the click)', async () => {
  const detail = (await tier1.call<HeatDetail>('/api/heat/NVDA')).body.data!;
  assert.ok(Array.isArray(detail.triggers));
  const put = await tier1.call<string[]>('/api/user/watchlist', { method: 'PUT', json: { symbols: ['NVDA', 'RCHAN', 'NOTREAL'] } });
  assert.deepEqual(put.body.data, ['NVDA', 'RCHAN']);
  const watch = (await tier1.call<HeatBoard>('/api/heat/full?filter=watchlist')).body.data!;
  assert.deepEqual(watch.rows.map((r) => (r.locked ? '?' : r.symbol)).sort(), ['NVDA', 'RCHAN']);
  // Either the worker already wrote it, or opening the row queued it for next time.
  let read: HeatDetail['read'] = detail.read;
  for (let i = 0; i < 20 && !read; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    read = (await tier1.call<HeatDetail>('/api/heat/NVDA')).body.data!.read;
  }
  assert.ok(read?.text, 'a read is served from the table');
  console.log(`    read (${read?.source}): ${read?.text}`);
});

console.log('Portfolio');
await check('holdings, value, PnL only where the price paid is known', async () => {
  const p = (await free.call<PortfolioSummary>('/api/portfolio')).body.data!;
  assert.ok(p.totalValue > 0);
  assert.equal(p.trackedSince, new Date().toISOString().slice(0, 10));
  assert.ok(p.dust.length > 0 && p.unsupported.length > 0);
  assert.equal(p.unrealizedPnl, null, 'nothing bought through Robinchan yet');
  for (const range of ['24h', '7d', '30d', 'all']) {
    const h = await free.call<PortfolioHistory>(`/api/portfolio/history?range=${range}`);
    assert.equal(h.status, 200, range);
    assert.ok((h.body.data?.points.length ?? 0) >= 1, range);
  }
  assert.equal((await anon.call('/api/portfolio')).status, 401);
});
await check('a purchase price typed in by the user', async () => {
  const p = (await free.call<PortfolioSummary>('/api/portfolio')).body.data!;
  const target = p.holdings.find((h) => h.costBasis === 'unknown' && h.price != null)!;
  const res = await free.call<PortfolioSummary>('/api/portfolio/cost-basis', { method: 'PUT', json: { symbol: target.symbol, avgPrice: 100 } });
  assert.equal(res.status, 200);
  const after = res.body.data!.holdings.find((h) => h.symbol === target.symbol)!;
  assert.equal(after.costBasis, 'manual');
  assert.ok(after.pnl != null);
  assert.equal((await free.call('/api/portfolio/cost-basis', { method: 'PUT', json: { symbol: 'USDC', avgPrice: 1 } })).status, 400);
  assert.equal((await free.call('/api/portfolio/cost-basis', { method: 'PUT', json: { symbol: target.symbol, avgPrice: -5 } })).status, 400);
});
await check("Robinchan's read describes the portfolio without advising", async () => {
  const read = (await free.call<CompanionRead | null>('/api/portfolio/read')).body.data;
  assert.ok(read?.text);
  assert.doesNotMatch(read.text, /\b(should|recommend|diversif|sebaiknya)\b/i);
  console.log(`    read (${read.source}): ${read.text}`);
});

console.log('Trade (one pipeline, form and chat)');
let filledId = '';
await check('market order from the form: quote → sign → filled', async () => {
  const quote = await free.call<OrderQuote>('/api/order/quote', {
    json: { source: 'form', intent: { side: 'buy', symbol: 'NVDA', qty: 1, orderType: 'market', limitPrice: null } },
  });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const q = quote.body.data!;
  const signature = await free.signTypedQuote(q);
  const rec = await free.call<OrderRecord>('/api/order/record', { json: { orderId: q.id, signature } });
  assert.equal(rec.body.data?.status, 'filled', JSON.stringify(rec.body));
  filledId = q.id;
  const history = (await free.call<OrderRecord[]>('/api/orders?status=history')).body.data!;
  assert.ok(history.some((o) => o.id === filledId));
  const p = (await free.call<PortfolioSummary>('/api/portfolio')).body.data!;
  assert.ok(p.unrealizedPnl != null, 'PnL appears once a price paid is known');
});
await check('limit orders: refused below Tier 3; at Tier 3 they rest, draw, and cancel', async () => {
  const intent = { side: 'buy', symbol: 'AAPL', qty: 1, orderType: 'limit', limitPrice: 150 };
  const refused = await free.call('/api/order/quote', { json: { source: 'form', intent } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, 'TIER_REQUIRED');
  const q = (await tier3.call<OrderQuote>('/api/order/quote', { json: { source: 'form', intent } })).body.data!;
  assert.equal(q.ack?.code, 'LIMIT_DEVIATION', 'far below market needs an acknowledgement');
  const open = (await tier3.call<OrderRecord>('/api/order/record', { json: { orderId: q.id, signature: await tier3.signTypedQuote(q) } })).body.data!;
  assert.equal(open.status, 'open');
  const listed = (await tier3.call<OrderRecord[]>('/api/orders?status=open&symbol=AAPL')).body.data!;
  assert.ok(listed.some((o) => o.id === open.id && o.limitPrice === 150));
  const cancelled = await tier3.call<OrderRecord>(`/api/orders/${open.id}/cancel`, { json: {} });
  assert.equal(cancelled.body.data?.status, 'cancelled');
  assert.equal((await free.call(`/api/orders/${open.id}/cancel`, { json: {} })).status, 404, "someone else's order");
});
await check('an order written in the chat comes back as the same kind of quote, and signs the same way', async () => {
  const chat = await tier3.call<never>('/api/chat', {
    json: { message: 'beli 2 lembar NVDA', history: [], voice: false, context: { page: 'trade', symbol: 'NVDA' } },
  });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  const order = (chat.body as unknown as { order: OrderQuote | null; reply: string }).order;
  console.log(`    reply: ${(chat.body as unknown as { reply: string }).reply}`);
  assert.ok(order, 'order preview attached');
  assert.deepEqual(order.intent, { side: 'buy', symbol: 'NVDA', qty: 2, orderType: 'market', limitPrice: null });
  const rec = await tier3.call<OrderRecord>('/api/order/record', { json: { orderId: order.id, signature: await tier3.signTypedQuote(order) } });
  assert.equal(rec.body.data?.status, 'filled');
  assert.equal((await tier3.call<OrderRecord[]>('/api/orders?status=history')).body.data!.find((o) => o.id === order.id)?.source, 'chat');
  const history = (await tier3.call<Array<{ role: string; text: string }>>('/api/chat/history')).body.data!;
  assert.ok(history.some((m) => m.role === 'user' && m.text === 'beli 2 lembar NVDA'), 'one thread, kept on the server');
});
await check('parse endpoint asks back instead of guessing', async () => {
  const res = await tier3.call('/api/order/parse', { json: { text: 'buy $500 of NVDA' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, 'PARSE_INCOMPLETE');
  assert.deepEqual((res.body.error as unknown as { missing: string[] }).missing, ['qty']);
});

console.log('Edges');
await check('cross-site writes are refused', async () => {
  const res = await free.call('/api/order/quote', {
    origin: 'https://evil.example',
    json: { source: 'form', intent: { side: 'buy', symbol: 'NVDA', qty: 1, orderType: 'market', limitPrice: null } },
  });
  assert.equal(res.status, 403);
});
await check('quotes are rate-limited per wallet (10 a minute)', async () => {
  await freshIpWindow();
  const intent = { side: 'buy', symbol: 'MSFT', qty: 1, orderType: 'market', limitPrice: null };
  const results: Array<{ status: number; message?: string }> = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await tier1.call('/api/order/quote', { json: { source: 'form', intent } });
    results.push({ status: res.status, message: res.body.error?.message });
  }
  const statuses = results.map((r) => r.status).join(',');
  assert.ok(results.slice(0, 10).every((r) => r.status === 200), statuses);
  assert.ok(results.slice(10).every((r) => r.status === 429 && /wallet/.test(r.message ?? '')), statuses);
});
await check('sign out clears the session', async () => {
  await freshIpWindow();
  await free.call('/api/auth/logout', { json: {} });
  assert.equal((await free.call<SessionInfo | null>('/api/auth/session')).body.data, null);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some failed' : ''}.`);
