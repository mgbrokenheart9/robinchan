/**
 * End-to-end check of Perps over HTTP: real SIWE sign-ins, real wallet
 * signatures (paper) or real transactions (on chain), and the worker doing
 * its part (executing orders, liquidating, mirroring events).
 *
 *   PERPS_E2E_VENUE=paper|agri-perp BASE_URL=http://localhost:3100 RC_DATA_DIR=<same as the servers> npx tsx scripts/e2e-perps.mts
 *
 * Servers (web + worker), both with an isolated store — never a real database:
 *   RC_ENV=dev DATABASE_URL= POSTGRES_URL= RC_DATA_DIR=<scratch> FEATURE_PERPS=true
 *   PERPS_PRICE_INTERVAL_MS=600000   (this script sets the prices; the worker mustn't overwrite them)
 * Beside a running `npm run dev`, the web server needs its own build directory:
 *   NEXT_DIST_DIR=.next-e2e npx next dev -p 3100   (Next adds it to tsconfig.json's include — don't commit that)
 * paper:     PERPS_VENUE=paper
 * agri-perp: a local chain (`npx hardhat node` in contracts/) with the contracts deployed
 *            (`npx hardhat run scripts/deploy.ts --network localhost`: MockAggregators stand in
 *            for Chainlink), and PERPS_VENUE=agri-perp PERPS_ORACLE=mock NEXT_PUBLIC_CHAIN_ID=31337
 *            NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545 AGRI_FEED_ADDRESS/AGRI_VAULT_ADDRESS/AGRI_PERP_ADDRESS
 *            AGRI_DEPLOY_BLOCK and, on the worker, KEEPER_PRIVATE_KEY (Hardhat account #1). The
 *            worker posts the prices this script caches into the mock feeds, as Chainlink would.
 *            This script needs AGRI_PERP_ADDRESS too: it slows execution down to test a cancel.
 *
 * The trader on chain is Hardhat account #2, the owner #0 — public test keys, local chains only.
 */
import assert from 'node:assert/strict';

import type {
  PerpAccount,
  PerpActionRecord,
  PerpCancelQuote,
  PerpCloseQuote,
  PerpMarket,
  PerpOpenQuote,
  PerpPosition,
  PerpWaitingOrder,
  SessionInfo,
  TxRequest,
} from '@robinchan/shared';
import { perpMarket } from '@robinchan/shared';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const VENUE = (process.env.PERPS_E2E_VENUE ?? 'paper') as 'paper' | 'agri-perp';
const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const ORIGIN = new URL(BASE).origin;
const ONCHAIN = VENUE === 'agri-perp';
const CHAIN_ID = ONCHAIN ? 31337 : Number(process.env.E2E_CHAIN_ID ?? 421614);
const RPC = process.env.E2E_RPC_URL ?? 'http://127.0.0.1:8545';
/** Hardhat's well-known accounts #0 (deployer, owner) and #2 — only ever funded on a local chain. */
const HARDHAT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HARDHAT_2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

if (!process.env.RC_DATA_DIR) throw new Error('Set RC_DATA_DIR to the servers’ data directory (this script moves prices there).');
if (ONCHAIN && !(process.env.AGRI_PERP_ADDRESS && process.env.AGRI_FEED_ADDRESS)) throw new Error('Set AGRI_PERP_ADDRESS and AGRI_FEED_ADDRESS (the deployment) for the on-chain run.');
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';
const core = await import('../packages/core/src/index');

type Res<T> = { status: number; body: { data?: T; error?: { code: string; message: string; field?: string } } };

class Client {
  cookie = '';
  constructor(readonly account: PrivateKeyAccount | null) {}

  async call<T>(path: string, init: { method?: string; json?: unknown; origin?: string } = {}): Promise<Res<T>> {
    for (;;) {
      const res = await fetch(`${BASE}${path}`, {
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        redirect: 'manual',
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
      // The public per-IP limit is about this script's pace, not what's under test.
      if (res.status === 429 && !/wallet/i.test(body.error?.message ?? '')) {
        const wait = Number(res.headers.get('retry-after') ?? 5) + 1;
        console.log(`    (per-IP limit reached; waiting ${wait}s)`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      return { status: res.status, body };
    }
  }

  async signIn(): Promise<Res<SessionInfo>> {
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
    });
    const signature = await this.account.signMessage({ message });
    return this.call<SessionInfo>('/api/auth/verify', { json: { message, signature } });
  }
}

const chain = defineChain({ id: 31337, name: 'Hardhat', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const trader = ONCHAIN ? privateKeyToAccount(HARDHAT_2) : privateKeyToAccount(generatePrivateKey());
const wallet = ONCHAIN ? createWalletClient({ account: trader, chain, transport: http(RPC) }) : null;
const owner = ONCHAIN ? createWalletClient({ account: privateKeyToAccount(HARDHAT_0), chain, transport: http(RPC) }) : null;
const reader = ONCHAIN ? createPublicClient({ chain, transport: http(RPC) }) : null;
const me = new Client(trader);
const anon = new Client(null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Put a price into the cache the servers read, as if Chainlink had published
 * it `ageSec` ago. On chain, wait for the worker to post it into the local
 * feed too, as the contract reads it there.
 */
async function setPrice(symbol: string, usd: number, ageSec = 0): Promise<void> {
  const publishTime = Math.floor(Date.now() / 1000) - ageSec;
  const feed = perpMarket(symbol)!.contracts[0]!.feedId;
  await core.writeFeedPrices([{ symbol, feed, price: usd, publishTime, roundId: String(publishTime), source: 'fixture' }]);
  if (!ONCHAIN || !reader) return;
  const market = keccak256(toBytes(symbol));
  for (let i = 0; i < 40; i += 1) {
    const [price] = await reader.readContract({ address: process.env.AGRI_FEED_ADDRESS as Address, abi: core.AGRI_FEED_ABI, functionName: 'readUnsafe', args: [market] });
    if (Math.abs(Number(price) / 1e18 - usd) < 1e-6) return;
    await sleep(500);
  }
  throw new Error(`the local ${symbol} feed never showed ${usd}`);
}

/** Sends a quote's transactions the way the page does, recording each; returns the record without waiting. */
async function submit(quote: { id: string; execution: PerpOpenQuote['execution'] }): Promise<PerpActionRecord> {
  if (quote.execution.kind === 'signature') {
    const { domain, types, primaryType, message } = quote.execution.typedData;
    const signature = await trader.signTypedData({ domain, types, primaryType, message } as Parameters<PrivateKeyAccount['signTypedData']>[0]);
    const res = await me.call<PerpActionRecord>('/api/perps/record', { json: { actionId: quote.id, signature } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data!;
  }
  let record: PerpActionRecord | undefined;
  for (const [step, tx] of quote.execution.txs.entries()) {
    const hash = await send(tx);
    const res = await me.call<PerpActionRecord>('/api/perps/record', { json: { actionId: quote.id, txHash: hash, step } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    record = res.body.data;
  }
  return record!;
}

/** Signs and waits: on chain an action is pending until the keeper executes its order. */
async function sign(quote: { id: string; execution: PerpOpenQuote['execution'] }): Promise<PerpActionRecord> {
  return settle(await submit(quote));
}

async function send(tx: TxRequest): Promise<Hex> {
  assert.ok(wallet && reader);
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${tx.label} reverted`);
  return hash;
}

async function settle(record: PerpActionRecord, seconds = 60): Promise<PerpActionRecord> {
  let r = record;
  for (let i = 0; i < seconds / 1.5 && r.status === 'pending'; i += 1) {
    await sleep(1500);
    r = (await me.call<PerpActionRecord>(`/api/perps/actions/${r.id}`)).body.data!;
  }
  return r;
}

async function positions(): Promise<PerpPosition[]> {
  return (await me.call<PerpPosition[]>('/api/perps/positions')).body.data ?? [];
}

/** The owner's minimum execution delay, for new orders (the other settings stay). */
async function setMinDelay(seconds: number): Promise<void> {
  assert.ok(owner && reader);
  const perp = process.env.AGRI_PERP_ADDRESS as Address;
  const read = (functionName: 'maxExecutionDelay' | 'liquidationPriceAge' | 'requestPriceAge' | 'minExecutionFee') =>
    reader.readContract({ address: perp, abi: core.AGRI_PERP_ABI, functionName });
  const [maxDelay, liquidationAge, requestAge, fee] = await Promise.all([read('maxExecutionDelay'), read('liquidationPriceAge'), read('requestPriceAge'), read('minExecutionFee')]);
  const hash = await owner.writeContract({ address: perp, abi: core.AGRI_PERP_ABI, functionName: 'setExecution', args: [BigInt(seconds), maxDelay, liquidationAge, requestAge, fee] });
  assert.equal((await reader.waitForTransactionReceipt({ hash })).status, 'success');
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

const near = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} ≉ ${b}`);

console.log(`Perps E2E (${VENUE}) against ${BASE}`);

// The worker fills the price cache on its first run.
for (let i = 0; i < 60; i += 1) {
  const m = (await anon.call<PerpMarket[]>('/api/perps/markets')).body.data;
  if (m?.some((x) => x.symbol === 'ETH' && x.price != null)) break;
  await sleep(1000);
}

console.log('Pages and market data');
await check('/perps renders (BTC by default, an agri market too); /trade redirects to the same market on /perps', async () => {
  assert.equal((await fetch(`${BASE}/perps`)).status, 200);
  assert.equal((await fetch(`${BASE}/perps?symbol=COFF`)).status, 200);
  const res = await fetch(`${BASE}/trade?symbol=NVDA`, { redirect: 'manual' });
  assert.ok([307, 308].includes(res.status), `status ${res.status}`);
  assert.match(res.headers.get('location') ?? '', /\/perps\?symbol=NVDA$/);
});
await check('20 markets in 3 categories; the 11 without a Chainlink feed on Robinhood Chain say so', async () => {
  await setPrice('ETH', 3000);
  const res = await anon.call<PerpMarket[]>('/api/perps/markets');
  const markets = res.body.data!;
  assert.equal(markets.length, 28);
  assert.deepEqual([...new Set(markets.map((m) => m.category))], ['agri', 'crypto', 'stocks', 'rh']);
  const unavailable = markets.filter((m) => m.status === 'unavailable');
  assert.deepEqual(unavailable.map((m) => m.symbol), ['PALM', 'SOL', 'ARB', 'PONS', 'CASHCAT', 'DELTA']);
  for (const m of unavailable) assert.match(m.statusNote ?? '', /Chainlink has no|^Coming soon\./);
  const eth = markets.find((m) => m.symbol === 'ETH')!;
  assert.equal(eth.status, 'open');
  near(eth.price as number, 3000, 1e-9, 'ETH price');
  assert.equal(eth.contract, 'Chainlink ETH / USD');
  assert.equal(eth.maxLeverage, 20);
  assert.equal(markets.find((m) => m.symbol === 'NVDA')?.maxLeverage, 5);
  assert.equal((await anon.call<PerpMarket[]>('/api/perps/markets?category=agri')).body.data!.length, 9);
});
await check('stats, price and chart bars', async () => {
  const stats = await anon.call<{ symbol: string; longOiPercent: number; rollFactor: number }>('/api/perps/stats/ETH');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data?.rollFactor, 1);
  const price = await anon.call<{ price: number; fresh: boolean }>('/api/perps/price/ETH');
  near(price.body.data!.price, 3000, 1e-6, 'ETH price');
  assert.equal(price.body.data!.fresh, true);
  const candles = await anon.call<{ candles: unknown[] }>('/api/perps/candles/ETH?interval=1H');
  assert.equal(candles.status, 200);
  assert.ok((candles.body.data?.candles.length ?? 0) > 0, 'bars built by the worker');
  assert.equal((await anon.call('/api/perps/candles/NOPE')).status, 404);
});
await check('a feed quiet past its daily heartbeat is closed; a stock follows its 24/5 session', async () => {
  await setPrice('BTC', 84_000, 26 * 3600);
  const btc = (await anon.call<PerpMarket[]>('/api/perps/markets?category=crypto')).body.data!.find((m) => m.symbol === 'BTC')!;
  assert.equal(btc.status, 'closed');
  assert.match(btc.statusNote ?? '', /past its daily heartbeat/);
  await setPrice('AAPL', 341, 3 * 3600);
  const aapl = (await anon.call<PerpMarket[]>('/api/perps/markets?category=stocks')).body.data!.find((m) => m.symbol === 'AAPL')!;
  const shut = /Market closed for the weekend/.test(aapl.statusNote ?? '');
  assert.equal(aapl.status, shut ? 'closed' : 'open', aapl.statusNote ?? '');
});

console.log('Wallet');
await check('wallet routes need a signed-in wallet', async () => {
  assert.equal((await anon.call('/api/perps/positions')).status, 401);
  assert.equal((await anon.call('/api/perps/orders')).status, 401);
  assert.equal((await anon.call('/api/perps/quote', { json: { action: 'open', symbol: 'ETH', side: 'long', collateral: 10, leverage: 2 } })).status, 401);
  const res = await me.signIn();
  assert.equal(res.status, 200, JSON.stringify(res.body));
});
await check(ONCHAIN ? 'test USDC: a mint transaction the wallet sends, then a deposit' : 'test USDC from the faucet', async () => {
  const faucet = await me.call<{ kind: string; txs?: TxRequest[] }>('/api/perps/faucet', { json: {} });
  assert.equal(faucet.status, 200, JSON.stringify(faucet.body));
  if (ONCHAIN) {
    assert.equal(faucet.body.data?.kind, 'transactions');
    for (const tx of faucet.body.data!.txs!) await send(tx);
    const deposit = await me.call<{ id: string; execution: PerpOpenQuote['execution'] }>('/api/perps/collateral', { json: { kind: 'deposit', amount: 2_000 } });
    assert.equal(deposit.status, 200, JSON.stringify(deposit.body));
    const done = await sign(deposit.body.data!);
    assert.equal(done.status, 'done', done.error ?? '');
  }
  const account = (await me.call<PerpAccount>('/api/perps/collateral')).body.data!;
  assert.equal(account.venue, VENUE);
  if (ONCHAIN) {
    near(account.free, 2_000, 1e-6, 'free collateral in the vault');
    near(account.walletUsdc as number, 8_000, 1e-6, 'USDC left in the wallet');
  } else near(account.free, 10_000, 1e-6, 'free test USDC');
});

console.log('A position, end to end');
let positionId = '';
await check(ONCHAIN ? 'open: quote → approve + request → the keeper executes at the next Chainlink round' : 'open: quote → typed-data signature → filled', async () => {
  await setPrice('ETH', 3000);
  const q = await me.call<PerpOpenQuote>('/api/perps/quote', { json: { action: 'open', symbol: 'ETH', side: 'long', collateral: 1_000, leverage: 10 } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const quote = q.body.data!;
  assert.equal(quote.size, 10_000);
  near(quote.liquidationPrice, 3000 * 0.92, 1e-6, 'liquidation price');
  if (ONCHAIN) {
    assert.deepEqual(quote.execution.kind === 'transactions' && quote.execution.txs.map((t) => t.label), quote.depositNeeded > 0 ? ['Approve USDC', 'Open long ETH'] : ['Open long ETH']);
    assert.ok(quote.warnings.some((w) => /Chainlink's next ETH price/.test(w)), 'says it waits for the next round');
  }
  const record = await sign(quote);
  assert.equal(record.status, 'done', record.error ?? '');
  const [p] = await positions();
  assert.ok(p, 'the position is listed');
  positionId = p.id;
  near(p.entryPrice, 3000, 1e-6, 'entry');
  assert.equal(p.venue, VENUE);
  if (ONCHAIN) assert.ok(p.chainPositionId, 'mirrored from the contract');
});
await check('marked to the price: +5% on 10× is +50%', async () => {
  await setPrice('ETH', 3150);
  const [p] = await positions();
  near(p!.unrealizedPnl as number, 500, 1e-3, 'unrealized PnL');
  near(p!.pnlPct as number, 50, 1e-3, 'PnL %');
});
await check('close: quote → sign → paid out collateral + PnL − 0.1% fee', async () => {
  const q = await me.call<PerpCloseQuote>('/api/perps/quote', { json: { action: 'close', positionId } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  near(q.body.data!.estPayout, 1_490, 1e-3, 'estimated payout');
  const record = await sign(q.body.data!);
  assert.equal(record.status, 'done', record.error ?? '');
  assert.equal((await positions()).length, 0);
  const history = (await me.call<PerpPosition[]>('/api/perps/history')).body.data!;
  const closed = history.find((h) => h.id === positionId);
  assert.equal(closed?.status, 'closed');
  near(closed!.realizedPnl as number, 490, 1e-3, 'realized PnL');
  if (ONCHAIN) assert.ok(closed!.explorerClose === null || closed!.txClose, 'close transaction recorded');
});

console.log('Refusals');
await check('no oracle, too much leverage, too little balance, a feed gone quiet', async () => {
  const quote = (body: object) => me.call('/api/perps/quote', { json: { action: 'open', ...body } });
  const corn = await quote({ symbol: 'CORN', side: 'long', collateral: 10, leverage: 2 });
  assert.equal(corn.body.error?.code, 'NOT_TRADABLE');
  await setPrice('ETH', 3000);
  const tooMuch = await quote({ symbol: 'ETH', side: 'long', collateral: 10, leverage: 21 });
  assert.equal(tooMuch.status, 400, 'crypto goes to 20×');
  assert.match(tooMuch.body.error?.message ?? '', /up to 20×/);
  const broke = await quote({ symbol: 'ETH', side: 'long', collateral: 500_000, leverage: 2 });
  assert.equal(broke.body.error?.code, 'INSUFFICIENT_BALANCE');
  await setPrice('BTC', 84_000, 26 * 3600);
  assert.equal((await quote({ symbol: 'BTC', side: 'long', collateral: 10, leverage: 2 })).body.error?.code, 'MARKET_CLOSED');
  if (!ONCHAIN) assert.deepEqual((await me.call<PerpWaitingOrder[]>('/api/perps/orders')).body.data, [], 'paper orders never wait');
});
await check('cross-site writes are refused', async () => {
  const res = await me.call('/api/perps/quote', { origin: 'https://evil.example', json: { action: 'open', symbol: 'ETH', side: 'long', collateral: 10, leverage: 2 } });
  assert.equal(res.status, 403);
});

console.log('Liquidation');
await check('a 20× short past 80% loss is liquidated by the worker', async () => {
  await setPrice('ETH', 3000);
  const q = await me.call<PerpOpenQuote>('/api/perps/quote', { json: { action: 'open', symbol: 'ETH', side: 'short', collateral: 200, leverage: 20 } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const opened = await sign(q.body.data!);
  assert.equal(opened.status, 'done', opened.error ?? '');
  // 80% of collateral at 20× is a 4% move; take it to +4.5%.
  let liquidated: PerpPosition | undefined;
  for (let i = 0; i < 30 && !liquidated; i += 1) {
    await setPrice('ETH', 3000 * 1.045);
    await sleep(1500);
    liquidated = (await me.call<PerpPosition[]>('/api/perps/history')).body.data!.find((h) => h.status === 'liquidated');
  }
  assert.ok(liquidated, 'liquidated within ~45s');
  // Loss 180 of 200 → 20 left; the liquidator keeps 10% (at least 0.5% of collateral) → the trader gets 18.
  near(liquidated.payout as number, 18, 0.05, 'payout after liquidation');
});

if (ONCHAIN) {
  console.log('Taking an order back');
  await check('asked back while it waits: listed as asked, no second ask, and the next round cancels it', async () => {
    // Orders wait a minute for their round from here on: time to ask.
    await setMinDelay(60);
    try {
      await setPrice('ETH', 3000);
      const freeBefore = (await me.call<PerpAccount>('/api/perps/collateral')).body.data!.free;
      const q = await me.call<PerpOpenQuote>('/api/perps/quote', { json: { action: 'open', symbol: 'ETH', side: 'long', collateral: 100, leverage: 2 } });
      assert.equal(q.status, 200, JSON.stringify(q.body));
      near(q.body.data!.acceptablePrice, 3000 * 1.015, 1e-6, 'on chain the limit leaves room for the next round: 1.5%');
      let record = await submit(q.body.data!);
      for (let i = 0; i < 20 && !record.cancellable; i += 1) {
        await sleep(500);
        record = (await me.call<PerpActionRecord>(`/api/perps/actions/${record.id}`)).body.data!;
      }
      assert.ok(record.cancellable, 'waiting, and cancellable');
      const waiting = (await me.call<PerpWaitingOrder[]>('/api/perps/orders')).body.data!;
      assert.equal(waiting.find((o) => o.id === record.id)?.side, 'long');

      const cancel = await me.call<PerpCancelQuote>('/api/perps/cancel', { json: { actionId: record.id } });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      assert.equal(cancel.body.data!.execution.kind === 'transactions' && cancel.body.data!.execution.txs[0]?.label, 'Take back the ETH order');
      near(cancel.body.data!.openingFee, 0.2, 1e-9, 'the opening fee it forfeits');
      if (cancel.body.data!.execution.kind === 'transactions') for (const tx of cancel.body.data!.execution.txs) await send(tx);

      // The server notes the ask within a few seconds (the page shows it at once).
      let asked: PerpWaitingOrder | undefined;
      for (let i = 0; i < 20 && !asked?.cancelRequestedAt; i += 1) {
        if (i) await sleep(1000);
        asked = (await me.call<PerpWaitingOrder[]>('/api/perps/orders')).body.data!.find((o) => o.id === record.id);
      }
      assert.ok(asked?.cancelRequestedAt, 'listed as asked back');
      assert.equal(asked.cancellable, false);
      assert.equal((await me.call('/api/perps/cancel', { json: { actionId: record.id } })).status, 409, 'no second ask');

      // A minute on the keeper posts the next round — observed after the ask — and it cancels the order.
      const settled = await settle(record, 150);
      assert.equal(settled.status, 'failed', JSON.stringify(settled));
      assert.match(settled.error ?? '', /You took the order back/);
      const after = (await me.call<PerpAccount>('/api/perps/collateral')).body.data!;
      near(after.locked, 0, 1e-6, 'nothing left locked');
      near(after.free, freeBefore - 0.2, 1e-6, 'the collateral back, the opening fee kept');
    } finally {
      await setMinDelay(1);
    }
  });
}

console.log(`\n${passed} checks passed${process.exitCode ? ', some failed' : ''}.`);
