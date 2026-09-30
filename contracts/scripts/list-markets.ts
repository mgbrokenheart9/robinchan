/**
 * Lists the Chainlink markets the registry has gained since the stack was
 * deployed — e.g. SPCX, SPY, CRCL, MU and GLD — on the live perps contracts:
 * each feed on AgriFeed, then its market on AgriPerp, at the launch cap the
 * other markets started at. Markets already listed are skipped. Run by the
 * owner of the perps contracts.
 *
 *   npx hardhat run scripts/list-markets.ts --network rhMainnet
 *   ONLY=SPY,GLD npx hardhat run scripts/list-markets.ts --network rhMainnet
 *
 * Reads deploy/markets.json (generated from the app's registry by
 * `npx tsx scripts/perps-markets.mts` at the repo root) and
 * deployments/{chainId}.json, which it brings up to date.
 *
 * Environment:
 *   ONLY         Comma-separated symbols (default: every market in the file).
 *   MAX_OI_USD   Open-interest cap per side at listing (default 10, the other
 *                markets' launch cap); raise it later with set-markets.ts.
 *   SAFE_TX=true prints the Safe transactions instead of sending.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { network } from 'hardhat';
import { encodeFunctionData, keccak256, parseUnits, toBytes, type Address, type Hex } from 'viem';

import { deployFile, targetOf } from './lib/networks.js';
import { ownerCall } from './lib/owner-call.js';

type DeployMarket = {
  symbol: string;
  maxLeverage: number;
  fundingRatePerHour: string;
  feed: { proxy: Address; description: string };
};

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const only = env('ONLY')?.split(',').map((s) => s.trim().toUpperCase());
const maxOi = parseUnits(env('MAX_OI_USD') ?? '10', 6);

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
// Each network's own markets: deploy/base/markets.json on Base (Multichain brief).
const markets = (JSON.parse(readFileSync(deployFile(targetOf(chainId), 'markets.json'), 'utf8')) as DeployMarket[]).filter(
  (m) => !only || only.includes(m.symbol),
);
const recordUrl = new URL(`../deployments/${chainId}.json`, import.meta.url);
const record = JSON.parse(readFileSync(recordUrl, 'utf8')) as {
  feed: Address;
  perp: Address;
  mockFeeds?: boolean;
  markets: Array<{ symbol: string; feed: Address; description: string }>;
};
if (record.mockFeeds) throw new Error('This deployment reads MockAggregators: redeploy locally instead (scripts/deploy.ts).');

const agriFeed = await viem.getContractAt('AgriFeed', record.feed);
const agriPerp = await viem.getContractAt('AgriPerp', record.perp);
const aggregatorAbi = [
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;
const wait = (hash: Hex) => publicClient.waitForTransactionReceipt({ hash });

let listed = 0;
for (const m of markets) {
  const market = keccak256(toBytes(m.symbol));
  if ((await agriPerp.read.markets([market]))[0]) continue;
  // The proxy has to be the feed the registry names, or the market would settle on something else.
  const description = await publicClient.readContract({ address: m.feed.proxy, abi: aggregatorAbi, functionName: 'description' });
  if (description !== m.feed.description) {
    console.warn(`  ${m.symbol}: ${m.feed.proxy} says "${description}", not "${m.feed.description}" — skipped`);
    continue;
  }
  if (!(await agriFeed.read.isListed([market]))) {
    await ownerCall({
      what: `  ${m.symbol}: feed ${m.feed.proxy} (${description}) listed`,
      to: record.feed,
      data: encodeFunctionData({ abi: agriFeed.abi, functionName: 'listFeed', args: [m.symbol, m.feed.proxy] }),
      send: () => agriFeed.write.listFeed([m.symbol, m.feed.proxy]),
      wait,
    });
  }
  await ownerCall({
    what: `  ${m.symbol}: market listed, up to ${m.maxLeverage}×, open interest capped at $${Number(maxOi) / 1e6} per side`,
    to: record.perp,
    data: encodeFunctionData({ abi: agriPerp.abi, functionName: 'listMarket', args: [m.symbol, m.maxLeverage, maxOi, BigInt(m.fundingRatePerHour)] }),
    send: () => agriPerp.write.listMarket([m.symbol, m.maxLeverage, maxOi, BigInt(m.fundingRatePerHour)]),
    wait,
  });
  if (!record.markets.some((r) => r.symbol === m.symbol)) record.markets.push({ symbol: m.symbol, feed: m.feed.proxy, description });
  listed += 1;
}

if (listed && process.env.SAFE_TX?.trim() !== 'true') writeFileSync(recordUrl, `${JSON.stringify(record, null, 2)}\n`);
console.log(listed ? `${listed} markets listed. Raise their caps with scripts/set-markets.ts when the pool can carry more.` : 'Every market in deploy/markets.json is already listed.');
