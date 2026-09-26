/**
 * Announces a stock split (the owner's job). From SPLIT_AT on, every price
 * the market's feed publishes is multiplied by SPLIT_RATIO, so the index —
 * and every open position's PnL — doesn't move when the quoted price drops
 * tenfold. AgriFeed wants a day's notice. After SPLIT_AT, the worker's keeper
 * activates it once the first price after the split is out — the contract
 * checks that price × SPLIT_RATIO lands within 0.8–1.25× of one from before,
 * and until then prices from after SPLIT_AT settle nothing on that market.
 * A day later the keeper folds the ratio into the market's roll factor.
 *
 *   SPLIT_SYMBOL=NVDA SPLIT_RATIO=10 SPLIT_AT=2027-06-10T09:00:00Z \
 *     npx hardhat run scripts/schedule-split.ts --network rhTestnet
 *
 * SPLIT_RATIO is new shares per old share: 10 for a 10-for-1 split, 0.1 for
 * a 1-for-10 reverse split. SPLIT_AT has to fall between the last price
 * published before the split and the first one after — while the market is
 * shut, and before any overnight session that already quotes split-adjusted
 * prices. Get it wrong and positions jump by the ratio: check the feed's
 * hours with Pyth first. A wrong ratio or time can't activate; it can be
 * called off (cancelRebase) up to a day before SPLIT_AT, or once a day has
 * passed after it without activating. Once a Safe owns the contracts,
 * SAFE_TX=true prints the call for the Safe to sign instead of sending it.
 */
import { readFileSync } from 'node:fs';

import { network } from 'hardhat';
import { encodeFunctionData, parseUnits, type Address } from 'viem';

import { ownerCall } from './lib/owner-call.js';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const symbol = env('SPLIT_SYMBOL')?.toUpperCase();
const ratio = env('SPLIT_RATIO');
const at = env('SPLIT_AT');
if (!symbol || !ratio || !at) throw new Error('Set SPLIT_SYMBOL, SPLIT_RATIO and SPLIT_AT, e.g. SPLIT_SYMBOL=NVDA SPLIT_RATIO=10 SPLIT_AT=2027-06-10T09:00:00Z');
const effectiveAt = Date.parse(at);
if (!Number.isFinite(effectiveAt)) throw new Error(`SPLIT_AT isn't a date: ${at}`);

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployment = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), 'utf8')) as { feed: Address };

const feed = await viem.getContractAt('AgriFeed', deployment.feed);
// A 10-for-1 split quotes at a tenth afterwards, so later prices are multiplied by the share ratio.
const multiplier = parseUnits(ratio, 18);
const args = [symbol, multiplier, BigInt(Math.floor(effectiveAt / 1000))] as const;
await ownerCall({
  what: `${symbol}: ${ratio}-for-1 split at ${new Date(effectiveAt).toISOString()}`,
  to: feed.address,
  data: encodeFunctionData({ abi: feed.abi, functionName: 'scheduleRebase', args }),
  send: () => feed.write.scheduleRebase(args),
  wait: (hash) => publicClient.waitForTransactionReceipt({ hash }),
});
