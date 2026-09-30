/**
 * End-to-end check of perps on a second network (Multichain brief), over
 * HTTP: the chain switcher's list, Base's own markets beside Robinhood
 * Chain's, a real SIWE sign-in, real transactions on "Base", and the worker
 * doing its part there (the mock oracle, executing orders, mirroring events,
 * liquidating) while Robinhood Chain runs on paper beside it.
 *
 *   BASE_URL=http://localhost:3100 RC_DATA_DIR=<same as the servers> <the servers' BASE_* env> npx tsx scripts/e2e-multichain.mts
 *
 * Setup (contracts/):
 *   npx hardhat node --chain-id 84532 --port 8546                       a local chain standing in for Base Sepolia
 *   ALLOW_MOCK_FEEDS=true ALLOW_MOCK_USDC=true SEED_LIQUIDITY_USDC=1000000 KEEPER_ADDRESS=<Hardhat #1> \
 *     npx hardhat run scripts/deploy.ts --network baseLocal             gold and silver on MockAggregators
 *   KEEPER_ADDRESS=<Hardhat #1> npx hardhat run scripts/deploy-reported-feeds.ts --network baseLocal
 * Servers (web on :3100 and worker), both with an isolated store — never a real database:
 *   RC_ENV=dev DATABASE_URL= POSTGRES_URL= RC_DATA_DIR=<scratch> FEATURE_PERPS=true PERPS_VENUE=paper
 *   PERPS_PRICE_INTERVAL_MS=600000 KEEPER_PRIVATE_KEY=<Hardhat #1>
 *   BASE_RPC_URL=http://127.0.0.1:8546 BASE_CHAIN_ID=84532 BASE_AGRI_*_ADDRESS=<the deploy's> BASE_AGRI_DEPLOY_BLOCK=0
 *   BASE_PERPS_ORACLE=mock BASE_REPORTED_FEEDS=<deploy-reported-feeds.ts's line>
 *
 * The trader is Hardhat account #2, the owner #0 — public test keys, local chains only.
 */
import assert from 'node:assert/strict';

import type {
  PerpAccount,
  PerpActionRecord,
  PerpChainInfo,
  PerpCloseQuote,
  PerpMarket,
  PerpOpenQuote,
  PerpPosition,
  PerpVenueInfo,
  SessionInfo,
  TxRequest,
} from '@robinchan/shared';
import { perpMarket } from '@robinchan/shared';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const ORIGIN = new URL(BASE).origin;
const RPC = process.env.BASE_RPC_URL ?? 'http://127.0.0.1:8546';
const CHAIN_ID = Number(process.env.BASE_CHAIN_ID ?? 84532);
/** The primary network's chain, which SIWE signs in on: the dev stand-in when none is configured. */
const PRIMARY_CHAIN_ID = Number(process.env.E2E_PRIMARY_CHAIN_ID ?? 421614);
const HARDHAT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HARDHAT_2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

if (!process.env.RC_DATA_DIR) throw new Error('Set RC_DATA_DIR to the servers’ data directory (this script moves prices there).');
if (!process.env.BASE_AGRI_FEED_ADDRESS || !process.env.BASE_AGRI_PERP_ADDRESS) throw new Error('Set the servers’ BASE_* environment here too.');
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';
const core = await import('../packages/core/src/index');
const FEED = process.env.BASE_AGRI_FEED_ADDRESS as Address;
const PERP = process.env.BASE_AGRI_PERP_ADDRESS as Address;

type Res<T> = { status: number; body: { data?: T; error?: { code: string; message: string; field?: string } } };

class Client {
  cookie = '';
  constructor(readonly account: PrivateKeyAccount | null) {}

  async call<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<Res<T>> {
    for (;;) {
      const res = await fetch(`${BASE}${path}`, {
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(init.json !== undefined ? { 'content-type': 'application/json', origin: ORIGIN } : {}),
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie?.startsWith('rc_session=')) {
        const value = setCookie.split(';')[0] as string;
        this.cookie = value === 'rc_session=' ? '' : value;
      }
      const body = (await res.json().catch(() => ({}))) as Res<T>['body'];
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
      chainId: PRIMARY_CHAIN_ID,
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

const chain = defineChain({ id: CHAIN_ID, name: 'Base (local)', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const trader = privateKeyToAccount(HARDHAT_2);
const wallet = createWalletClient({ account: trader, chain, transport: http(RPC) });
const owner = createWalletClient({ account: privateKeyToAccount(HARDHAT_0), chain, transport: http(RPC) });
const reader = createPublicClient({ chain, transport: http(RPC) });
const me = new Client(trader);
const anon = new Client(null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Base's routes: `?chain=base` on every path. */
const b = (path: string) => `${path}${path.includes('?') ? '&' : '?'}chain=base`;

/**
 * A price into Base's cache, as if Chainlink had published it `ageSec` ago;
 * then wait for the worker's mock oracle to post it into the local feed,
 * where the contract reads it.
 */
async function setPrice(symbol: string, usd: number, ageSec = 0): Promise<void> {
  const publishTime = Math.floor(Date.now() / 1000) - ageSec;
  const feed = perpMarket(symbol, 'base')!.contracts[0]!.feedId;
  await core.withPerpNetwork('base', () =>
    core.writeFeedPrices([{ symbol, feed, price: usd, publishTime, roundId: String(publishTime), source: 'fixture' }]),
  );
  const market = keccak256(toBytes(symbol));
  for (let i = 0; i < 40; i += 1) {
    const [price] = await reader.readContract({ address: FEED, abi: core.AGRI_FEED_ABI, functionName: 'readUnsafe', args: [market] });
    if (Math.abs(Number(price) / 1e18 - usd) < 1e-6) return;
    await sleep(500);
  }
  throw new Error(`the local ${symbol} feed never showed ${usd}`);
}

async function send(tx: TxRequest): Promise<Hex> {
  assert.equal(tx.chainId, CHAIN_ID, `${tx.label} is for chain ${tx.chainId}, not Base`);
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${tx.label} reverted`);
  return hash;
}

async function submit(quote: { id: string; execution: PerpOpenQuote['execution'] }): Promise<PerpActionRecord> {
  assert.equal(quote.execution.kind, 'transactions', 'Base has no paper venue');
  if (quote.execution.kind !== 'transactions') throw new Error('unreachable');
  let record: PerpActionRecord | undefined;
  for (const [step, tx] of quote.execution.txs.entries()) {
    const hash = await send(tx);
    const res = await me.call<PerpActionRecord>(b('/api/perps/record'), { json: { actionId: quote.id, txHash: hash, step } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    record = res.body.data;
  }
  return record!;
}

async function settle(record: PerpActionRecord, seconds = 60): Promise<PerpActionRecord> {
  let r = record;
  for (let i = 0; i < seconds / 1.5 && r.status === 'pending'; i += 1) {
    await sleep(1500);
    r = (await me.call<PerpActionRecord>(b(`/api/perps/actions/${r.id}`))).body.data!;
  }
  return r;
}

const sign = async (quote: { id: string; execution: PerpOpenQuote['execution'] }) => settle(await submit(quote));
const positions = async (onBase = true) => (await me.call<PerpPosition[]>(onBase ? b('/api/perps/positions') : '/api/perps/positions')).body.data ?? [];

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

console.log(`Multichain E2E against ${BASE}; Base on chain ${CHAIN_ID} at ${RPC}`);

console.log('Networks');
await check('the switcher lists RH Chain and Base, each with its chain and venue; Arbitrum is off', async () => {
  const chains = (await anon.call<PerpChainInfo[]>('/api/perps/chains')).body.data!;
  assert.deepEqual(chains.map((c) => c.network), ['robinhood', 'base']);
  const base = chains[1]!;
  assert.equal(base.chainId, CHAIN_ID);
  assert.equal(base.venue, 'agri-perp');
  assert.equal(base.testnet, true);
  assert.equal(base.collateralSymbol, 'USDC');
  assert.deepEqual(base.features, { rhTokens: false, gap: false });
  assert.equal(chains[0]!.venue, 'paper');
  const arb = await anon.call('/api/perps/markets?chain=arbitrum');
  assert.equal(arb.status, 404);
  assert.equal(arb.body.error?.code, 'NOT_CONFIGURED');
  assert.equal((await anon.call('/api/perps/markets?chain=solana')).status, 400);
});
await check('/perps renders on each network (an unknown one falls back to RH Chain)', async () => {
  for (const q of ['?chain=base', '?chain=base&symbol=XAU', '?chain=base&symbol=BTC', '?chain=arbitrum', '']) {
    const res = await fetch(`${BASE}/perps${q}`);
    assert.equal(res.status, 200, `/perps${q}: ${res.status}`);
  }
});

console.log('Base’s markets');
await check('corn, soybeans, wheat and coffee, then gold and silver — none of RH Chain’s', async () => {
  await setPrice('XAU', 4000);
  const markets = (await anon.call<PerpMarket[]>(b('/api/perps/markets'))).body.data!;
  assert.deepEqual(markets.map((m) => m.symbol), ['CORN', 'SOYB', 'WEAT', 'COFF', 'XAU', 'XAG']);
  assert.deepEqual([...new Set(markets.map((m) => m.category))], ['agri', 'commodities']);
  const xau = markets.find((m) => m.symbol === 'XAU')!;
  assert.equal(xau.status, 'open', xau.statusNote ?? '');
  near(xau.price as number, 4000, 1e-9, 'XAU');
  assert.equal(xau.contract, 'Chainlink XAU / USD');
  assert.equal(xau.maxLeverage, 5);
  assert.equal(xau.maxPositionUsd, 50_000);
  const primary = (await anon.call<PerpMarket[]>('/api/perps/markets')).body.data!;
  assert.equal(primary.some((m) => m.symbol === 'XAU'), false, 'gold isn’t on RH Chain');
  assert.equal(primary.some((m) => m.symbol === 'BTC'), true);
  assert.equal((await anon.call(b('/api/perps/stats/BTC'))).status, 404);
  assert.equal((await anon.call(b('/api/perps/candles/XAU?interval=1H'))).status, 200);
  assert.equal((await anon.call<{ price: number }>(b('/api/perps/price/XAU'))).body.data?.price, 4000);
});
await check('the venue card: Base’s contracts, its USDC and pool, its feeds', async () => {
  const venue = (await anon.call<PerpVenueInfo>(b('/api/perps/venue'))).body.data!;
  assert.equal(venue.network, 'base');
  assert.equal(venue.venue, 'agri-perp');
  assert.equal(venue.chain?.id, CHAIN_ID);
  assert.equal(venue.chain?.mainnet, false);
  assert.equal(venue.contracts?.perp.toLowerCase(), PERP.toLowerCase());
  // The deploy's seed, give or take what earlier runs' trades moved.
  assert.ok(venue.pool && Math.abs(venue.pool.balance - 1_000_000) < 10_000, `pool ${venue.pool?.balance}`);
  // Gold and silver from the deploy; the agri markets once list-agri-markets.ts has listed them.
  const feeds = venue.feeds.map((f) => f.symbol);
  assert.ok(feeds.includes('XAU') && feeds.includes('XAG'), feeds.join(' '));
  assert.ok(feeds.every((s) => ['XAU', 'XAG', 'CORN', 'SOYB', 'WEAT', 'COFF'].includes(s)), feeds.join(' '));
  assert.equal((await anon.call<PerpVenueInfo>('/api/perps/venue')).body.data?.network, 'robinhood');
});

console.log('A trade on Base');
await check('sign in once, on RH Chain’s chain id', async () => {
  const res = await me.signIn();
  assert.equal(res.status, 200, JSON.stringify(res.body));
});
await check('test USDC on Base: a mint the wallet sends there, then a deposit into Base’s vault', async () => {
  const before = (await me.call<PerpAccount>(b('/api/perps/collateral'))).body.data!;
  const faucet = await me.call<{ kind: string; txs?: TxRequest[] }>(b('/api/perps/faucet'), { json: {} });
  assert.equal(faucet.status, 200, JSON.stringify(faucet.body));
  assert.equal(faucet.body.data?.kind, 'transactions');
  for (const tx of faucet.body.data!.txs!) await send(tx);
  const deposit = await me.call<{ id: string; execution: PerpOpenQuote['execution'] }>(b('/api/perps/collateral'), { json: { kind: 'deposit', amount: 2_000 } });
  assert.equal(deposit.status, 200, JSON.stringify(deposit.body));
  const done = await sign(deposit.body.data!);
  assert.equal(done.status, 'done', done.error ?? '');
  const account = (await me.call<PerpAccount>(b('/api/perps/collateral'))).body.data!;
  assert.equal(account.venue, 'agri-perp');
  near(account.free - before.free, 2_000, 1e-6, 'deposited into Base’s vault');
  near((account.walletUsdc as number) - (before.walletUsdc ?? 0), 8_000, 1e-6, '10,000 minted, 2,000 of it deposited');
  const paper = (await me.call<PerpAccount>('/api/perps/collateral')).body.data!;
  assert.equal(paper.venue, 'paper');
  near(paper.free, 0, 1e-9, 'RH Chain’s paper account is untouched');
});
let positionId = '';
let openActionId = '';
await check('open long gold 5×: quote → approve-free request on chain 84532 → the keeper fills it at the next round', async () => {
  await setPrice('XAU', 4000);
  const q = await me.call<PerpOpenQuote>(b('/api/perps/quote'), { json: { action: 'open', symbol: 'XAU', side: 'long', collateral: 1_000, leverage: 5 } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const quote = q.body.data!;
  assert.equal(quote.size, 5_000);
  near(quote.liquidationPrice, 4000 * (1 - 0.8 / 5), 1e-6, 'liquidation price');
  assert.ok(quote.execution.kind === 'transactions' && quote.execution.txs.every((t) => t.chainId === CHAIN_ID), 'every transaction on Base');
  assert.ok(quote.warnings.some((w) => /Chainlink's next XAU price/.test(w)), quote.warnings.join(' | '));
  openActionId = quote.id;
  const record = await sign(quote);
  assert.equal(record.status, 'done', record.error ?? '');
  const [p] = await positions();
  assert.ok(p, 'listed on Base');
  positionId = p.id;
  assert.equal(p.symbol, 'XAU');
  assert.equal(p.category, 'commodities');
  assert.ok(p.chainPositionId, 'mirrored from Base’s contract');
  near(p.entryPrice, 4000, 1e-6, 'entry');
  assert.equal((await positions(false)).length, 0, 'not on RH Chain');
});
await check('an order of Base’s, asked for on RH Chain: told where it is', async () => {
  const res = await me.call(`/api/perps/actions/${openActionId}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error?.message ?? '', /on Base/);
});
await check('marked to Base’s price: +5% at 5× is +25%', async () => {
  await setPrice('XAU', 4200);
  const [p] = await positions();
  near(p!.unrealizedPnl as number, 250, 1e-3, 'unrealized PnL');
  near(p!.pnlPct as number, 25, 1e-3, 'PnL %');
});
await check('close: request → filled → paid back into Base’s vault', async () => {
  const q = await me.call<PerpCloseQuote>(b('/api/perps/quote'), { json: { action: 'close', positionId } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  near(q.body.data!.estPayout, 1_245, 1e-3, 'collateral + PnL − 0.1% close fee');
  const record = await sign(q.body.data!);
  assert.equal(record.status, 'done', record.error ?? '');
  assert.equal((await positions()).length, 0);
  const closed = (await me.call<PerpPosition[]>(b('/api/perps/history'))).body.data!.find((h) => h.id === positionId);
  assert.equal(closed?.status, 'closed');
  near(closed!.realizedPnl as number, 245, 1e-3, 'realized PnL');
  assert.equal((await me.call<PerpPosition[]>('/api/perps/history')).body.data!.length, 0, 'RH Chain’s history is its own');
});

console.log('Refusals on Base');
await check('RH Chain’s markets, past 5×, past $50k a position', async () => {
  const quote = (body: object) => me.call(b('/api/perps/quote'), { json: { action: 'open', ...body } });
  assert.equal((await quote({ symbol: 'BTC', side: 'long', collateral: 10, leverage: 2 })).body.error?.code, 'NOT_FOUND');
  assert.equal((await quote({ symbol: 'PONS', side: 'long', collateral: 10, leverage: 2 })).body.error?.code, 'NOT_FOUND');
  const tooMuch = await quote({ symbol: 'XAU', side: 'long', collateral: 10, leverage: 6 });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error?.message ?? '', /up to 5×/);
  const tooBig = await quote({ symbol: 'XAU', side: 'long', collateral: 10_001, leverage: 5 });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.body.error?.message ?? '', /\$50,000/);
});

console.log('Liquidation on Base');
await check('a 5× long past 80% loss (a 16% drop) is liquidated by Base’s keeper', async () => {
  await setPrice('XAU', 4000);
  const q = await me.call<PerpOpenQuote>(b('/api/perps/quote'), { json: { action: 'open', symbol: 'XAU', side: 'long', collateral: 200, leverage: 5 } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const opened = await sign(q.body.data!);
  assert.equal(opened.status, 'done', opened.error ?? '');
  let liquidated: PerpPosition | undefined;
  for (let i = 0; i < 30 && !liquidated; i += 1) {
    await setPrice('XAU', 4000 * 0.83);
    await sleep(1500);
    liquidated = (await me.call<PerpPosition[]>(b('/api/perps/history'))).body.data!.find((h) => h.status === 'liquidated');
  }
  assert.ok(liquidated, 'liquidated within ~45s');
  // Loss 170 of 200 → 30 left; the liquidator keeps 10% → the trader gets 27.
  near(liquidated.payout as number, 27, 0.05, 'payout after liquidation');
});

console.log('Agri on Base (the operator’s feed)');
await check('corn: the keeper posts Yahoo Finance’s quote to Base’s feed; listed, it shows that price', async () => {
  const cornFeed = JSON.parse(process.env.BASE_REPORTED_FEEDS ?? '{}').CORN as Address | undefined;
  assert.ok(cornFeed, 'BASE_REPORTED_FEEDS names CORN');
  const rounds = await reader.readContract({ address: cornFeed, abi: core.REPORTED_ROUND_FEED_ABI, functionName: 'roundCount' });
  if (rounds === 0n) {
    console.log('    (no corn round yet: CBOT hasn’t printed within the last hour — the market shows as closed, as it should)');
    const corn = (await anon.call<PerpMarket[]>(b('/api/perps/markets?category=agri'))).body.data!.find((m) => m.symbol === 'CORN')!;
    assert.notEqual(corn.status, 'open');
    return;
  }
  const [, answer] = await reader.readContract({ address: cornFeed, abi: core.REPORTED_ROUND_FEED_ABI, functionName: 'latestRoundData' });
  const listed = await reader.readContract({ address: FEED, abi: core.AGRI_FEED_ABI, functionName: 'isListed', args: [keccak256(toBytes('CORN'))] });
  if (!listed) {
    console.log('    (corn has a round but isn’t listed: run list-agri-markets.ts --network baseLocal)');
    return;
  }
  // The worker's price read, as it runs on Base (PERPS_PRICE_INTERVAL_MS keeps the worker's own
  // runs apart here): with mock feeds, gold from Base's mainnet, corn from Base's own chain.
  const prices = await core.withPerpNetwork('base', () => core.readNetworkOraclePrices());
  const read = prices.find((p) => p.symbol === 'CORN');
  assert.ok(read, `corn read from its feed on Base (got ${prices.map((p) => p.symbol).join(' ')})`);
  near(read.price, Number(answer) / 1e8, 1e-9, 'CORN as read');
  assert.equal(read.feed.toLowerCase(), cornFeed.toLowerCase());
  await core.withPerpNetwork('base', () => core.writeFeedPrices([read]));
  let corn: PerpMarket | undefined;
  for (let i = 0; i < 20; i += 1) {
    corn = (await anon.call<PerpMarket[]>(b('/api/perps/markets?category=agri'))).body.data!.find((m) => m.symbol === 'CORN');
    if (corn?.price != null) break;
    await sleep(1000);
  }
  near(corn!.price as number, Number(answer) / 1e8, 1e-6, 'CORN on the page = the feed’s answer');
  assert.match(corn!.contract ?? '', /Robinchan-posted, from Yahoo Finance/);
  void owner;
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some failed' : ''}.`);
