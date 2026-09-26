import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { network } from 'hardhat';
import { encodeAbiParameters, keccak256, maxUint256, parseEventLogs, parseUnits, toBytes, type Hex } from 'viem';

/**
 * AgriFeed + AgriVault + AgriPerp against Pyth's MockPyth. Orders are
 * two-step: requested — only on a fresh price, pushed with the request — then
 * executed at the first Pyth price published at least `minExecutionDelay`
 * after the request (MockPyth enforces the same uniqueness check as Pyth:
 * prevPublishTime < min ≤ publishTime), or cancelled once past their deadline.
 *
 * Covers the lifecycle, the guards, funding, liquidation, announced rolls and
 * splits, delisting, the pool reserve and profit cap — the attacks from both
 * security reviews, which must fail — and, after every step that moves money,
 * the vault's solvency invariant.
 */

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner, alice, bob, keeper, mallory] = await viem.getWalletClients();

const ETH = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace' as Hex;
const CFZ6 = '0xa61c21c0ca93300f50f231b52f59e9a6f47a07d33e78c1a9b8f84bd5928a3e8f' as Hex;
const CFH7 = '0x6d2ae51093c677632d215bc74b37314e61994e5dd8ec311372f468617dd30299' as Hex;
const NVDA = '0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593' as Hex;
const ETH_MARKET = keccak256(toBytes('ETH'));
const COFF_MARKET = keccak256(toBytes('COFF'));
const NVDA_MARKET = keccak256(toBytes('NVDA'));
/** The contract's defaults: fill at the first print 3 s after the request, within 60 s; filled within 20 s of that print or cancelled. */
const MIN_DELAY = 3n;
const FILL_WINDOW = 20n;
const DEADLINE = 60n + FILL_WINDOW;
/** Market struct fields, as the `markets` getter returns them. */
const LONG_OI = 7;
const SHORT_OI = 8;

const usd = (x: number | string) => parseUnits(String(x), 6);
const px = (x: number | string) => parseUnits(String(x), 18);

const PRICE = {
  type: 'tuple',
  components: [
    { name: 'price', type: 'int64' },
    { name: 'conf', type: 'uint64' },
    { name: 'expo', type: 'int32' },
    { name: 'publishTime', type: 'uint256' },
  ],
} as const;
const PRICE_FEED = {
  type: 'tuple',
  components: [{ name: 'id', type: 'bytes32' }, { name: 'price', ...PRICE }, { name: 'emaPrice', ...PRICE }],
} as const;

/** MockPyth's update format — the same encoding the app's `mock` oracle mode produces. */
function mockUpdate(id: Hex, price: bigint, expo: number, publishTime: bigint, opts: { conf?: bigint; prev?: bigint } = {}): Hex {
  const p = { price, conf: opts.conf ?? 0n, expo, publishTime };
  return encodeAbiParameters([PRICE_FEED, { type: 'uint64' }], [{ id, price: p, emaPrice: p }, opts.prev ?? publishTime - 1n]);
}

type Opts = { conf?: bigint; prev?: bigint };
const eth = (usdPrice: number, t: bigint, opts: Opts = {}) => mockUpdate(ETH, BigInt(Math.round(usdPrice * 1e8)), -8, t, opts);
/** Coffee in US cents, 2 decimals — Pyth's quote for CFZ6/CFH7. */
const coffee = (feed: Hex, cents: number, t: bigint, opts: Opts = {}) => mockUpdate(feed, BigInt(Math.round(cents * 100)), -2, t, opts);
/** A US stock, 5 decimals like Pyth's equity feeds. */
const nvda = (usdPrice: number, t: bigint, opts: Opts = {}) => mockUpdate(NVDA, BigInt(Math.round(usdPrice * 1e5)), -5, t, opts);

/** A price update published at `t`. */
type Quote = (t: bigint) => Hex;
/** What each market is trading at unless a test says otherwise — pushed with every request. */
const QUOTE: Record<string, Quote> = {
  ETH: (t) => eth(3000, t),
  COFF: (t) => coffee(CFZ6, 350, t),
  NVDA: (t) => nvda(1000, t),
};
const SYMBOL: Record<Hex, string> = { [ETH_MARKET]: 'ETH', [COFF_MARKET]: 'COFF', [NVDA_MARKET]: 'NVDA' };

async function now(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest());
}

/** Pins the next block's timestamp, so a price "published now" is exactly as old as the block that reads it. */
async function nextBlockAt(): Promise<bigint> {
  const t = (await now()) + 1n;
  await networkHelpers.time.setNextBlockTimestamp(t);
  return t;
}

async function deploy() {
  const pyth = await viem.deployContract('MockPyth', [60n, 1n]);
  const usdc = await viem.deployContract('MockUSDC');
  const feed = await viem.deployContract('AgriFeed', [pyth.address, owner.account.address]);
  const vault = await viem.deployContract('AgriVault', [usdc.address, owner.account.address]);
  const perp = await viem.deployContract('AgriPerp', [vault.address, feed.address, owner.account.address]);
  await vault.write.setPerp([perp.address]);

  await feed.write.listFeed(['ETH', ETH, 0, 200]);
  await feed.write.listFeed(['COFF', CFZ6, -2, 300]);
  await feed.write.listFeed(['NVDA', NVDA, 0, 200]);
  await perp.write.listMarket(['ETH', 50, usd(1_000_000), 0n]);
  await perp.write.listMarket(['COFF', 5, usd(1_000_000), 0n]);
  await perp.write.listMarket(['NVDA', 5, usd(1_000_000), 0n]);

  await usdc.write.mint([owner.account.address, usd(1_000_000)]);
  await usdc.write.approve([vault.address, maxUint256]);
  await vault.write.addLiquidity([usd(1_000_000)]);

  for (const w of [alice, bob, keeper, mallory]) {
    await usdc.write.mint([w.account.address, usd(20_000)]);
    await usdc.write.approve([vault.address, maxUint256], { account: w.account });
  }
  return { pyth, usdc, feed, vault, perp };
}

type Fixture = Awaited<ReturnType<typeof deploy>>;
type Wallet = typeof alice;
type Order = { orderId: bigint; requestedAt: bigint };

/** The vault's balance covers everything it owes, and the pool covers its reserve. */
async function assertSolvent({ usdc, vault }: Fixture): Promise<void> {
  const balance = await usdc.read.balanceOf([vault.address]);
  let owed = (await vault.read.poolBalance()) + (await vault.read.protocolFees());
  for (const w of [alice, bob, keeper, mallory]) {
    owed += (await vault.read.freeCollateral([w.account.address])) + (await vault.read.lockedCollateral([w.account.address]));
  }
  assert.equal(balance, owed, 'vault balance equals free + locked + pool + fees');
  assert.ok((await vault.read.poolBalance()) >= (await vault.read.reservedLiquidity()), 'pool covers its reserve');
}

async function mined(hash: Promise<Hex>) {
  return publicClient.waitForTransactionReceipt({ hash: await hash });
}

function requested(f: Fixture, receipt: Awaited<ReturnType<typeof mined>>): Order {
  const [ev] = parseEventLogs({ abi: f.perp.abi, logs: receipt.logs, eventName: 'OrderRequested' });
  assert.ok(ev);
  return { orderId: ev.args.orderId, requestedAt: BigInt(ev.args.requestedAt) };
}

/** Requests an open with a fresh price for the market pushed alongside (`quote: null` pushes none). */
async function requestOpen(
  f: Fixture,
  who: Wallet,
  o: {
    symbol?: string;
    isLong: boolean;
    collateral: number;
    leverage: number;
    acceptable?: bigint;
    deposit?: number;
    maxFeeBps?: bigint;
    fee?: bigint;
    quote?: Quote | null;
  },
): Promise<Order> {
  const symbol = o.symbol ?? 'ETH';
  const t = await nextBlockAt();
  const quote = o.quote === undefined ? QUOTE[symbol] : o.quote;
  const data = quote ? [quote(t)] : [];
  const receipt = await mined(
    f.perp.write.requestOpen(
      [symbol, o.isLong, usd(o.collateral), BigInt(o.leverage), o.acceptable ?? (o.isLong ? maxUint256 : 0n), o.maxFeeBps ?? 10n, usd(o.deposit ?? 0), data],
      { account: who.account, value: BigInt(data.length) + (o.fee ?? 0n) },
    ),
  );
  return requested(f, receipt);
}

async function requestClose(f: Fixture, who: Wallet, positionId: bigint, o: { acceptable?: bigint; fee?: bigint; quote?: Quote } = {}) {
  const p = await f.perp.read.getPosition([positionId]);
  const t = await nextBlockAt();
  const quote = o.quote ?? QUOTE[SYMBOL[p.market]!]!;
  const receipt = await mined(
    f.perp.write.requestClose([positionId, o.acceptable ?? (p.isLong ? 0n : maxUint256), [quote(t)]], {
      account: who.account,
      value: 1n + (o.fee ?? 0n),
    }),
  );
  return requested(f, receipt);
}

/** A keeper executes with the first print after the request's delay. */
async function executeAt(f: Fixture, order: Order, quote: Quote, by: Wallet = keeper) {
  await networkHelpers.time.increase(Number(MIN_DELAY));
  return mined(f.perp.write.executeOrder([order.orderId, [quote(order.requestedAt + MIN_DELAY)]], { account: by.account, value: 1n }));
}

const executeEth = (f: Fixture, order: Order, usdPrice: number, by: Wallet = keeper) => executeAt(f, order, (t) => eth(usdPrice, t), by);

async function openEth(f: Fixture, who: Wallet, isLong: boolean, collateral: number, leverage: number, price: number, deposit = 0) {
  const order = await requestOpen(f, who, { isLong, collateral, leverage, deposit });
  await executeEth(f, order, price);
  const o = await f.perp.read.getOrder([order.orderId]);
  assert.equal(o.status, 2, 'executed');
  return o.positionId;
}

async function closeEth(f: Fixture, who: Wallet, positionId: bigint, price: number) {
  const order = await requestClose(f, who, positionId);
  await executeEth(f, order, price);
  return f.perp.read.getOrder([order.orderId]);
}

/** Push a fresh ETH price on chain and liquidate on it. */
async function liquidateEth(f: Fixture, ids: bigint[], usdPrice: number) {
  const t = await nextBlockAt();
  return mined(f.perp.write.liquidate(['ETH', ids, [eth(usdPrice, t)]], { account: keeper.account, value: 1n }));
}

function cancelReason(f: Fixture, receipt: Awaited<ReturnType<typeof mined>>) {
  const [ev] = parseEventLogs({ abi: f.perp.abi, logs: receipt.logs, eventName: 'OrderCancelled' });
  return ev?.args.reason;
}

async function ethDelta(who: Wallet, run: () => Promise<Awaited<ReturnType<typeof mined>>>): Promise<bigint> {
  const before = await publicClient.getBalance({ address: who.account.address });
  const receipt = await run();
  const after = await publicClient.getBalance({ address: who.account.address });
  return after - before + receipt.gasUsed * receipt.effectiveGasPrice;
}

describe('AgriPerp', () => {
  it('a request escrows collateral + fee and reserves pool and open interest; execution opens the position', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 1_000, leverage: 10, deposit: 5_000 });
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(5_000 - 1_010));
    assert.equal(await f.vault.read.lockedCollateral([alice.account.address]), usd(1_010));
    assert.equal(await f.vault.read.reservedLiquidity(), usd(9_000));
    assert.equal(await f.vault.read.protocolFees(), 0n, 'fee only taken when it fills');
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[LONG_OI], usd(10_000), 'open interest held from the request');

    await executeEth(f, order, 3000.5);
    const o = await f.perp.read.getOrder([order.orderId]);
    const p = await f.perp.read.getPosition([o.positionId]);
    assert.equal(p.size, usd(10_000));
    assert.equal(p.entryPrice, px('3000.5'));
    assert.equal(p.reserve, usd(9_000));
    assert.equal(p.liquidationThresholdBps, 8_000);
    assert.equal(await f.vault.read.lockedCollateral([alice.account.address]), usd(1_000));
    assert.equal(await f.vault.read.protocolFees(), usd(10));
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[LONG_OI], usd(10_000));
    await assertSolvent(f);
  });

  it('closes a long in profit: collateral + PnL − close fee, paid by the pool', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 1_000, 10, 3000, 5_000);
    const pool = await f.vault.read.poolBalance();
    const o = await closeEth(f, alice, id, 3300);
    assert.equal(o.status, 2);
    assert.equal((await f.perp.read.getPosition([id])).status, 2, 'closed');
    // +10% on 10,000 of size = +1,000; the 0.1% close fee is 10.
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(5_000 - 10 + 1_000 - 10));
    assert.equal(await f.vault.read.poolBalance(), pool - usd(1_000));
    assert.equal(await f.vault.read.protocolFees(), usd(20));
    assert.equal(await f.vault.read.reservedLiquidity(), 0n);
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[LONG_OI], 0n);
    await assertSolvent(f);
  });

  it('closes a short at a loss: the loss goes to the pool', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, bob, false, 500, 4, 3000, 2_000);
    const pool = await f.vault.read.poolBalance();
    await closeEth(f, bob, id, 3150);
    // +5% against a 2,000 short = −100; fees 2 + 2.
    assert.equal(await f.vault.read.freeCollateral([bob.account.address]), usd(2_000 - 2 - 100 - 2));
    assert.equal(await f.vault.read.poolBalance(), pool + usd(100));
    await assertSolvent(f);
  });

  it('SECURITY: the settlement price is fixed by the request — no picking a favourable print', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 50, deposit: 1_100 });
    await networkHelpers.time.increase(10);
    const t = order.requestedAt;
    // A print from before the request (the one the trader could see) is refused…
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, [eth(3000, t - 20n)]], { account: mallory.account, value: 1n }),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );
    // …and so is any later print that isn't the first one after the delay.
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, [eth(3000, t + 5n, { prev: t + 4n })]], { account: mallory.account, value: 1n }),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );
    // Only the first print at or after request + delay settles it.
    await mined(f.perp.write.executeOrder([order.orderId, [eth(3000, t + MIN_DELAY)]], { account: keeper.account, value: 1n }));
    assert.equal((await f.perp.read.getOrder([order.orderId])).status, 2);
  });

  it('SECURITY: the review’s same-block open-then-close no longer extracts anything', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const pool = await f.vault.read.poolBalance();
    // Mallory wants to open on an old 3000 print and close on a newer 3030 one.
    const open = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 50, deposit: 1_100 });
    // The open settles on the first print after its own request: 3030, not 3000.
    await executeEth(f, open, 3030);
    const id = (await f.perp.read.getOrder([open.orderId])).positionId;
    // The close settles on the first print after the close request, whatever it is.
    await closeEth(f, mallory, id, 3030);
    assert.ok((await f.vault.read.freeCollateral([mallory.account.address])) < usd(1_100), 'lost the fees, gained nothing');
    assert.ok((await f.vault.read.poolBalance()) >= pool, 'the pool lost nothing');
    await assertSolvent(f);
  });

  it('SECURITY: a closed market takes no orders — a request needs a fresh price', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 1_000, 2, 3000, 1_100);
    // The market shuts for the night: no new prints.
    await networkHelpers.time.increase(3_600);
    await f.vault.write.deposit([usd(500)], { account: bob.account });
    const open = (data: Hex[]) =>
      f.perp.write.requestOpen(['ETH', true, usd(100), 2n, maxUint256, 10n, 0n, data], { account: bob.account, value: BigInt(data.length) });
    await viem.assertions.revertWithCustomError(open([]), f.feed, 'StalePrice');
    // The evening's last print, pushed now, is still too old to trade on — so an
    // order can't sit through the closure and fill on Monday's gap.
    await viem.assertions.revertWithCustomError(open([eth(3000, (await now()) - 1_800n)]), f.feed, 'StalePrice');
    await viem.assertions.revertWithCustomError(f.perp.write.requestClose([id, 0n, []], { account: alice.account }), f.feed, 'StalePrice');
    // Too little for the Pyth fee.
    await viem.assertions.revertWithCustomError(
      f.perp.write.requestOpen(['ETH', true, usd(100), 2n, maxUint256, 10n, 0n, [eth(3000, await nextBlockAt())]], { account: bob.account }),
      f.perp,
      'InsufficientOracleFee',
    );
    // The market reopens: both go through.
    await requestOpen(f, bob, { isLong: true, collateral: 100, leverage: 2 });
    await requestClose(f, alice, id);
    await assertSolvent(f);
  });

  it('SECURITY: where the chain’s clock runs behind, an order still only fills after the price its request carried', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    // The chain is 20 s behind Pyth: the request carries a price published 20 s after its block.
    const t = await nextBlockAt();
    const order = requested(
      f,
      await mined(
        f.perp.write.requestOpen(['ETH', true, usd(100), 5n, maxUint256, 10n, usd(200), [eth(3000, t + 20n)]], {
          account: mallory.account,
          value: 1n,
        }),
      ),
    );
    assert.equal(order.requestedAt, t + 20n, 'the request is as late as its price');
    await networkHelpers.time.increase(30);
    // A print from 3 s after the block — one Mallory had already seen when she sent it — is refused.
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, [eth(2900, t + 3n)]], { account: mallory.account, value: 1n }),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );
    await mined(f.perp.write.executeOrder([order.orderId, [eth(3000, t + 20n + MIN_DELAY)]], { account: keeper.account, value: 1n }));
    assert.equal((await f.perp.read.getOrder([order.orderId])).status, 2);
  });

  it('an order whose price breaks its bound is cancelled and refunded; the executor is still paid', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await f.vault.write.deposit([usd(1_000)], { account: alice.account });
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, acceptable: px(3015), fee: 1_000_000n });
    assert.equal((await f.perp.read.getOrder([order.orderId])).executionFee, 1_000_000n, 'what was sent less the Pyth fee');
    let receipt!: Awaited<ReturnType<typeof mined>>;
    const earned = await ethDelta(keeper, async () => (receipt = await executeEth(f, order, 3100)));
    assert.equal(cancelReason(f, receipt), 'price past limit');
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(1_000));
    assert.equal(await f.vault.read.reservedLiquidity(), 0n);
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[LONG_OI], 0n, 'open interest released');
    // The keeper paid the 1-wei Pyth fee and received the 1,000,000 wei execution fee.
    assert.equal(earned, 1_000_000n - 1n);
    await assertSolvent(f);
  });

  it('prices with too wide a confidence interval neither take an order nor settle one', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const wide = { conf: 90_00000000n };
    await viem.assertions.revertWithCustomError(
      requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 200, quote: (t) => eth(3000, t, wide) }),
      f.feed,
      'ConfidenceTooWide',
    );
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 200 });
    await networkHelpers.time.increase(3);
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, [eth(3000, order.requestedAt + MIN_DELAY, wide)]], { account: keeper.account, value: 1n }),
      f.feed,
      'ConfidenceTooWide',
    );
    assert.equal((await f.perp.read.getOrder([order.orderId])).status, 1, 'still pending');
  });

  it('charges exactly the Pyth fee and refunds the change; too little is refused', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 200 });
    await networkHelpers.time.increase(3);
    const data = [eth(3000, order.requestedAt + MIN_DELAY)];
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, data], { account: keeper.account, value: 0n }),
      f.perp,
      'InsufficientOracleFee',
    );
    const pythBefore = await publicClient.getBalance({ address: f.pyth.address });
    await mined(f.perp.write.executeOrder([order.orderId, data], { account: keeper.account, value: 1_000_000n }));
    assert.equal((await publicClient.getBalance({ address: f.pyth.address })) - pythBefore, 1n, 'one update, one wei');
    assert.equal(await publicClient.getBalance({ address: f.perp.address }), 0n, 'nothing left in AgriPerp');
  });

  it('only free collateral can be withdrawn — escrowed and locked collateral stay', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await openEth(f, alice, true, 1_000, 2, 3000, 1_500);
    await requestOpen(f, alice, { isLong: false, collateral: 200, leverage: 2 });
    const free = await f.vault.read.freeCollateral([alice.account.address]);
    assert.equal(free, usd(1_500 - 1_002 - 200.4));
    await viem.assertions.revertWithCustomError(f.vault.write.withdraw([free + 1n], { account: alice.account }), f.vault, 'InsufficientFreeCollateral');
    await f.vault.write.withdraw([free], { account: alice.account });
    assert.equal(await f.vault.read.lockedCollateral([alice.account.address]), usd(1_000 + 200.4));
    await assertSolvent(f);
  });

  it('liquidates at 80% loss, not before; the liquidator keeps 10% of what is left', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, false, 1_000, 10, 3000, 1_010);
    await liquidateEth(f, [id], 3239);
    assert.equal((await f.perp.read.getPosition([id])).status, 1, 'an 8% rise less a dollar: still open');
    const pool = await f.vault.read.poolBalance();
    await liquidateEth(f, [id], 3241);
    assert.equal((await f.perp.read.getPosition([id])).status, 3, 'liquidated');
    const loss = (usd(10_000) * (px(3241) - px(3000))) / px(3000);
    const remaining = usd(1_000) - loss;
    const reward = remaining / 10n;
    assert.equal(await f.vault.read.freeCollateral([keeper.account.address]), reward);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), remaining - reward);
    assert.equal(await f.vault.read.poolBalance(), pool + loss);
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[SHORT_OI], 0n);
    await assertSolvent(f);
  });

  it('a position past zero equity is still worth liquidating (reward floor), and loses only its collateral', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 1_000, 50, 3000, 1_050);
    const pool = await f.vault.read.poolBalance();
    await liquidateEth(f, [id], 2700);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), 0n);
    assert.equal(await f.vault.read.freeCollateral([keeper.account.address]), usd(5), '0.5% of collateral');
    assert.equal(await f.vault.read.poolBalance(), pool + usd(995));
    await assertSolvent(f);
  });

  it('liquidation settles on the latest price only: an old wick is refused', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 1_000, 10, 3000, 1_010);
    const t = await now();
    await networkHelpers.time.increase(60);
    await viem.assertions.revertWithCustomError(
      f.perp.write.liquidate(['ETH', [id], [eth(2750, t)]], { account: keeper.account, value: 1n }),
      f.feed,
      'StalePrice',
    );
    assert.equal((await f.perp.read.getPosition([id])).status, 1);
  });

  it('a price stamped ahead of the chain’s clock counts as fresh — re-pushing one can’t dodge a liquidation', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 1_000, 10, 3000, 1_010);
    // ETH falls 10%. Alice, underwater, pushes the newest print — from 20 s ahead of the chain's clock.
    const t = await nextBlockAt();
    await mined(f.pyth.write.updatePriceFeeds([[eth(2700, t + 20n)]], { account: alice.account, value: 1n }));
    // The keeper's own push is older and isn't stored; the stored one is fresh, not "stale from the future".
    await liquidateEth(f, [id], 2700);
    assert.equal((await f.perp.read.getPosition([id])).status, 3);
    await assertSolvent(f);
  });

  it('batch liquidation takes what it can and skips the rest (healthy, closed, another market)', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const underwater = await openEth(f, alice, true, 500, 20, 3000, 1_000);
    const healthy = await openEth(f, bob, true, 500, 2, 3000, 1_000);
    const coffeeOrder = await requestOpen(f, bob, { symbol: 'COFF', isLong: true, collateral: 100, leverage: 5 });
    await executeAt(f, coffeeOrder, (t) => coffee(CFZ6, 350, t));
    const coffeeId = (await f.perp.read.getOrder([coffeeOrder.orderId])).positionId;

    await liquidateEth(f, [underwater, healthy, coffeeId, 999n, underwater], 2800);
    assert.equal((await f.perp.read.getPosition([underwater])).status, 3);
    assert.equal((await f.perp.read.getPosition([healthy])).status, 1);
    assert.equal((await f.perp.read.getPosition([coffeeId])).status, 1);
    await assertSolvent(f);
  });

  it('accrues funding per second: longs pay, shorts receive, never retroactively', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await f.perp.write.setFundingRate([ETH_MARKET, px('0.0001')]); // 0.01% per hour, the cap
    const long = await openEth(f, alice, true, 1_000, 10, 3000, 2_000);
    const short = await openEth(f, bob, false, 1_000, 10, 3000, 2_000);
    await networkHelpers.time.increase(10 * 3600);
    await closeEth(f, alice, long, 3000);
    await closeEth(f, bob, short, 3000);
    const paid = usd(2_000 - 20) - (await f.vault.read.freeCollateral([alice.account.address]));
    const received = (await f.vault.read.freeCollateral([bob.account.address])) - usd(2_000 - 20);
    // ~10 hours × 0.01% × 10,000 = ~10 USDC each way.
    assert.ok(paid >= usd(10) && paid < usd('10.02'), `long paid ${paid}`);
    assert.ok(received >= usd(10) && received < usd('10.02'), `short received ${received}`);
    await viem.assertions.revertWithCustomError(f.perp.write.setFundingRate([ETH_MARKET, px('0.0002')]), f.perp, 'InvalidParam');
    await assertSolvent(f);
  });

  it('rolls: announced a day ahead, executed by anyone on the first prints after, PnL continuous', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const buy = await requestOpen(f, alice, { symbol: 'COFF', isLong: true, collateral: 100, leverage: 5, deposit: 200 });
    await executeAt(f, buy, (t) => coffee(CFZ6, 350, t));
    const id = (await f.perp.read.getOrder([buy.orderId])).positionId;
    assert.equal((await f.perp.read.getPosition([id])).entryPrice, px('3.5'), '350¢ = $3.50/lb');

    await viem.assertions.revertWithCustomError(f.feed.write.scheduleRoll(['COFF', CFH7, (await now()) + 3600n]), f.feed, 'InvalidParam');
    const notBefore = (await now()) + 86_400n + 10n;
    await f.feed.write.scheduleRoll(['COFF', CFH7, notBefore]);
    const both = (t: bigint, dec: number, mar: number, prev?: bigint) => [coffee(CFZ6, dec, t, { prev }), coffee(CFH7, mar, t, { prev })];
    await viem.assertions.revertWithCustomError(
      f.feed.write.executeRoll(['COFF', both(notBefore, 360, 350)], { account: keeper.account, value: 2n }),
      f.feed,
      'RollNotDue',
    );
    await networkHelpers.time.increaseTo(notBefore + 5n);
    // Not the first prints after the roll time: refused.
    await viem.assertions.revertWithCustomError(
      f.feed.write.executeRoll(['COFF', both(notBefore + 3n, 360, 350, notBefore + 2n)], { account: mallory.account, value: 2n }),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );
    // Dec at 360¢, Mar at 350¢: a 10¢ spread the position must not "earn". Anyone can carry it out
    // with the first prints at or after the roll time (previous prints before it).
    await mined(f.feed.write.executeRoll(['COFF', both(notBefore, 360, 350)], { account: keeper.account, value: 2n }));
    const [feedId, factor] = await f.feed.read.feedOf([COFF_MARKET]);
    assert.equal(feedId, CFH7);
    assert.equal(factor, (px(1) * 360n) / 350n);

    // March rises to 367¢, and the position closes there.
    const before = await f.vault.read.freeCollateral([alice.account.address]);
    const sell = await requestClose(f, alice, id, { quote: (t) => coffee(CFH7, 365, t) });
    await executeAt(f, sell, (t) => coffee(CFH7, 367, t));
    const pnl = (await f.vault.read.freeCollateral([alice.account.address])) - before - usd(100) + usd('0.5');
    // (360/350) × (367/350) − 1 = +7.853% on 500 of size ≈ +39.27.
    assert.ok(pnl > usd('39.26') && pnl < usd('39.28'), `pnl ${pnl}`);
    await assertSolvent(f);
  });

  it('rolls refuse prices far apart or a jump beyond 25%, and lapse if not carried out within the hour', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const notBefore = (await now()) + 86_400n + 10n;
    await f.feed.write.scheduleRoll(['COFF', CFH7, notBefore]);
    await networkHelpers.time.increaseTo(notBefore + 30n);
    await viem.assertions.revertWithCustomError(
      f.feed.write.executeRoll(['COFF', [coffee(CFZ6, 360, notBefore), coffee(CFH7, 350, notBefore + 20n, { prev: notBefore - 1n })]], { value: 2n }),
      f.feed,
      'RollPricesApart',
    );
    await viem.assertions.revertWithCustomError(
      f.feed.write.executeRoll(['COFF', [coffee(CFZ6, 360, notBefore), coffee(CFH7, 250, notBefore)]], { value: 2n }),
      f.feed,
      'RollOutOfBounds',
    );
    await networkHelpers.time.increaseTo(notBefore + 3_601n);
    await viem.assertions.revertWithCustomError(
      f.feed.write.executeRoll(['COFF', [coffee(CFZ6, 360, notBefore), coffee(CFH7, 350, notBefore)]], { value: 2n }),
      f.feed,
      'RollExpired',
    );
  });

  it('an order’s bound holds in index terms across a roll', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const notBefore = (await now()) + 86_400n + 10n;
    await f.feed.write.scheduleRoll(['COFF', CFH7, notBefore]);
    await networkHelpers.time.increaseTo(notBefore + 10n);
    // Bob shorts at 350¢ with a 1% bound (346.5¢)…
    const order = await requestOpen(f, bob, { symbol: 'COFF', isLong: false, collateral: 100, leverage: 5, acceptable: px('3.465'), deposit: 200 });
    // …a roll from Dec 350 to Mar 360 lands first, then Mar prints 352 (index −2.2%).
    await mined(f.feed.write.executeRoll(['COFF', [coffee(CFZ6, 350, notBefore), coffee(CFH7, 360, notBefore)]], { value: 2n }));
    const receipt = await executeAt(f, order, (t) => coffee(CFH7, 352, t));
    assert.equal(cancelReason(f, receipt), 'price past limit', 'filled past its bound before the fix');
  });

  it('SECURITY: a stock split moves nobody’s PnL — prices from it on are rebased, whichever side of it an order falls', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    // Alice is long NVDA at $1,000, 5× on 1,000.
    const long = await requestOpen(f, alice, { symbol: 'NVDA', isLong: true, collateral: 1_000, leverage: 5, deposit: 2_000 });
    await executeAt(f, long, (t) => nvda(1000, t));
    const id = (await f.perp.read.getOrder([long.orderId])).positionId;

    // A 10-for-1 split, announced a day ahead, effective between the last price before it and the first after.
    await viem.assertions.revertWithCustomError(f.feed.write.scheduleRebase(['NVDA', px(10), (await now()) + 3_600n]), f.feed, 'InvalidParam');
    await viem.assertions.revertWithCustomError(
      f.feed.write.scheduleRebase(['NVDA', px(10), (await now()) + 90_000n], { account: mallory.account }),
      f.feed,
      'OwnableUnauthorizedAccount',
    );
    const effectiveAt = (await now()) + 86_400n + 100n;
    await f.feed.write.scheduleRebase(['NVDA', px(10), effectiveAt]);
    await viem.assertions.revertWithCustomError(f.feed.write.scheduleRoll(['NVDA', CFH7, effectiveAt + 86_400n]), f.feed, 'AdjustmentPending');
    // With less than a day to go it can't be called off: a genuine split isn't dropped at the last moment.
    await networkHelpers.time.increaseTo(effectiveAt - 3_600n);
    await viem.assertions.revertWithCustomError(f.feed.write.cancelRebase([NVDA_MARKET]), f.feed, 'RebaseLocked');

    // Bob shorts just before it: requested on a $1,000 print, filled on the first print after — a post-split $100.20.
    await networkHelpers.time.increaseTo(effectiveAt - 2n);
    const short = await requestOpen(f, bob, { symbol: 'NVDA', isLong: false, collateral: 1_000, leverage: 5, deposit: 2_000, acceptable: px(990) });
    assert.equal(short.requestedAt, effectiveAt - 1n);
    const firstAfter = nvda(100.2, effectiveAt + 2n, { prev: effectiveAt - 1n });
    await networkHelpers.time.increase(3);
    // Until the split is checked against the prices, a price from after it settles nothing…
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([short.orderId, [firstAfter]], { account: keeper.account, value: 1n }),
      f.feed,
      'RebaseNotActive',
    );
    await viem.assertions.revertWithCustomError(
      f.feed.write.activateRebase(['NVDA', [nvda(1000, effectiveAt - 1n)], [firstAfter]], { account: mallory.account, value: 1n }),
      f.feed,
      'InsufficientOracleFee',
    );
    // …and anyone can check it: $100.20 × 10 is within 0.8–1.25× of the $1,000 before.
    await mined(f.feed.write.activateRebase(['NVDA', [nvda(1000, effectiveAt - 1n)], [firstAfter]], { account: mallory.account, value: 2n }));
    await mined(f.perp.write.executeOrder([short.orderId, [firstAfter]], { account: keeper.account, value: 1n }));
    const shortId = (await f.perp.read.getOrder([short.orderId])).positionId;
    assert.ok(shortId > 0n, 'filled: $100.20 after a 10-for-1 split is $1,002 before it');
    assert.equal((await f.perp.read.getPosition([shortId])).entryIndex, px(1002));

    // Alice's long is up 0.2%, not down 90% (and Bob's short isn't up 90%).
    const [pnl, , , liquidatable] = await f.perp.read.positionState([id]);
    assert.equal(pnl, usd(10));
    assert.equal(liquidatable, false);

    // An order after the split quotes a post-split price; its bound converts at the split ratio.
    const buy = await requestOpen(f, mallory, { symbol: 'NVDA', isLong: true, collateral: 100, leverage: 2, deposit: 300, acceptable: px(101), quote: (t) => nvda(100.2, t) });
    await executeAt(f, buy, (t) => nvda(100.5, t));
    assert.equal((await f.perp.read.getOrder([buy.orderId])).status, 2);

    // Once active it can't be called off; a day later anyone folds it into the roll factor, and nothing moves.
    await viem.assertions.revertWithCustomError(f.feed.write.cancelRebase([NVDA_MARKET]), f.feed, 'RebaseLocked');
    await viem.assertions.revertWithCustomError(f.feed.write.finalizeRebase(['NVDA']), f.feed, 'RebaseNotSettled');
    const [, indexBefore] = await f.feed.read.readUnsafe([NVDA_MARKET]);
    await networkHelpers.time.increaseTo(effectiveAt + 86_400n);
    await mined(f.feed.write.finalizeRebase(['NVDA'], { account: mallory.account }));
    assert.equal((await f.feed.read.feedOf([NVDA_MARKET]))[1], px(10));
    assert.equal((await f.feed.read.readUnsafe([NVDA_MARKET]))[1], indexBefore);

    // Both close at $100.50 = $1,005 before the split: the long +0.5%, the short −0.3%.
    const at1005 = (t: bigint) => nvda(100.5, t);
    await executeAt(f, await requestClose(f, alice, id, { quote: at1005 }), at1005);
    await executeAt(f, await requestClose(f, bob, shortId, { quote: at1005 }), at1005);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(2_000 - 5 + 25 - 5));
    assert.equal(await f.vault.read.freeCollateral([bob.account.address]), usd(2_000 - 5 - 5) - (usd(5_000) * 3n) / 1002n);
    await assertSolvent(f);
  });

  it('SECURITY: a split the prices don’t bear out never applies — a wrong ratio moves nobody’s PnL', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, bob, false, 1_000, 2, 3000, 1_100);
    // A "split" of ETH, a thousandfold: the review's owner-override scenario.
    const effectiveAt = (await now()) + 86_400n + 100n;
    await f.feed.write.scheduleRebase(['ETH', px(1000), effectiveAt]);
    await networkHelpers.time.increaseTo(effectiveAt + 10n);
    await viem.assertions.revertWithCustomError(
      f.feed.write.activateRebase(['ETH', [eth(3000, effectiveAt - 60n)], [eth(3000, effectiveAt + 5n, { prev: effectiveAt - 1n })]], { value: 2n }),
      f.feed,
      'RebaseOutOfBounds',
    );
    // Unchecked, prices from its time on settle nothing: no liquidation at a thousandfold "price".
    await viem.assertions.revertWithCustomError(liquidateEth(f, [id], 3000), f.feed, 'RebaseNotActive');
    assert.equal((await f.perp.read.getPosition([id])).status, 1);
    // A day after its time it can be called off, and prices count as they are again.
    await viem.assertions.revertWithCustomError(f.feed.write.cancelRebase([ETH_MARKET]), f.feed, 'RebaseLocked');
    await networkHelpers.time.increaseTo(effectiveAt + 86_400n + 1n);
    await f.feed.write.cancelRebase([ETH_MARKET]);
    await closeEth(f, bob, id, 3000);
    assert.equal(await f.vault.read.freeCollateral([bob.account.address]), usd(1_100 - 2 - 2));
    await assertSolvent(f);
  });

  it('a split whose market never prices again is never folded in; delisting settles at the price before it', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const long = await requestOpen(f, alice, { symbol: 'NVDA', isLong: true, collateral: 1_000, leverage: 5, deposit: 2_000 });
    await executeAt(f, long, (t) => nvda(1000, t));
    const id = (await f.perp.read.getOrder([long.orderId])).positionId;
    const effectiveAt = (await now()) + 86_400n + 100n;
    await f.feed.write.scheduleRebase(['NVDA', px(10), effectiveAt]);
    // The stock is halted and never trades again: no price after the split, so it never activates.
    await networkHelpers.time.increaseTo(effectiveAt + 8n * 86_400n);
    await viem.assertions.revertWithCustomError(f.feed.write.finalizeRebase(['NVDA']), f.feed, 'RebaseNotActive');
    await f.perp.write.delistMarket(['NVDA']);
    assert.equal((await f.perp.read.markets([NVDA_MARKET]))[11], px(1000), 'settles on the last price, unadjusted');
    await mined(f.perp.write.settleDelisted([[id]]));
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(2_000 - 5));
    await assertSolvent(f);
  });

  it('a scheduled split can be called off before it applies', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const effectiveAt = (await now()) + 86_400n + 100n;
    await f.feed.write.scheduleRebase(['NVDA', px('0.5'), effectiveAt]);
    await f.feed.write.cancelRebase([NVDA_MARKET]);
    await viem.assertions.revertWithCustomError(f.feed.write.cancelRebase([NVDA_MARKET]), f.feed, 'NoRebaseScheduled');
    await networkHelpers.time.increaseTo(effectiveAt + 10n);
    await f.pyth.write.updatePriceFeeds([[nvda(1000, effectiveAt + 5n)]], { value: 1n });
    assert.equal((await f.feed.read.readUnsafe([NVDA_MARKET]))[1], px(1000));
    await viem.assertions.revertWithCustomError(f.feed.write.scheduleRebase(['NVDA', px(1), effectiveAt + 86_400n]), f.feed, 'InvalidParam');
  });

  it('caps profit at min(9× collateral, size) and never promises more than the pool holds', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 100, 50, 3000, 200);
    await closeEth(f, alice, id, 6000);
    // +100% on 5,000 would be +5,000; the cap is 900. Fees 5 + 5.
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(200 - 5 + 900 - 5));

    // At 1× the reserve is the size, not 9× the collateral (the review's cheap lock-up).
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 10_000, leverage: 1, deposit: 10_100 });
    assert.equal((await f.perp.read.getOrder([order.orderId])).reserve, usd(10_000));

    const available = await f.vault.read.availableLiquidity();
    await f.vault.write.removeLiquidity([available - usd(5_000), owner.account.address]);
    await f.vault.write.deposit([usd(1_100)], { account: bob.account });
    await viem.assertions.revertWithCustomError(
      requestOpen(f, bob, { isLong: true, collateral: 1_000, leverage: 10 }),
      f.vault,
      'InsufficientPoolLiquidity',
    );
    await viem.assertions.revertWithCustomError(f.vault.write.removeLiquidity([usd(5_001), owner.account.address]), f.vault, 'InsufficientPoolLiquidity');
    await assertSolvent(f);
  });

  it('enforces leverage, minimum collateral, the fee the trader agreed to, and the open-interest cap — at the request', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await f.vault.write.deposit([usd(5_000)], { account: alice.account });
    const req = (symbol: string, collateral: number, leverage: number, maxFeeBps = 10n) =>
      requestOpen(f, alice, { symbol, isLong: true, collateral, leverage, maxFeeBps });
    await viem.assertions.revertWithCustomError(req('ETH', 100, 51), f.perp, 'InvalidLeverage');
    await viem.assertions.revertWithCustomError(req('NVDA', 100, 6), f.perp, 'InvalidLeverage');
    await viem.assertions.revertWithCustomError(req('ETH', 0.5, 2), f.perp, 'CollateralTooSmall');
    await f.perp.write.setFees([30n, 10n]);
    await viem.assertions.revertWithCustomError(req('ETH', 100, 2), f.perp, 'FeeAboveMax');
    await f.perp.write.setFees([10n, 10n]);

    // Pending opens count against the cap until they fill or are cancelled.
    await f.perp.write.setMarket([ETH_MARKET, true, 50, usd(5_000)]);
    await viem.assertions.revertWithCustomError(req('ETH', 1_000, 10), f.perp, 'OpenInterestCapReached');
    const first = await req('ETH', 400, 10);
    await viem.assertions.revertWithCustomError(req('ETH', 200, 10), f.perp, 'OpenInterestCapReached');
    await networkHelpers.time.increase(Number(DEADLINE) + 1);
    await mined(f.perp.write.cancelOrder([first.orderId], { account: bob.account }));
    const second = await req('ETH', 200, 10);

    // Pausing stops new orders; one already requested still fills on its own terms.
    await f.perp.write.setMarket([ETH_MARKET, false, 50, usd(1_000_000)]);
    await viem.assertions.revertWithCustomError(req('ETH', 100, 2), f.perp, 'MarketDisabled');
    await executeEth(f, second, 3000);
    assert.equal((await f.perp.read.getOrder([second.orderId])).status, 2);
    await assertSolvent(f);
  });

  it('parameter changes never reach an order in flight or an open position', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: false, collateral: 1_000, leverage: 10, deposit: 1_100 });
    await f.perp.write.setExecution([10n, 120n, 5n, 30n, 0n]);
    await f.perp.write.setLiquidation([5_000n, 2_500n, 500n]);
    await f.perp.write.setFees([100n, 100n]);
    // It still fills at the first print 3 s after its request, not 10.
    await executeEth(f, order, 3000);
    const id = (await f.perp.read.getOrder([order.orderId])).positionId;
    assert.equal((await f.perp.read.getPosition([id])).liquidationThresholdBps, 8_000);
    // At the new 50% threshold a 6% move would liquidate it; at its own 80% it doesn't.
    await liquidateEth(f, [id], 3180);
    assert.equal((await f.perp.read.getPosition([id])).status, 1);

    // A new order waits the new 10 s.
    const next = await requestOpen(f, bob, { isLong: true, collateral: 100, leverage: 2, deposit: 300, maxFeeBps: 100n });
    await networkHelpers.time.increase(12);
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([next.orderId, [eth(3000, next.requestedAt + MIN_DELAY)]], { account: keeper.account, value: 1n }),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );
    await mined(f.perp.write.executeOrder([next.orderId, [eth(3000, next.requestedAt + 10n)]], { account: keeper.account, value: 1n }));

    // Its own 0.1% fees (10 + 10), not the new 1%.
    await f.perp.write.setExecution([MIN_DELAY, 60n, 5n, 30n, 0n]);
    await closeEth(f, alice, id, 3000);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(1_100 - 10 - 10));
    await assertSolvent(f);
  });

  it('SECURITY: an order fills within 20 s of its price or not at all — nobody holds it as an option', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 50, deposit: 1_100, fee: 5_000n });
    // The keeper is slow and ETH rallies. Half a minute after her fill price, Mallory tries to fill it herself.
    await networkHelpers.time.increase(30);
    let receipt!: Awaited<ReturnType<typeof mined>>;
    const earned = await ethDelta(mallory, async () =>
      (receipt = await mined(
        f.perp.write.executeOrder([order.orderId, [eth(3000, order.requestedAt + MIN_DELAY)]], { account: mallory.account, value: 1n }),
      )),
    );
    assert.equal(cancelReason(f, receipt), 'expired');
    assert.equal(await f.vault.read.freeCollateral([mallory.account.address]), usd(1_100), 'nothing opened');
    assert.equal(earned, 5_000n - 1n, 'only her own execution fee back, less the Pyth fee');
    assert.ok(order.requestedAt + MIN_DELAY + FILL_WINDOW < order.requestedAt + DEADLINE);
    await assertSolvent(f);
  });

  it('an order not executed in time only cancels — anyone can, and earns its execution fee', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 300, fee: 5_000n });
    assert.equal(await f.perp.read.orderDeadline([order.orderId]), order.requestedAt + DEADLINE);
    await viem.assertions.revertWithCustomError(f.perp.write.cancelOrder([order.orderId], { account: alice.account }), f.perp, 'TooEarlyToCancel');

    // Past the deadline even the price that would have settled it only cancels it — nobody holds an option on it.
    await networkHelpers.time.increaseTo(order.requestedAt + DEADLINE + 1n);
    let receipt!: Awaited<ReturnType<typeof mined>>;
    const earned = await ethDelta(mallory, async () =>
      (receipt = await mined(
        f.perp.write.executeOrder([order.orderId, [eth(3000, order.requestedAt + MIN_DELAY)]], { account: mallory.account, value: 1n }),
      )),
    );
    assert.equal(cancelReason(f, receipt), 'expired');
    assert.equal(earned, 5_000n, 'the fee, and the unused Pyth fee back');
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(300));
    assert.equal(await f.vault.read.reservedLiquidity(), 0n);
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[LONG_OI], 0n);

    const second = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, fee: 7_000n });
    await networkHelpers.time.increase(Number(DEADLINE) + 1);
    assert.equal(await ethDelta(bob, () => mined(f.perp.write.cancelOrder([second.orderId], { account: bob.account }))), 7_000n);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(300));
    await viem.assertions.revertWithCustomError(f.perp.write.executeOrder([second.orderId, []], { account: keeper.account }), f.perp, 'OrderNotPending');
    await viem.assertions.revertWithCustomError(f.perp.write.cancelOrder([second.orderId]), f.perp, 'OrderNotPending');
    await assertSolvent(f);
  });

  it('a market whose price stops for a week is delisted and settled at its last price — nothing stays stuck', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const buy = await requestOpen(f, alice, { symbol: 'COFF', isLong: true, collateral: 100, leverage: 5, deposit: 200 });
    await executeAt(f, buy, (t) => coffee(CFZ6, 350, t));
    const id = (await f.perp.read.getOrder([buy.orderId])).positionId;
    // The last print before the contract month dies: 364¢.
    const stuck = await requestOpen(f, bob, { symbol: 'COFF', isLong: false, collateral: 100, leverage: 5, deposit: 200, fee: 3_000n, quote: (t) => coffee(CFZ6, 364, t) });

    await viem.assertions.revertWithCustomError(f.perp.write.delistMarket(['COFF']), f.perp, 'NotDelistable');
    await networkHelpers.time.increase(7 * 86_400);
    await viem.assertions.revertWithCustomError(f.perp.write.delistMarket(['COFF'], { account: mallory.account }), f.perp, 'OwnableUnauthorizedAccount');
    await f.perp.write.delistMarket(['COFF']);
    const m = await f.perp.read.markets([COFF_MARKET]);
    assert.equal(m[2], true, 'delisted');
    assert.equal(m[10], px('3.64'), 'settlement price');

    await viem.assertions.revertWithCustomError(req(), f.perp, 'MarketDisabled');
    await viem.assertions.revertWithCustomError(f.perp.write.requestClose([id, 0n, []], { account: alice.account }), f.perp, 'MarketIsDelisted');
    await viem.assertions.revertWithCustomError(f.perp.write.liquidate(['COFF', [id], []]), f.perp, 'MarketIsDelisted');
    await viem.assertions.revertWithCustomError(f.perp.write.setMarket([COFF_MARKET, true, 5, usd(1)]), f.perp, 'MarketIsDelisted');

    // Anyone settles: +4% on 500 = +20, and no close fee.
    await mined(f.perp.write.settleDelisted([[id, 999n]], { account: mallory.account }));
    assert.equal((await f.perp.read.getPosition([id])).status, 2);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(200 - 0.5 + 20));
    await mined(f.perp.write.settleDelisted([[id]]));
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(200 - 0.5 + 20), 'settles once');

    // Bob's order that never filled: cancellable by anyone, collateral back.
    const receipt = await mined(f.perp.write.cancelOrder([stuck.orderId], { account: mallory.account }));
    assert.equal(cancelReason(f, receipt), 'market delisted');
    assert.equal(await f.vault.read.freeCollateral([bob.account.address]), usd(200));
    assert.equal((await f.perp.read.markets([COFF_MARKET]))[LONG_OI], 0n);
    assert.equal((await f.perp.read.markets([COFF_MARKET]))[SHORT_OI], 0n);
    await assertSolvent(f);

    function req() {
      return requestOpen(f, alice, { symbol: 'COFF', isLong: true, collateral: 10, leverage: 2 });
    }
  });

  it('only the trader closes; one close at a time; owner powers are bounded', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 100, 2, 3000, 200);
    await viem.assertions.revertWithCustomError(f.perp.write.requestClose([id, 0n, []], { account: bob.account }), f.perp, 'NotPositionOwner');
    await requestClose(f, alice, id);
    await viem.assertions.revertWithCustomError(f.perp.write.requestClose([id, 0n, []], { account: alice.account }), f.perp, 'CloseAlreadyPending');
    await viem.assertions.revertWithCustomError(f.perp.write.setFundingRate([ETH_MARKET, 1n], { account: bob.account }), f.perp, 'OwnableUnauthorizedAccount');
    await viem.assertions.revertWithCustomError(f.perp.write.setFees([101n, 10n]), f.perp, 'InvalidParam');
    await viem.assertions.revertWithCustomError(f.perp.write.setLiquidation([9_600n, 1_000n, 50n]), f.perp, 'InvalidParam');
    for (const bad of [
      [1n, 60n, 5n, 30n, 0n],
      [3n, 7n, 5n, 30n, 0n],
      [3n, 60n, 16n, 30n, 0n],
      [3n, 60n, 5n, 121n, 0n],
      [3n, 60n, 5n, 30n, px('0.02')],
    ] as const) {
      await viem.assertions.revertWithCustomError(f.perp.write.setExecution([...bad]), f.perp, 'InvalidParam');
    }
    await viem.assertions.revertWithCustomError(f.vault.write.setPerp([bob.account.address]), f.vault, 'PerpAlreadySet');
    await viem.assertions.revertWithCustomError(f.vault.write.lock([alice.account.address, 1n, 0n], { account: bob.account }), f.vault, 'NotPerp');
    await viem.assertions.revertWithCustomError(f.feed.write.listFeed(['ETH', ETH, 0, 200]), f.feed, 'AlreadyListed');
    await viem.assertions.revertWithCustomError(f.feed.write.setMaxConf([ETH_MARKET, 501]), f.feed, 'InvalidParam');
  });

  it('keeps the vault solvent through a mixed sequence', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const a = await openEth(f, alice, true, 700, 7, 3000, 3_000);
    const b = await openEth(f, bob, false, 900, 3, 3010, 3_000);
    const c = await openEth(f, alice, false, 400, 25, 2990);
    const pending = await requestOpen(f, bob, { isLong: true, collateral: 300, leverage: 4 });
    await assertSolvent(f);
    await closeEth(f, alice, a, 3120);
    await assertSolvent(f);
    await liquidateEth(f, [c], 3200);
    await assertSolvent(f);
    await executeEth(f, pending, 3190);
    await closeEth(f, bob, b, 3190);
    await assertSolvent(f);
    await f.vault.write.withdraw([await f.vault.read.freeCollateral([alice.account.address])], { account: alice.account });
    await f.vault.write.collectFees([owner.account.address]);
    await assertSolvent(f);
  });

  it('reads USD from US-cent feeds and marks positions for views', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await f.pyth.write.updatePriceFeeds([[coffee(CFZ6, 412.35, (await now()) + 1n)]], { value: 1n });
    const [price, index] = await f.feed.read.readUnsafe([COFF_MARKET]);
    assert.equal(price, px('4.1235'));
    assert.equal(index, price);

    const id = await openEth(f, alice, true, 100, 10, 3000, 200);
    await f.pyth.write.updatePriceFeeds([[eth(2850, (await now()) + 100n)]], { value: 1n });
    const [pnl, , equity, liquidatable] = await f.perp.read.positionState([id]);
    assert.equal(pnl, -usd(50));
    assert.equal(equity, usd(50));
    assert.equal(liquidatable, false);
  });
});
