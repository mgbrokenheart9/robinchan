import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { network } from 'hardhat';
import { maxUint256, parseEventLogs, parseUnits, type Hex } from 'viem';

/**
 * ReportedRoundFeed: prices the operator's reporter posts, each stamped with
 * when its exchange quoted it, listed in AgriFeed like a Chainlink proxy.
 * Covers the rules the contract holds the reporter to, the owner's override
 * for a large move, rolls, and an AgriPerp order settling on the first round
 * quoted after it even when the data arrives late.
 */

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner, reporter, alice, mallory] = await viem.getWalletClients();

const PHASE = 1n << 64n;
const usd = (x: number | string) => parseUnits(String(x), 6);
/** An 8-decimal USD price. */
const price = (x: number | string) => parseUnits(String(x), 8);

async function now(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest());
}

async function mined(hash: Promise<Hex>) {
  return publicClient.waitForTransactionReceipt({ hash: await hash });
}

async function deploy() {
  return viem.deployContract('ReportedRoundFeed', [
    'Robinchan Arabica Coffee / USD',
    'Yahoo Finance KCZ26.NYB (delayed)',
    1500,
    reporter.account.address,
    owner.account.address,
  ]);
}

describe('ReportedRoundFeed', () => {
  it('posts a round stamped with its quote time, and reads like a Chainlink proxy', async () => {
    const feed = await deploy();
    await viem.assertions.revertWithCustomError(feed.read.latestRoundData(), feed, 'NoRound');
    const quoted = (await now()) - 600n; // a quote from ten minutes ago: delayed data
    await mined(feed.write.report([price(2.781), quoted], { account: reporter.account }));
    const [id, answer, startedAt, updatedAt, answeredIn] = await feed.read.latestRoundData();
    assert.equal(id, PHASE | 1n);
    assert.equal(answeredIn, id);
    assert.equal(answer, price(2.781));
    assert.equal(startedAt, quoted, 'observed when the exchange quoted it');
    assert.equal(updatedAt, await now(), 'landed when posted');
    assert.equal((await feed.read.getRoundData([PHASE | 1n]))[1], price(2.781));
    await viem.assertions.revertWithCustomError(feed.read.getRoundData([PHASE | 2n]), feed, 'NoRound');
    await viem.assertions.revertWithCustomError(feed.read.getRoundData([(2n << 64n) | 1n]), feed, 'NoRound');
    assert.equal(await feed.read.decimals(), 8);
  });

  it('holds the reporter to recent, newer, sane quotes — and only the reporter can post', async () => {
    const feed = await deploy();
    const t = await now();
    await viem.assertions.revertWithCustomError(feed.write.report([price(2.78), t], { account: mallory.account }), feed, 'NotReporter');
    await viem.assertions.revertWithCustomError(feed.write.report([price(2.78), t + 60n], { account: reporter.account }), feed, 'QuoteInFuture');
    await viem.assertions.revertWithCustomError(feed.write.report([price(2.78), t - 3700n], { account: reporter.account }), feed, 'QuoteTooOld');
    await viem.assertions.revertWithCustomError(feed.write.report([0n, t], { account: reporter.account }), feed, 'InvalidParam');
    await mined(feed.write.report([price(2.78), t - 60n], { account: reporter.account }));
    // Not newer than the last round's quote.
    await viem.assertions.revertWithCustomError(feed.write.report([price(2.79), t - 60n], { account: reporter.account }), feed, 'QuoteNotNewer');
    // A 15% move is the most one round takes (a data error, or a stolen key, per round)…
    await viem.assertions.revertWithCustomError(feed.write.report([price(3.2), t - 30n], { account: reporter.account }), feed, 'MoveTooLarge');
    await mined(feed.write.report([price(3.19), t - 30n], { account: reporter.account }));
    // …past it, the owner has to post it.
    await viem.assertions.revertWithCustomError(feed.write.reportUnchecked([price(4), t - 20n], { account: reporter.account }), feed, 'OwnableUnauthorizedAccount');
    await mined(feed.write.reportUnchecked([price(4), t - 20n]));
    assert.equal((await feed.read.latestRoundData())[1], price(4));
  });

  it('rolls to the next month keeping the answer continuous', async () => {
    const feed = await deploy();
    await mined(feed.write.report([price(2.78), (await now()) - 5n], { account: reporter.account }));
    await viem.assertions.revertWithCustomError(
      feed.write.roll([price(2.78), price(2.7095), 'Yahoo Finance KCH27.NYB (delayed)'], { account: mallory.account }),
      feed,
      'NotReporter',
    );
    await viem.assertions.revertWithCustomError(
      feed.write.roll([price(2.78), price(4), 'x'], { account: reporter.account }),
      feed,
      'RollOutOfBounds',
    );
    await mined(feed.write.roll([price(2.78), price(2.7095), 'Yahoo Finance KCH27.NYB (delayed)'], { account: reporter.account }));
    assert.equal(await feed.read.source(), 'Yahoo Finance KCH27.NYB (delayed)');
    // The new month at 2.7095 reads as 2.78.
    await mined(feed.write.report([price(2.7095), await now()], { account: reporter.account }));
    const answer = (await feed.read.latestRoundData())[1];
    assert.ok(answer >= price(2.78) - 1n && answer <= price(2.78), `continuous: ${answer}`);
  });

  it('the owner can replace the reporter', async () => {
    const feed = await deploy();
    await viem.assertions.revertWithCustomError(feed.write.setReporter([mallory.account.address], { account: reporter.account }), feed, 'OwnableUnauthorizedAccount');
    await mined(feed.write.setReporter([alice.account.address]));
    await viem.assertions.revertWithCustomError(feed.write.report([price(2.78), await now()], { account: reporter.account }), feed, 'NotReporter');
    await mined(feed.write.report([price(2.78), await now()], { account: alice.account }));
  });

  it('AgriPerp settles an order on the first round quoted after it, even when that quote is posted ten minutes late', async () => {
    const feed = await deploy();
    const usdc = await viem.deployContract('MockUSDC');
    const agriFeed = await viem.deployContract('AgriFeed', [owner.account.address]);
    const vault = await viem.deployContract('AgriVault', [usdc.address, owner.account.address]);
    const perp = await viem.deployContract('AgriPerp', [vault.address, agriFeed.address, owner.account.address]);
    await mined(vault.write.setPerp([perp.address]));
    await mined(usdc.write.mint([owner.account.address, usd(1_000_000)]));
    await mined(usdc.write.approve([vault.address, maxUint256]));
    await mined(vault.write.addLiquidity([usd(1_000_000)]));
    await mined(usdc.write.mint([alice.account.address, usd(10_000)]));
    await mined(usdc.write.approve([vault.address, maxUint256], { account: alice.account }));

    await mined(feed.write.report([price(2.78), (await now()) - 600n], { account: reporter.account }));
    await mined(agriFeed.write.listFeed(['COFF', feed.address]));
    await mined(perp.write.listMarket(['COFF', 5, usd(1_000_000), 0n]));

    const receipt = await mined(perp.write.requestOpen(['COFF', true, usd(100), 2n, maxUint256, 10n, usd(101)], { account: alice.account }));
    const [ev] = parseEventLogs({ abi: perp.abi, logs: receipt.logs, eventName: 'OrderRequested' });
    assert.ok(ev);
    const requestedAt = BigInt(ev.args.requestedAt);

    // Posted after the request, but quoted before it: the delayed data was already out. It can't settle the order.
    await networkHelpers.time.increase(30);
    await mined(feed.write.report([price(2.79), requestedAt - 60n], { account: reporter.account }));
    const early = (await feed.read.latestRoundData())[0];
    await viem.assertions.revertWithCustomError(perp.write.executeOrder([ev.args.orderId, early]), agriFeed, 'ObservedBeforeRequest');

    // Ten minutes on, the first quote from after the request arrives: that's the fill.
    await networkHelpers.time.increase(600);
    await mined(feed.write.report([price(2.8), requestedAt + 5n], { account: reporter.account }));
    const settling = (await feed.read.latestRoundData())[0];
    await mined(perp.write.executeOrder([ev.args.orderId, settling], { account: mallory.account }));
    assert.equal((await perp.read.getPosition([1n])).entryPrice, parseUnits('2.8', 18));
  });
});
