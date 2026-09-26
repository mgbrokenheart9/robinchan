/**
 * Delists a market whose price has stopped (the owner's job): Chainlink
 * retired its feed, or the feed went silent. AgriPerp allows it once the
 * feed's last round is a week old; open positions then settle at that price,
 * with no close fee — the worker's keeper settles them, and so can anyone
 * (settleDelisted is permissionless).
 *
 *   DELIST_SYMBOL=NVDA npx hardhat run scripts/delist.ts --network rhMainnet
 *
 * The settlement price is the feed's last round. Once a Safe owns the
 * contracts, SAFE_TX=true prints the call for the Safe to sign.
 */
import { readFileSync } from 'node:fs';

import { network } from 'hardhat';
import { encodeFunctionData, formatUnits, keccak256, toBytes, type Address } from 'viem';

import { ownerCall } from './lib/owner-call.js';

const symbol = process.env.DELIST_SYMBOL?.trim().toUpperCase();
if (!symbol) throw new Error('Set DELIST_SYMBOL, e.g. DELIST_SYMBOL=NVDA');

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployment = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), 'utf8')) as {
  feed: Address;
  perp: Address;
};

const feed = await viem.getContractAt('AgriFeed', deployment.feed);
const perp = await viem.getContractAt('AgriPerp', deployment.perp);
const [price, , publishTime] = await feed.read.readUnsafe([keccak256(toBytes(symbol))]);
console.log(`${symbol}: last Chainlink price ${formatUnits(price, 18)} USD, published ${new Date(Number(publishTime) * 1000).toISOString()}`);
await ownerCall({
  what: `${symbol}: delist; positions settle at ${formatUnits(price, 18)} USD`,
  to: perp.address,
  data: encodeFunctionData({ abi: perp.abi, functionName: 'delistMarket', args: [symbol] }),
  send: () => perp.write.delistMarket([symbol]),
  wait: (hash) => publicClient.waitForTransactionReceipt({ hash }),
});
