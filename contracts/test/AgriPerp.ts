import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { network } from 'hardhat';
import { keccak256, maxUint256, parseEventLogs, parseUnits, toBytes, type Hex } from 'viem';

/**
 * AgriFeed + AgriVault + AgriPerp against Chainlink-style feeds
 * (MockAggregator numbers rounds like a Chainlink proxy, keeps when each
 * price was observed apart from when it landed, and models an aggregator
 * migration). Orders are two-step: requested while the feed is live, then
 * settled by the feed's first round observed after the request and landed
 * at least `minExecutionDelay` after it, in the phase it was requested in —
 * which AgriFeed proves from the rounds before it — however late that's
 * executed. Without such a round in the window, the order is released with
 * that proven; the trader can take one back (asked for, then released five
 * minutes on, forfeiting the opening fee).
 *
 * Covers the lifecycle, the guards, funding, liquidation, delisting, the
 * pool reserve and profit cap, the attacks from the security reviews, and,
 * after every step that moves money, the vault's solvency invariant.
 */

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner, alice, bob, keeper, mallory] = await viem.getWalletClients();

const ETH_MARKET = keccak256(toBytes('ETH'));
const NVDA_MARKET = keccak256(toBytes('NVDA'));
/** The contract's defaults: a round landed at least 1 s after the request, within 25 h. */
const MAX_DELAY = 90_000n;
/** A round counts as observed after a moment only from 2 s after it. */
const MARGIN = 2;
/** A trader's cancel releases the order this long after the ask. */
const CANCEL_DELAY = 300n;
/** Market struct fields, as the `markets` getter returns them. */
const LONG_OI = 7;
const SHORT_OI = 8;

const usd = (x: number | string) => parseUnits(String(x), 6);
const px = (x: number | string) => parseUnits(String(x), 18);
/** A Chainlink answer: 8 decimals. */
const answer = (x: number | string) => parseUnits(String(x), 8);

async function now(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest());
}

async function deploy() {
  const usdc = await viem.deployContract('MockUSDC');
  const ethFeed = await viem.deployContract('MockAggregator', [8, 'ETH / USD', answer(3000)]);
  const nvdaFeed = await viem.deployContract('MockAggregator', [8, 'RHNVDA / USD', answer(1000)]);
  const feed = await viem.deployContract('AgriFeed', [owner.account.address]);
  const vault = await viem.deployContract('AgriVault', [usdc.address, owner.account.address]);
  const perp = await viem.deployContract('AgriPerp', [vault.address, feed.address, owner.account.address]);
  await vault.write.setPerp([perp.address]);

  await feed.write.listFeed(['ETH', ethFeed.address]);
  await feed.write.listFeed(['NVDA', nvdaFeed.address]);
  await perp.write.listMarket(['ETH', 50, usd(1_000_000), 0n]);
  await perp.write.listMarket(['NVDA', 5, usd(1_000_000), 0n]);

  await usdc.write.mint([owner.account.address, usd(1_000_000)]);
  await usdc.write.approve([vault.address, maxUint256]);
  await vault.write.addLiquidity([usd(1_000_000)]);

  for (const w of [alice, bob, keeper, mallory]) {
    await usdc.write.mint([w.account.address, usd(20_000)]);
    await usdc.write.approve([vault.address, maxUint256], { account: w.account });
  }
  return { usdc, ethFeed, nvdaFeed, feed, vault, perp };
}

type Fixture = Awaited<ReturnType<typeof deploy>>;
type Wallet = typeof alice;
type Aggregator = Fixture['ethFeed'];
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

function cancelReason(f: Fixture, receipt: Awaited<ReturnType<typeof mined>>) {
  const [ev] = parseEventLogs({ abi: f.perp.abi, logs: receipt.logs, eventName: 'OrderCancelled' });
  return ev?.args.reason;
}

/** A new round on the feed, observed and published a couple of seconds from now. Returns its round id. */
async function publish(agg: Aggregator, usdPrice: number | string): Promise<bigint> {
  await networkHelpers.time.increase(MARGIN);
  await mined(agg.write.updateAnswer([answer(usdPrice)]));
  return (await agg.read.latestRoundData())[0];
}

/** A new round landing now whose price was observed at `observedAt` — a live feed's land ~13 s after. */
async function publishObserved(agg: Aggregator, usdPrice: number | string, observedAt: bigint): Promise<bigint> {
  await mined(agg.write.updateObserved([answer(usdPrice), observedAt]));
  return (await agg.read.latestRoundData())[0];
}

/** The trader asks for an order back, and it's released once the cancel delay has passed. */
async function takeBack(f: Fixture, who: Wallet, order: Order, by: Wallet = who) {
  await mined(f.perp.write.cancelOrder([order.orderId], { account: who.account }));
  await networkHelpers.time.increase(Number(CANCEL_DELAY));
  return mined(f.perp.write.cancelOrder([order.orderId], { account: by.account }));
}

async function requestOpen(
  f: Fixture,
  who: Wallet,
  o: { symbol?: string; isLong: boolean; collateral: number; leverage: number; acceptable?: bigint; deposit?: number; maxFeeBps?: bigint; fee?: bigint },
): Promise<Order> {
  const receipt = await mined(
    f.perp.write.requestOpen(
      [o.symbol ?? 'ETH', o.isLong, usd(o.collateral), BigInt(o.leverage), o.acceptable ?? (o.isLong ? maxUint256 : 0n), o.maxFeeBps ?? 10n, usd(o.deposit ?? 0)],
      { account: who.account, value: o.fee ?? 0n },
    ),
  );
  return requested(f, receipt);
}

async function requestClose(f: Fixture, who: Wallet, positionId: bigint, o: { acceptable?: bigint; fee?: bigint } = {}) {
  const p = await f.perp.read.getPosition([positionId]);
  const receipt = await mined(
    f.perp.write.requestClose([positionId, o.acceptable ?? (p.isLong ? 0n : maxUint256)], { account: who.account, value: o.fee ?? 0n }),
  );
  return requested(f, receipt);
}

/** The feed publishes the next round, and a keeper executes the order at it. */
async function executeAt(f: Fixture, order: Order, usdPrice: number, agg: Aggregator = f.ethFeed, by: Wallet = keeper) {
  const round = await publish(agg, usdPrice);
  return mined(f.perp.write.executeOrder([order.orderId, round], { account: by.account }));
}

async function openEth(f: Fixture, who: Wallet, isLong: boolean, collateral: number, leverage: number, price: number, deposit = 0) {
  const order = await requestOpen(f, who, { isLong, collateral, leverage, deposit });
  await executeAt(f, order, price);
  const o = await f.perp.read.getOrder([order.orderId]);
  assert.equal(o.status, 2, 'executed');
  return o.positionId;
}

async function closeEth(f: Fixture, who: Wallet, positionId: bigint, price: number) {
  const order = await requestClose(f, who, positionId);
  await executeAt(f, order, price);
  return f.perp.read.getOrder([order.orderId]);
}

/** The feed publishes a new ETH round, and the keeper liquidates on it. */
async function liquidateEth(f: Fixture, ids: bigint[], usdPrice: number) {
  await publish(f.ethFeed, usdPrice);
  return mined(f.perp.write.liquidate(['ETH', ids], { account: keeper.account }));
}

async function ethDelta(who: Wallet, run: () => Promise<Awaited<ReturnType<typeof mined>>>): Promise<bigint> {
  const before = await publicClient.getBalance({ address: who.account.address });
  const receipt = await run();
  const after = await publicClient.getBalance({ address: who.account.address });
  return after - before + receipt.gasUsed * receipt.effectiveGasPrice;
}

describe('AgriPerp on Chainlink feeds', () => {
  it('a request escrows collateral + fee and reserves pool and open interest; the next round opens the position', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 1_000, leverage: 10, deposit: 5_000 });
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(5_000 - 1_010));
    assert.equal(await f.vault.read.lockedCollateral([alice.account.address]), usd(1_010));
    assert.equal(await f.vault.read.reservedLiquidity(), usd(9_000));
    assert.equal(await f.vault.read.protocolFees(), 0n, 'fee only taken when it fills');
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[LONG_OI], usd(10_000), 'open interest held from the request');

    await executeAt(f, order, 3000.5);
    const o = await f.perp.read.getOrder([order.orderId]);
    const p = await f.perp.read.getPosition([o.positionId]);
    assert.equal(p.size, usd(10_000));
    assert.equal(p.entryPrice, px('3000.5'));
    assert.equal(p.entryIndex, px('3000.5'));
    assert.equal(p.reserve, usd(9_000));
    assert.equal(p.liquidationThresholdBps, 8_000);
    assert.equal(await f.vault.read.lockedCollateral([alice.account.address]), usd(1_000));
    assert.equal(await f.vault.read.protocolFees(), usd(10));
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

  it('SECURITY: only the first round after the request settles it — not the one the trader saw, not a later one', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const seen = (await f.ethFeed.read.latestRoundData())[0];
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 50, deposit: 1_100 });
    // The round published before the request — the price Mallory could see — is refused…
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, seen], { account: mallory.account }),
      f.feed,
      'RoundOutOfWindow',
    );
    const first = await publish(f.ethFeed, 2950);
    const second = await publish(f.ethFeed, 3100);
    // …and so is any later round: it isn't the first after the request.
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, second], { account: mallory.account }),
      f.feed,
      'NotFirstRound',
    );
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, second + 10n], { account: mallory.account }),
      f.feed,
      'RoundNotFound',
    );
    await mined(f.perp.write.executeOrder([order.orderId, first], { account: keeper.account }));
    const o = await f.perp.read.getOrder([order.orderId]);
    assert.equal((await f.perp.read.getPosition([o.positionId])).entryPrice, px(2950));
  });

  it('SECURITY: the feed’s lag can’t be traded — a request on a stale-looking price fills at the next round', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const pool = await f.vault.read.poolBalance();
    // The feed shows 3000; the market is already at 3014, just under the 0.5% deviation threshold.
    // Mallory goes long 50× expecting to buy at 3000 and sell at the next round.
    const open = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 50, deposit: 1_100 });
    // She buys at the next round — 3015 — not at the 3000 she saw.
    await executeAt(f, open, 3015);
    const id = (await f.perp.read.getOrder([open.orderId])).positionId;
    assert.equal((await f.perp.read.getPosition([id])).entryPrice, px(3015));
    await closeEth(f, mallory, id, 3015);
    assert.ok((await f.vault.read.freeCollateral([mallory.account.address])) < usd(1_100), 'lost the fees, gained nothing');
    assert.ok((await f.vault.read.poolBalance()) >= pool, 'the pool lost nothing');
    await assertSolvent(f);
  });

  it('SECURITY: a price already on its way when the order was placed doesn’t fill it — the next one does', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    // ETH jumps. Chainlink observes it; its round will land ~13 s later. Mallory, watching the
    // exchanges, goes long in between, hoping to fill at the price she already knows.
    const observed = (await now()) + 1n;
    await networkHelpers.time.increase(5);
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 20, deposit: 1_100 });
    assert.ok(order.requestedAt > observed);
    const inFlight = await publishObserved(f.ethFeed, 3015, observed);
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([order.orderId, inFlight], { account: mallory.account }),
      f.feed,
      'ObservedBeforeRequest',
    );
    // Her round is the next one observed after her request, landed after the one in flight.
    const next = await publish(f.ethFeed, 3040);
    await mined(f.perp.write.executeOrder([order.orderId, next], { account: keeper.account }));
    const id = (await f.perp.read.getOrder([order.orderId])).positionId;
    assert.equal((await f.perp.read.getPosition([id])).entryPrice, px(3040));
    await assertSolvent(f);
  });

  it('SECURITY: the first round observed after the request is the only one — even with observation times out of order', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 20, deposit: 1_100 });
    // A: observed just after the request. B: lands after A but was observed before the request
    // (clocks drift between oracle rounds). C: observed after both.
    await networkHelpers.time.increase(MARGIN);
    const a = await publishObserved(f.ethFeed, 3010, order.requestedAt + BigInt(MARGIN));
    const b = await publishObserved(f.ethFeed, 3020, order.requestedAt - 5n);
    const c = await publish(f.ethFeed, 3030);
    // C would be "first" if only the round before it were checked; the look-back finds A.
    await viem.assertions.revertWithCustomError(f.perp.write.executeOrder([order.orderId, c], { account: mallory.account }), f.feed, 'NotFirstRound');
    await viem.assertions.revertWithCustomError(f.perp.write.executeOrder([order.orderId, b], { account: mallory.account }), f.feed, 'ObservedBeforeRequest');
    await mined(f.perp.write.executeOrder([order.orderId, a], { account: keeper.account }));
    const id = (await f.perp.read.getOrder([order.orderId])).positionId;
    assert.equal((await f.perp.read.getPosition([id])).entryPrice, px(3010));
  });

  it('SECURITY: a price observed within 2 s of the request is treated as already on its way', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 100, leverage: 5, deposit: 200 });
    // Same second as the request, by the oracles' clock: it could have been known.
    const tooSoon = await publishObserved(f.ethFeed, 3001, order.requestedAt + 1n);
    await viem.assertions.revertWithCustomError(f.perp.write.executeOrder([order.orderId, tooSoon]), f.feed, 'ObservedBeforeRequest');
    const next = await publish(f.ethFeed, 3002);
    await mined(f.perp.write.executeOrder([order.orderId, next], { account: keeper.account }));
    assert.equal((await f.perp.read.getOrder([order.orderId])).status, 2);
  });

  it('SECURITY: however late it is executed, an order fills at its round — waiting buys no option', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 20, deposit: 1_100, fee: 5_000n });
    const round = await publish(f.ethFeed, 3000);
    // The keeper is down. ETH falls; Mallory would rather not have bought at 3000.
    await publish(f.ethFeed, 2900);
    await networkHelpers.time.increase(Number(MAX_DELAY) + 3_600);
    // She can't take it back, can't have it expire…
    await viem.assertions.revertWithCustomError(f.perp.write.cancelOrder([order.orderId], { account: mallory.account }), f.perp, 'PriceAlreadyOut');
    const latest = (await f.ethFeed.read.latestRoundData())[0];
    await viem.assertions.revertWithCustomError(f.perp.write.expireOrder([order.orderId, latest], { account: mallory.account }), f.perp, 'PriceAlreadyOut');
    const after = await publish(f.ethFeed, 2890);
    await viem.assertions.revertWithCustomError(f.perp.write.expireOrder([order.orderId, after], { account: mallory.account }), f.perp, 'PriceAlreadyOut');
    // …and whoever executes it, a day later, fills it at 3000.
    await mined(f.perp.write.executeOrder([order.orderId, round], { account: bob.account }));
    const id = (await f.perp.read.getOrder([order.orderId])).positionId;
    assert.equal((await f.perp.read.getPosition([id])).entryPrice, px(3000));
    await assertSolvent(f);
  });

  it('an order no round priced in its window is released, with the feed’s history as proof — by anyone, for the fee', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 300, fee: 5_000n });
    assert.equal(await f.perp.read.orderDeadline([order.orderId]), order.requestedAt + MAX_DELAY);
    const before = (await f.ethFeed.read.latestRoundData())[0];
    await viem.assertions.revertWithCustomError(f.perp.write.expireOrder([order.orderId, before]), f.perp, 'TooEarlyToCancel');
    // A quiet feed: nothing for the whole window. Its latest round, from before the request, proves it.
    await networkHelpers.time.increase(Number(MAX_DELAY) + 1);
    let receipt!: Awaited<ReturnType<typeof mined>>;
    const earned = await ethDelta(mallory, async () => (receipt = await mined(f.perp.write.expireOrder([order.orderId, before], { account: mallory.account }))));
    assert.equal(cancelReason(f, receipt), 'expired');
    assert.equal(earned, 5_000n);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(300), 'everything back, the fee too');

    // A round lands after the window: the first one after it is the proof.
    await publish(f.ethFeed, 3000);
    const second = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5 });
    await networkHelpers.time.increase(Number(MAX_DELAY) + 10);
    const firstAfter = await publish(f.ethFeed, 3001);
    const secondAfter = await publish(f.ethFeed, 3002);
    await viem.assertions.revertWithCustomError(f.perp.write.expireOrder([second.orderId, secondAfter]), f.feed, 'NotFirstRound');
    await viem.assertions.revertWithCustomError(f.perp.write.executeOrder([second.orderId, firstAfter]), f.feed, 'RoundOutOfWindow');
    await mined(f.perp.write.expireOrder([second.orderId, firstAfter], { account: keeper.account }));
    assert.equal((await f.perp.read.getOrder([second.orderId])).status, 3);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(300));
    await assertSolvent(f);
  });

  it('looks back through at most 64 rounds to prove a round first', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    // 63 rounds in flight at the request: its round is still proven first.
    const before = await now();
    await networkHelpers.time.increase(2);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 400 });
    for (let i = 0; i < 63; i += 1) await publishObserved(f.ethFeed, 3000 + i, before);
    const round = await publish(f.ethFeed, 3010);
    await mined(f.perp.write.executeOrder([order.orderId, round], { account: keeper.account }));
    assert.equal((await f.perp.read.getOrder([order.orderId])).status, 2);

    // 64 — a round a second, beyond what Chainlink publishes: the proof would need a 65th read.
    const at = await now();
    await networkHelpers.time.increase(2);
    const second = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5 });
    for (let i = 0; i < 64; i += 1) await publishObserved(f.ethFeed, 3000 + i, at);
    const late = await publish(f.ethFeed, 3010);
    await viem.assertions.revertWithCustomError(f.perp.write.executeOrder([second.orderId, late], { account: keeper.account }), f.feed, 'NotFirstRound');
  });

  it('SECURITY: an order is pinned to its feed phase — neither aggregator fills it across a migration, and it’s refunded', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 300, fee: 5_000n });
    // Chainlink's next aggregator (phase 2) starts reporting before the proxy switches to it.
    await networkHelpers.time.increase(MARGIN);
    await mined(f.ethFeed.write.updateAnswerIn([2, answer(3006)]));
    const phase2 = (1n << 65n) | 1n;
    await viem.assertions.revertWithCustomError(f.perp.write.executeOrder([order.orderId, phase2]), f.feed, 'WrongPhase');
    // The proxy switches; the old aggregator still takes a round.
    await mined(f.ethFeed.write.startPhase());
    await mined(f.ethFeed.write.updateAnswerIn([1, answer(3000)]));
    const phase1 = (await f.ethFeed.read.phaseRounds([1])) | (1n << 64n);
    // Executing now cancels it: the feed moved on.
    let receipt!: Awaited<ReturnType<typeof mined>>;
    const earned = await ethDelta(keeper, async () => (receipt = await mined(f.perp.write.executeOrder([order.orderId, phase1], { account: keeper.account }))));
    assert.equal(cancelReason(f, receipt), 'feed upgraded');
    assert.equal(earned, 5_000n);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(300), 'refunded in full');
    // Orders after the switch settle on the new aggregator's rounds as usual.
    const id = await openEth(f, alice, true, 100, 5, 3008);
    assert.equal((await f.perp.read.getPosition([id])).entryPrice, px(3008));
    await assertSolvent(f);
  });

  it('SECURITY: a feed that has gone quiet past its heartbeat takes no orders, and liquidates nothing', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 1_000, 10, 3000, 1_100);
    await networkHelpers.time.increase(Number(MAX_DELAY) + 1);
    await f.vault.write.deposit([usd(500)], { account: bob.account });
    await viem.assertions.revertWithCustomError(
      f.perp.write.requestOpen(['ETH', true, usd(100), 2n, maxUint256, 10n, 0n], { account: bob.account }),
      f.feed,
      'StalePrice',
    );
    await viem.assertions.revertWithCustomError(f.perp.write.requestClose([id, 0n], { account: alice.account }), f.feed, 'StalePrice');
    await viem.assertions.revertWithCustomError(f.perp.write.liquidate(['ETH', [id]], { account: keeper.account }), f.feed, 'StalePrice');
    // The feed publishes again: both go through.
    await publish(f.ethFeed, 3000);
    await requestOpen(f, bob, { isLong: true, collateral: 100, leverage: 2 });
    await requestClose(f, alice, id);
    await assertSolvent(f);
  });

  it('SECURITY: a limit the current price already breaks is refused — an order can’t sit on the pool for free', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await f.vault.write.deposit([usd(1_000)], { account: mallory.account });
    await viem.assertions.revertWithCustomError(
      requestOpen(f, mallory, { isLong: true, collateral: 500, leverage: 20, acceptable: px(2999) }),
      f.perp,
      'AcceptablePriceTooTight',
    );
    await viem.assertions.revertWithCustomError(
      requestOpen(f, mallory, { isLong: false, collateral: 500, leverage: 20, acceptable: px(3001) }),
      f.perp,
      'AcceptablePriceTooTight',
    );
    // At the current price, or looser, it's taken.
    await requestOpen(f, mallory, { isLong: true, collateral: 100, leverage: 5, acceptable: px(3000) });
    await requestOpen(f, mallory, { isLong: false, collateral: 100, leverage: 5, acceptable: px(3000) });
  });

  it('an order whose price breaks its bound is cancelled and refunded; the executor is still paid', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await f.vault.write.deposit([usd(1_000)], { account: alice.account });
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, acceptable: px(3015), fee: 1_000_000n });
    assert.equal((await f.perp.read.getOrder([order.orderId])).executionFee, 1_000_000n);
    const round = await publish(f.ethFeed, 3100);
    let receipt!: Awaited<ReturnType<typeof mined>>;
    const earned = await ethDelta(keeper, async () => (receipt = await mined(f.perp.write.executeOrder([order.orderId, round], { account: keeper.account }))));
    assert.equal(cancelReason(f, receipt), 'price past limit');
    assert.equal(earned, 1_000_000n, 'the keeper keeps the execution fee');
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(1_000));
    assert.equal(await f.vault.read.reservedLiquidity(), 0n);
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[LONG_OI], 0n, 'open interest released');
    await assertSolvent(f);
  });

  it('a non-positive answer settles nothing: the order it would fill is cancelled and refunded, and it takes no request', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 200 });
    const round = await publish(f.ethFeed, 0);
    const receipt = await mined(f.perp.write.executeOrder([order.orderId, round], { account: keeper.account }));
    assert.equal(cancelReason(f, receipt), 'bad price');
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(200));
    await viem.assertions.revertWithCustomError(
      f.perp.write.requestOpen(['ETH', true, usd(100), 2n, maxUint256, 10n, 0n], { account: alice.account }),
      f.feed,
      'BadPrice',
    );
    await assertSolvent(f);
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

  it('batch liquidation takes what it can and skips the rest (healthy, closed, another market)', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const underwater = await openEth(f, alice, true, 500, 20, 3000, 1_000);
    const healthy = await openEth(f, bob, true, 500, 2, 3000, 1_000);
    const stock = await requestOpen(f, bob, { symbol: 'NVDA', isLong: true, collateral: 100, leverage: 5 });
    await executeAt(f, stock, 1000, f.nvdaFeed);
    const stockId = (await f.perp.read.getOrder([stock.orderId])).positionId;

    await liquidateEth(f, [underwater, healthy, stockId, 999n, underwater], 2800);
    assert.equal((await f.perp.read.getPosition([underwater])).status, 3);
    assert.equal((await f.perp.read.getPosition([healthy])).status, 1);
    assert.equal((await f.perp.read.getPosition([stockId])).status, 1);
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
    assert.ok(paid >= usd(10) && paid < usd('10.03'), `long paid ${paid}`);
    assert.ok(received >= usd(10) && received < usd('10.03'), `short received ${received}`);
    await viem.assertions.revertWithCustomError(f.perp.write.setFundingRate([ETH_MARKET, px('0.0002')]), f.perp, 'InvalidParam');
    await assertSolvent(f);
  });

  it('caps profit at min(9× collateral, size) and never promises more than the pool holds', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 100, 50, 3000, 200);
    await closeEth(f, alice, id, 6000);
    // +100% on 5,000 would be +5,000; the cap is 900. Fees 5 + 5.
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(200 - 5 + 900 - 5));

    // At 1× the reserve is the size, not 9× the collateral.
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 10_000, leverage: 1, deposit: 10_100 });
    assert.equal((await f.perp.read.getOrder([order.orderId])).reserve, usd(10_000));

    const available = await f.vault.read.availableLiquidity();
    await f.vault.write.removeLiquidity([available - usd(5_000), owner.account.address]);
    await f.vault.write.deposit([usd(1_100)], { account: bob.account });
    await viem.assertions.revertWithCustomError(requestOpen(f, bob, { isLong: true, collateral: 1_000, leverage: 10 }), f.vault, 'InsufficientPoolLiquidity');
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
    await takeBack(f, alice, first);
    const second = await req('ETH', 200, 10);

    // Pausing stops new orders; one already requested still fills on its own terms.
    await f.perp.write.setMarket([ETH_MARKET, false, 50, usd(1_000_000)]);
    await viem.assertions.revertWithCustomError(req('ETH', 100, 2), f.perp, 'MarketDisabled');
    await executeAt(f, second, 3000);
    assert.equal((await f.perp.read.getOrder([second.orderId])).status, 2);
    await assertSolvent(f);
  });

  it('parameter changes never reach an order in flight or an open position', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: false, collateral: 1_000, leverage: 10, deposit: 1_100 });
    await f.perp.write.setExecution([30n, 3_600n, 600n, 600n, 0n]);
    await f.perp.write.setLiquidation([5_000n, 2_500n, 500n]);
    await f.perp.write.setFees([100n, 100n]);
    // It still fills at the first round a second after its request, not 30.
    await executeAt(f, order, 3000);
    const id = (await f.perp.read.getOrder([order.orderId])).positionId;
    assert.equal((await f.perp.read.getPosition([id])).liquidationThresholdBps, 8_000);
    // At the new 50% threshold a 6% move would liquidate it; at its own 80% it doesn't.
    await liquidateEth(f, [id], 3180);
    assert.equal((await f.perp.read.getPosition([id])).status, 1);

    // A new order waits the new 30 s: a round sooner isn't its round.
    const next = await requestOpen(f, bob, { isLong: true, collateral: 100, leverage: 2, deposit: 300, maxFeeBps: 100n });
    const early = await publish(f.ethFeed, 3000);
    await viem.assertions.revertWithCustomError(
      f.perp.write.executeOrder([next.orderId, early], { account: keeper.account }),
      f.feed,
      'RoundOutOfWindow',
    );
    await networkHelpers.time.increase(30);
    const round = await publish(f.ethFeed, 3000);
    await mined(f.perp.write.executeOrder([next.orderId, round], { account: keeper.account }));
    assert.equal((await f.perp.read.getOrder([next.orderId])).status, 2);

    // Alice's own 0.1% fees (10 + 10), not the new 1%.
    await f.perp.write.setExecution([1n, MAX_DELAY, MAX_DELAY, MAX_DELAY, 0n]);
    await closeEth(f, alice, id, 3000);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(1_100 - 10 - 10));
    await assertSolvent(f);
  });

  it('the trader takes an order back in two steps — asked for, then released five minutes on — forfeiting the opening fee', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5, deposit: 300, fee: 7_000n });
    await viem.assertions.revertWithCustomError(f.perp.write.cancelOrder([order.orderId], { account: bob.account }), f.perp, 'NotYourOrder');
    // A quiet feed: no round for an hour. Alice asks for it back.
    await networkHelpers.time.increase(3_600);
    const ask = await mined(f.perp.write.cancelOrder([order.orderId], { account: alice.account }));
    const [asked] = parseEventLogs({ abi: f.perp.abi, logs: ask.logs, eventName: 'CancelRequested' });
    assert.equal(asked?.args.releasableAt, (await now()) + CANCEL_DELAY);
    assert.equal((await f.perp.read.getOrder([order.orderId])).status, 1, 'still pending until released');
    assert.equal(await f.vault.read.lockedCollateral([alice.account.address]), usd(100.5));
    await viem.assertions.revertWithCustomError(f.perp.write.cancelOrder([order.orderId], { account: keeper.account }), f.perp, 'TooEarlyToCancel');
    // Five minutes on, with no round landed, anyone releases it — the keeper does, for the fee.
    await networkHelpers.time.increase(Number(CANCEL_DELAY));
    const fees = await f.vault.read.protocolFees();
    let receipt!: Awaited<ReturnType<typeof mined>>;
    const earned = await ethDelta(keeper, async () => (receipt = await mined(f.perp.write.cancelOrder([order.orderId], { account: keeper.account }))));
    assert.equal(cancelReason(f, receipt), 'cancelled by trader');
    assert.equal(earned, 7_000n);
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(299.5), 'collateral back, the 0.5 opening fee kept');
    assert.equal(await f.vault.read.protocolFees(), fees + usd(0.5));
    assert.equal(await f.vault.read.reservedLiquidity(), 0n);
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[LONG_OI], 0n);

    // Asked for, then a price observed after the ask lands: it cancels the order instead of filling it.
    const second = await requestOpen(f, alice, { isLong: true, collateral: 100, leverage: 5 });
    await mined(f.perp.write.cancelOrder([second.orderId], { account: alice.account }));
    const after = await publish(f.ethFeed, 2900);
    assert.equal(cancelReason(f, await mined(f.perp.write.executeOrder([second.orderId, after], { account: keeper.account }))), 'cancelled by trader');
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(299));
    await assertSolvent(f);
  });

  it('SECURITY: a cancel asked for after the price was observed doesn’t count — whoever saw it early can’t pick their fills', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const order = await requestOpen(f, mallory, { isLong: true, collateral: 1_000, leverage: 20, deposit: 1_100 });
    // Chainlink observes 2950 (bad for her long); the round is 13 s from landing. Mallory learns
    // it early and asks for her order back before it lands.
    await networkHelpers.time.increase(20);
    const observed = await now();
    await networkHelpers.time.increase(5);
    await mined(f.perp.write.cancelOrder([order.orderId], { account: mallory.account }));
    const round = await publishObserved(f.ethFeed, 2950, observed);
    // The round has landed: nothing releases the order now, and it fills her.
    await viem.assertions.revertWithCustomError(f.perp.write.cancelOrder([order.orderId], { account: mallory.account }), f.perp, 'PriceAlreadyOut');
    await mined(f.perp.write.executeOrder([order.orderId, round], { account: keeper.account }));
    const id = (await f.perp.read.getOrder([order.orderId])).positionId;
    assert.equal((await f.perp.read.getPosition([id])).entryPrice, px(2950));

    // And once a round has landed, asking is refused outright.
    const second = await requestOpen(f, mallory, { isLong: true, collateral: 10, leverage: 2 });
    const next = await publish(f.ethFeed, 2960);
    await viem.assertions.revertWithCustomError(f.perp.write.cancelOrder([second.orderId], { account: mallory.account }), f.perp, 'PriceAlreadyOut');
    await mined(f.perp.write.executeOrder([second.orderId, next], { account: keeper.account }));
    assert.equal((await f.perp.read.getOrder([second.orderId])).status, 2);
    await assertSolvent(f);
  });

  it('SECURITY: a request and its ask in the same block lock nothing for free — the opening fee is forfeited', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await f.vault.write.deposit([usd(2_000)], { account: mallory.account });
    await publicClient.request({ method: 'evm_setAutomine' as never, params: [false] as never });
    let request: Hex;
    let ask: Hex;
    try {
      request = await f.perp.write.requestOpen(['ETH', true, usd(1_000), 20n, maxUint256, 10n, 0n], { account: mallory.account, gas: 1_000_000n });
      ask = await f.perp.write.cancelOrder([1n], { account: mallory.account, gas: 500_000n });
      await networkHelpers.mine();
    } finally {
      await publicClient.request({ method: 'evm_setAutomine' as never, params: [true] as never });
    }
    const [r1, r2] = await Promise.all([publicClient.waitForTransactionReceipt({ hash: request }), publicClient.waitForTransactionReceipt({ hash: ask })]);
    assert.equal(r1.blockNumber, r2.blockNumber, 'one block');
    assert.equal(r2.status, 'success');
    const order = await f.perp.read.getOrder([1n]);
    assert.equal(order.cancelRequestedAt, order.requestedAt);
    // Any round now cancels it — and costs her the 20 USDC opening fee on 20,000 of size.
    await executeAt(f, { orderId: 1n, requestedAt: BigInt(order.requestedAt) }, 3000);
    assert.equal(await f.vault.read.freeCollateral([mallory.account.address]), usd(2_000 - 20));
    await assertSolvent(f);
  });

  it('a market whose feed stops for a week is delisted and settled at its last round — nothing stays stuck', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const buy = await requestOpen(f, alice, { symbol: 'NVDA', isLong: true, collateral: 100, leverage: 5, deposit: 200 });
    await executeAt(f, buy, 1000, f.nvdaFeed);
    const id = (await f.perp.read.getOrder([buy.orderId])).positionId;
    const stuck = await requestOpen(f, bob, { symbol: 'NVDA', isLong: false, collateral: 100, leverage: 5, deposit: 200, fee: 3_000n });
    // The feed's last round before Chainlink retires it: $1,040.
    await publish(f.nvdaFeed, 1040);

    await viem.assertions.revertWithCustomError(f.perp.write.delistMarket(['NVDA']), f.perp, 'NotDelistable');
    await networkHelpers.time.increase(7 * 86_400);
    // A week on the owner can; anyone else only after two.
    await viem.assertions.revertWithCustomError(f.perp.write.delistMarket(['NVDA'], { account: mallory.account }), f.perp, 'NotDelistable');
    await f.perp.write.delistMarket(['NVDA']);
    const m = await f.perp.read.markets([NVDA_MARKET]);
    assert.equal(m[2], true, 'delisted');
    assert.equal(m[10], px(1040), 'settlement price');

    await viem.assertions.revertWithCustomError(f.perp.write.requestClose([id, 0n], { account: alice.account }), f.perp, 'MarketIsDelisted');
    await viem.assertions.revertWithCustomError(f.perp.write.liquidate(['NVDA', [id]]), f.perp, 'MarketIsDelisted');
    await viem.assertions.revertWithCustomError(f.perp.write.setMarket([NVDA_MARKET, true, 5, usd(1)]), f.perp, 'MarketIsDelisted');

    // Anyone settles: +4% on 500 = +20, and no close fee.
    await mined(f.perp.write.settleDelisted([[id, 999n]], { account: mallory.account }));
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(200 - 0.5 + 20));
    const receipt = await mined(f.perp.write.cancelOrder([stuck.orderId], { account: mallory.account }));
    assert.equal(cancelReason(f, receipt), 'market delisted');
    assert.equal(await f.vault.read.freeCollateral([bob.account.address]), usd(200));
    assert.equal((await f.perp.read.markets([NVDA_MARKET]))[LONG_OI], 0n);
    assert.equal((await f.perp.read.markets([NVDA_MARKET]))[SHORT_OI], 0n);
    await assertSolvent(f);
  });

  it('SECURITY: a feed that stops answering altogether still lets positions out — at the last price read, anyone after two weeks', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 1_000, 5, 3000, 1_100);
    // The last price anything read: a close request at 3,090.
    await publish(f.ethFeed, 3090);
    const close = await requestClose(f, alice, id);
    // Chainlink retires the proxy behind access control: every read reverts.
    await mined(f.ethFeed.write.setBroken([true]));
    await networkHelpers.time.increase(7 * 86_400);
    await viem.assertions.revertWithCustomError(f.perp.write.delistMarket(['ETH'], { account: mallory.account }), f.perp, 'NotDelistable');
    await networkHelpers.time.increase(7 * 86_400);
    await mined(f.perp.write.delistMarket(['ETH'], { account: mallory.account }));
    assert.equal((await f.perp.read.markets([ETH_MARKET]))[10], px(3090));
    // The close waiting on the dead feed is cancelled; the position settles at 3,090: +3% on 5,000 = +150.
    assert.equal(cancelReason(f, await mined(f.perp.write.cancelOrder([close.orderId], { account: mallory.account }))), 'market delisted');
    await mined(f.perp.write.settleDelisted([[id]], { account: mallory.account }));
    assert.equal(await f.vault.read.freeCollateral([alice.account.address]), usd(1_100 - 5 + 150));
    await assertSolvent(f);
  });

  it('only the trader closes; one close at a time; owner powers are bounded', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const id = await openEth(f, alice, true, 100, 2, 3000, 200);
    await viem.assertions.revertWithCustomError(f.perp.write.requestClose([id, 0n], { account: bob.account }), f.perp, 'NotPositionOwner');
    await requestClose(f, alice, id);
    await viem.assertions.revertWithCustomError(f.perp.write.requestClose([id, 0n], { account: alice.account }), f.perp, 'CloseAlreadyPending');
    await viem.assertions.revertWithCustomError(f.perp.write.setFundingRate([ETH_MARKET, 1n], { account: bob.account }), f.perp, 'OwnableUnauthorizedAccount');
    await viem.assertions.revertWithCustomError(f.perp.write.setFees([101n, 10n]), f.perp, 'InvalidParam');
    await viem.assertions.revertWithCustomError(f.perp.write.setLiquidation([9_600n, 1_000n, 50n]), f.perp, 'InvalidParam');
    for (const bad of [
      [0n, 90_000n, 90_000n, 90_000n, 0n],
      [1n, 30n, 90_000n, 90_000n, 0n],
      [1n, 172_801n, 90_000n, 90_000n, 0n],
      [1n, 90_000n, 59n, 90_000n, 0n],
      [1n, 90_000n, 90_000n, 172_801n, 0n],
      [1n, 90_000n, 90_000n, 90_000n, px('0.02')],
    ] as const) {
      await viem.assertions.revertWithCustomError(f.perp.write.setExecution([...bad]), f.perp, 'InvalidParam');
    }
    await viem.assertions.revertWithCustomError(f.vault.write.setPerp([bob.account.address]), f.vault, 'PerpAlreadySet');
    await viem.assertions.revertWithCustomError(f.vault.write.lock([alice.account.address, 1n, 0n], { account: bob.account }), f.vault, 'NotPerp');
    await viem.assertions.revertWithCustomError(f.feed.write.listFeed(['ETH', f.ethFeed.address]), f.feed, 'AlreadyListed');
    await viem.assertions.revertWithCustomError(f.feed.write.listFeed(['SOL', bob.account.address]), f.feed, 'InvalidParam');
    await viem.assertions.revertWithCustomError(f.feed.write.listFeed(['SOL', f.ethFeed.address], { account: bob.account }), f.feed, 'OwnableUnauthorizedAccount');
  });

  it('keeps the vault solvent through a mixed sequence', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    const a = await openEth(f, alice, true, 700, 7, 3000, 3_000);
    const b = await openEth(f, bob, false, 900, 3, 3010, 3_000);
    const c = await openEth(f, alice, false, 400, 25, 2990);
    const pending = await requestOpen(f, bob, { isLong: true, collateral: 300, leverage: 4 });
    await assertSolvent(f);
    // The next round settles both the pending open and Alice's close request.
    const close = await requestClose(f, alice, a);
    const round = await publish(f.ethFeed, 3120);
    await mined(f.perp.write.executeOrder([pending.orderId, round], { account: keeper.account }));
    await mined(f.perp.write.executeOrder([close.orderId, round], { account: keeper.account }));
    await assertSolvent(f);
    await liquidateEth(f, [c], 3200);
    await assertSolvent(f);
    await closeEth(f, bob, b, 3190);
    await assertSolvent(f);
    await f.vault.write.withdraw([await f.vault.read.freeCollateral([alice.account.address])], { account: alice.account });
    await f.vault.write.collectFees([owner.account.address]);
    await assertSolvent(f);
  });

  it('reads 8-decimal answers as 18-decimal USD and marks positions for views', async () => {
    const f = await networkHelpers.loadFixture(deploy);
    await publish(f.nvdaFeed, '181.23456789');
    const [price, index, publishTime] = await f.feed.read.readUnsafe([NVDA_MARKET]);
    assert.equal(price, px('181.23456789'));
    assert.equal(index, price);
    assert.equal(publishTime, await now());
    const [proxy, decimals, listed] = await f.feed.read.feedOf([NVDA_MARKET]);
    assert.equal(proxy.toLowerCase(), f.nvdaFeed.address.toLowerCase());
    assert.equal(decimals, 8);
    assert.equal(listed, true);

    const id = await openEth(f, alice, true, 100, 10, 3000, 200);
    await publish(f.ethFeed, 2850);
    const [pnl, , equity, liquidatable] = await f.perp.read.positionState([id]);
    assert.equal(pnl, -usd(50));
    assert.equal(equity, usd(50));
    assert.equal(liquidatable, false);
  });
});
