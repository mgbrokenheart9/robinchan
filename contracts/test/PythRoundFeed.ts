import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { network } from 'hardhat';
import { keccak256, maxUint256, parseEventLogs, parseUnits, toBytes, type Hex } from 'viem';

/**
 * PythRoundFeed: a Pyth feed as Chainlink-style rounds, each Pyth's first
 * print at or after the next slot, listed in AgriFeed like any Chainlink
 * proxy. Covers who picks a round (nobody), the unit and confidence rules,
 * rolls between contract months, the oracle fee, and an AgriPerp order
 * settling on it end to end.
 */

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner, alice, mallory] = await viem.getWalletClients();

const CF_Z6 = keccak256(toBytes('Commodities.CFZ6/USc'));
const CF_H7 = keccak256(toBytes('Commodities.CFH7/USc'));
const SLOT = 60n;
const EXPO = -2;
const PHASE = 1n << 64n;

const usd = (x: number | string) => parseUnits(String(x), 6);
/** Pyth's integer price for a quote in US cents at expo −2: 345.25¢ → 34525. */
const cents = (x: number) => BigInt(Math.round(x * 100));
/** The feed's 8-decimal USD answer for a price in cents. */
const answerOf = (c: number) => parseUnits((c / 100).toFixed(8), 8);

async function now(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest());
}

async function mined(hash: Promise<Hex>) {
  return publicClient.waitForTransactionReceipt({ hash: await hash });
}

async function deploy(opts: { fee?: bigint } = {}) {
  const pyth = await viem.deployContract('TestPyth', [60n, opts.fee ?? 0n]);
  const start = ((await now()) / SLOT + 2n) * SLOT;
  const coffee = await viem.deployContract('PythRoundFeed', [
    pyth.address,
    CF_Z6,
    SLOT,
    -2,
    300,
    start,
    'Pyth Arabica Coffee / USD',
    owner.account.address,
  ]);
  return { pyth, coffee, start };
}

type Fixture = Awaited<ReturnType<typeof deploy>>;

/** Hermes-style update data: a print of `id` at `publishTime`, the one before it at `prev`. */
function update(f: Fixture, id: Hex, priceCents: number, publishTime: bigint, prev: bigint, conf = 0n): Promise<Hex> {
  const p = cents(priceCents);
  return f.pyth.read.createPriceFeedUpdateData([id, p, conf, EXPO, p, conf, publishTime, prev]);
}

/** Move the chain to `t` and push `id`'s print at `publishTime` (first after `prev`). */
async function pushAt(f: Fixture, t: bigint, priceCents: number, publishTime: bigint, prev = publishTime - 2n, id: Hex = CF_Z6) {
  if (t > (await now())) await networkHelpers.time.increaseTo(t);
  return mined(f.coffee.write.push([[await update(f, id, priceCents, publishTime, prev)]]));
}

describe('PythRoundFeed', () => {
  it('a round is Pyth’s first print at or after the next slot — a pusher can’t pick a later one', async () => {
    const f = await deploy();
    await viem.assertions.revertWithCustomError(f.coffee.read.latestRoundData(), f.coffee, 'NoRound');
    await networkHelpers.time.increaseTo(f.start + 5n);

    // Not the first print since the slot opened: its predecessor was already in the slot.
    await viem.assertions.revertWithCustomError(
      f.coffee.write.push([[await update(f, CF_Z6, 345, f.start + 3n, f.start + 2n)]], { account: mallory.account }),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );
    // From before the slot: refused too.
    await viem.assertions.revertWithCustomError(
      f.coffee.write.push([[await update(f, CF_Z6, 345, f.start - 1n, f.start - 2n)]], { account: mallory.account }),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );

    await mined(f.coffee.write.push([[await update(f, CF_Z6, 345.25, f.start + 1n, f.start - 3n)]], { account: mallory.account }));
    const [id, answer, startedAt, updatedAt, answeredIn] = await f.coffee.read.latestRoundData();
    assert.equal(id, PHASE | 1n);
    assert.equal(answeredIn, id);
    assert.equal(answer, answerOf(345.25), 'US cents land as 8-decimal USD');
    assert.equal(startedAt, f.start + 1n, 'observed when Pyth published it');
    assert.equal(updatedAt, await now(), 'landed when pushed');
    assert.equal(await f.coffee.read.nextSlot(), f.start + SLOT, 'the next slot starts after this print’s');

    // The same print can't make a second round.
    await viem.assertions.revertWithCustomError(
      f.coffee.write.push([[await update(f, CF_Z6, 345.25, f.start + 1n, f.start - 3n)]]),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );

    // Round history reads like a Chainlink proxy's, phase 1.
    const [rid, ra] = await f.coffee.read.getRoundData([PHASE | 1n]);
    assert.equal(rid, PHASE | 1n);
    assert.equal(ra, answerOf(345.25));
    await viem.assertions.revertWithCustomError(f.coffee.read.getRoundData([PHASE | 2n]), f.coffee, 'NoRound');
    await viem.assertions.revertWithCustomError(f.coffee.read.getRoundData([(2n << 64n) | 1n]), f.coffee, 'NoRound');
    assert.equal(await f.coffee.read.decimals(), 8);
    assert.equal(await f.coffee.read.description(), 'Pyth Arabica Coffee / USD');
  });

  it('a market that stopped printing resumes at its first print after the slot, however late', async () => {
    const f = await deploy();
    await pushAt(f, f.start + 2n, 345, f.start + 1n);
    // Closed for the weekend: the next print is two days on, and it is the next round.
    const monday = f.start + 2n * 86_400n + 7n;
    await pushAt(f, monday + 10n, 351, monday, f.start + 50n);
    const [id, answer, startedAt] = await f.coffee.read.latestRoundData();
    assert.equal(id, PHASE | 2n);
    assert.equal(answer, answerOf(351));
    assert.equal(startedAt, monday);
    assert.equal(await f.coffee.read.nextSlot(), (monday / SLOT + 1n) * SLOT);
  });

  it('a print with a non-positive price or too wide a confidence interval answers 0', async () => {
    const f = await deploy();
    // 3% of the price is the limit (300 bps): 12¢ on 345¢ is inside, 11¢ over it is not.
    await networkHelpers.time.increaseTo(f.start + 2n);
    await mined(f.coffee.write.push([[await update(f, CF_Z6, 345, f.start + 1n, f.start - 1n, cents(10))]]));
    assert.equal((await f.coffee.read.latestRoundData())[1], answerOf(345));
    const next = await f.coffee.read.nextSlot();
    await networkHelpers.time.increaseTo(next + 2n);
    await mined(f.coffee.write.push([[await update(f, CF_Z6, 345, next + 1n, next - 1n, cents(11))]]));
    assert.equal((await f.coffee.read.latestRoundData())[1], 0n, 'too uncertain: a bad-price round');
    const after = await f.coffee.read.nextSlot();
    await networkHelpers.time.increaseTo(after + 2n);
    await mined(f.coffee.write.push([[await update(f, CF_Z6, 0, after + 1n, after - 1n)]]));
    assert.equal((await f.coffee.read.latestRoundData())[1], 0n, 'non-positive: a bad-price round');
  });

  it('pays Pyth’s fee from msg.value and returns the change', async () => {
    const f = await deploy({ fee: 1000n });
    await networkHelpers.time.increaseTo(f.start + 2n);
    const data = [await update(f, CF_Z6, 345, f.start + 1n, f.start - 1n)];
    await viem.assertions.revertWithCustomError(f.coffee.write.push([data], { value: 999n }), f.coffee, 'InsufficientOracleFee');
    const before = await publicClient.getBalance({ address: f.pyth.address });
    await mined(f.coffee.write.push([data], { value: 5000n }));
    assert.equal((await publicClient.getBalance({ address: f.pyth.address })) - before, 1000n, 'Pyth got its fee');
    assert.equal(await publicClient.getBalance({ address: f.coffee.address }), 0n, 'nothing kept');
  });

  it('rolls to the next month on each month’s first print after the announced time, keeping the answer continuous', async () => {
    const f = await deploy();
    await pushAt(f, f.start + 2n, 345, f.start + 1n);

    const t = await now();
    await viem.assertions.revertWithCustomError(
      f.coffee.write.scheduleRoll([CF_H7, t + 3600n]),
      f.coffee,
      'InvalidParam',
    );
    await viem.assertions.revertWithCustomError(
      f.coffee.write.scheduleRoll([CF_H7, t + 86_400n * 2n], { account: mallory.account }),
      f.coffee,
      'OwnableUnauthorizedAccount',
    );
    const at = ((t + 86_400n * 2n) / SLOT) * SLOT + 30n;
    await mined(f.coffee.write.scheduleRoll([CF_H7, at]));

    // Due and not carried out: no round can be pushed.
    await networkHelpers.time.increaseTo(at + 5n);
    await viem.assertions.revertWithCustomError(
      f.coffee.write.push([[await update(f, CF_Z6, 350, at + 1n, at - 1n)]]),
      f.coffee,
      'RollDue',
    );
    // Prints that aren't each month's first after the roll time don't carry it out…
    await viem.assertions.revertWithCustomError(
      f.coffee.write.executeRoll([[await update(f, CF_Z6, 350, at + 2n, at + 1n), await update(f, CF_H7, 360, at + 1n, at - 1n)]]),
      f.pyth,
      'PriceFeedNotFoundWithinRange',
    );
    // …nor months more than 5 s apart.
    await viem.assertions.revertWithCustomError(
      f.coffee.write.executeRoll([[await update(f, CF_Z6, 350, at, at - 1n), await update(f, CF_H7, 360, at + 9n, at - 1n)]]),
      f.coffee,
      'RollPricesApart',
    );
    // The first prints: 350¢ old month, 360¢ new month.
    await mined(
      f.coffee.write.executeRoll([[await update(f, CF_Z6, 350, at, at - 1n), await update(f, CF_H7, 360, at + 1n, at - 2n)]], {
        account: mallory.account,
      }),
    );
    assert.equal(await f.coffee.read.feedId(), CF_H7);
    const factor = await f.coffee.read.rollFactor();
    assert.equal(factor, (10n ** 18n * 35000n) / 36000n);

    // The next round is the new month's first print from the roll time on, scaled: 360¢ reads as 350¢.
    assert.equal(await f.coffee.read.nextSlot(), at);
    await mined(f.coffee.write.push([[await update(f, CF_H7, 360, at + 1n, at - 2n)]], { account: mallory.account }));
    const [, answer] = await f.coffee.read.latestRoundData();
    const expected = (answerOf(360) * factor) / 10n ** 18n;
    assert.equal(answer, expected);
    assert.ok(answer === answerOf(350) || answer + 1n === answerOf(350), 'continuous across the roll');
  });

  it('a roll not carried out within the deadline lapses, and rounds resume on the old month', async () => {
    const f = await deploy();
    await pushAt(f, f.start + 2n, 345, f.start + 1n);
    const at = (((await now()) + 86_400n * 2n) / SLOT) * SLOT;
    await mined(f.coffee.write.scheduleRoll([CF_H7, at]));
    await networkHelpers.time.increaseTo(at + 3600n + 5n);
    await viem.assertions.revertWithCustomError(
      f.coffee.write.executeRoll([[await update(f, CF_Z6, 350, at, at - 1n), await update(f, CF_H7, 360, at, at - 1n)]]),
      f.coffee,
      'RollExpired',
    );
    const next = await f.coffee.read.nextSlot();
    await mined(f.coffee.write.push([[await update(f, CF_Z6, 352, next + 1n, next - 1n)]]));
    assert.equal((await f.coffee.read.latestRoundData())[1], answerOf(352));
    assert.equal(await f.coffee.read.feedId(), CF_Z6);
  });

  it('AgriFeed lists it like a Chainlink proxy, and AgriPerp settles an order on the first round observed after the request', async () => {
    const f = await deploy();
    const usdc = await viem.deployContract('MockUSDC');
    const feed = await viem.deployContract('AgriFeed', [owner.account.address]);
    const vault = await viem.deployContract('AgriVault', [usdc.address, owner.account.address]);
    const perp = await viem.deployContract('AgriPerp', [vault.address, feed.address, owner.account.address]);
    await mined(vault.write.setPerp([perp.address]));
    await mined(usdc.write.mint([owner.account.address, usd(1_000_000)]));
    await mined(usdc.write.approve([vault.address, maxUint256]));
    await mined(vault.write.addLiquidity([usd(1_000_000)]));
    await mined(usdc.write.mint([alice.account.address, usd(10_000)]));
    await mined(usdc.write.approve([vault.address, maxUint256], { account: alice.account }));

    // A feed with no round yet can't be listed.
    await viem.assertions.revertWithCustomError(feed.write.listFeed(['COFF', f.coffee.address]), f.coffee, 'NoRound');
    await pushAt(f, f.start + 2n, 345, f.start + 1n);
    await mined(feed.write.listFeed(['COFF', f.coffee.address]));
    await mined(perp.write.listMarket(['COFF', 5, usd(1_000_000), 0n]));

    // Request a moment after the next slot opened: that slot's first print is already out, in flight.
    const slot2 = await f.coffee.read.nextSlot();
    await networkHelpers.time.increaseTo(slot2 + 3n);
    const receipt = await mined(
      perp.write.requestOpen(['COFF', true, usd(100), 2n, maxUint256, 10n, usd(101)], { account: alice.account }),
    );
    const [ev] = parseEventLogs({ abi: perp.abi, logs: receipt.logs, eventName: 'OrderRequested' });
    assert.ok(ev);
    const orderId = ev.args.orderId;

    // The in-flight print (observed before the request) makes round 2, but can't settle the order.
    await pushAt(f, slot2 + 6n, 346, slot2, slot2 - 1n);
    const inFlight = (await f.coffee.read.latestRoundData())[0];
    await viem.assertions.revertWithCustomError(perp.write.executeOrder([orderId, inFlight]), feed, 'ObservedBeforeRequest');

    // The next slot's first print does — whoever pushes it, and whenever it's executed.
    const slot3 = await f.coffee.read.nextSlot();
    await pushAt(f, slot3 + 4n, 348.5, slot3, slot3 - 1n);
    const settling = (await f.coffee.read.latestRoundData())[0];
    await networkHelpers.time.increase(600);
    await mined(perp.write.executeOrder([orderId, settling], { account: mallory.account }));

    const position = await perp.read.getPosition([1n]);
    assert.equal(position.entryPrice, parseUnits('3.485', 18), 'filled at the first print observed after the request');
    assert.equal(position.trader.toLowerCase(), alice.account.address.toLowerCase());
  });
});
