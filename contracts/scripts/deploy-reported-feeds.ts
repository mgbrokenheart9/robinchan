/**
 * Deploys a ReportedRoundFeed for each agri market the operator prices (corn,
 * soybeans, wheat, coffee, cocoa, sugar, rice, cotton), from
 * deploy/reported-feeds.json — generated from the app's registry by
 * `npx tsx scripts/perps-markets.mts` at the repo root.
 *
 *   npx hardhat run scripts/deploy-reported-feeds.ts --network rhMainnet
 *   npx hardhat run scripts/deploy-reported-feeds.ts --network base       (corn, soybeans, wheat, coffee)
 *   npx hardhat run scripts/deploy-reported-feeds.ts --network arbitrum
 *
 * On Base and Arbitrum (Multichain brief) the markets are deploy/base/'s and
 * deploy/arbitrum/'s: Chainlink has no agri feed there either.
 *
 * Each feed starts on its front month (the first whose roll time is more than
 * a day off), reading it from Yahoo Finance. The keeper — the reporter — posts
 * rounds once the feed is in the registry; the markets open once
 * scripts/list-agri-markets.ts lists them on the perps contracts.
 *
 * These prices are the operator's: nothing on chain proves them. See
 * MAINNET.md §12 before opening them to real money.
 *
 * Environment:
 *   REPORTER_ADDRESS  Who posts prices. Default KEEPER_ADDRESS, else the
 *                     deployer (SINGLE_KEY: the one wallet runs the keeper).
 *   OWNER_ADDRESS     Who owns the feeds (replaces the reporter, posts moves
 *                     past the cap). Default: the deployer.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { network } from 'hardhat';
import { type Address, type Hex } from 'viem';

import { deployFile, targetOf } from './lib/networks.js';
import { settled } from './lib/settle.js';

type DeployReportedFeed = {
  symbol: string;
  description: string;
  maxMoveBps: number;
  months: Array<{ symbol: string; rollAt: string | null }>;
};

const ROLL_NOTICE_SEC = 86_400;
const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
/** As packages/shared's reportedSource(): the feed's `source` names the month the keeper reads. */
const sourceOf = (symbol: string) => `Yahoo Finance ${symbol} (delayed)`;

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const target = targetOf(chainId);
const feeds = JSON.parse(readFileSync(deployFile(target, 'reported-feeds.json'), 'utf8')) as DeployReportedFeed[];
const reporter = (env('REPORTER_ADDRESS') ?? env('KEEPER_ADDRESS') ?? deployer.account.address) as Address;
const owner = (env('OWNER_ADDRESS') ?? deployer.account.address) as Address;

/** Mined, and visible to the next call (lib/settle.ts). */
const mined = (hash: Promise<Hex>): Promise<void> => settled(publicClient, hash);

console.log(`Deploying ${feeds.length} reported agri feeds to ${target.name} (chain ${chainId}) from ${deployer.account.address}; reporter ${reporter}`);
const now = Math.floor(Date.now() / 1000);
const deployed: Array<{ symbol: string; feed: Address; month: string }> = [];

for (const f of feeds) {
  const month = f.months.find((m) => !m.rollAt || Date.parse(m.rollAt) / 1000 > now + ROLL_NOTICE_SEC);
  if (!month) throw new Error(`${f.symbol}: every listed month has rolled — add the next one to the registry`);
  const feed = await viem.deployContract('ReportedRoundFeed', [f.description, sourceOf(month.symbol), f.maxMoveBps, reporter, deployer.account.address]);
  if (owner.toLowerCase() !== deployer.account.address.toLowerCase()) await mined(feed.write.transferOwnership([owner]));
  deployed.push({ symbol: f.symbol, feed: feed.address, month: month.symbol });
  console.log(`  ${f.symbol.padEnd(5)} ${feed.address}  on ${month.symbol}`);
}

const record = { chainId, reporter, owner, feeds: deployed, deployedAt: new Date().toISOString() };
mkdirSync(new URL('../deployments/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../deployments/${chainId}-reported.json`, import.meta.url), `${JSON.stringify(record, null, 2)}\n`);

const registry =
  target.network === 'robinhood'
    ? `1. Put each address in packages/shared/src/perps.ts as the market's reported \`roundFeed\`:
${deployed.map((d) => `     ${d.symbol}: roundFeed: '${d.feed}',`).join('\n')}`
    : `1. Put them in packages/shared/src/perps.ts, NETWORK_REPORTED_FEEDS[${chainId}]:
     ${chainId}: { ${deployed.map((d) => `${d.symbol}: '${d.feed}'`).join(', ')} },
   (or, for a testnet, in the app's environment:
     ${target.envPrefix}REPORTED_FEEDS=${JSON.stringify(Object.fromEntries(deployed.map((d) => [d.symbol, d.feed])))} )`;
if (process.env.LAUNCHING !== 'true') console.log(`
Record: deployments/${chainId}-reported.json. Next:
${registry}
   The keeper then posts a round as each market trades.
2. List the markets once each feed has a round:
     FEEDS=reported npx hardhat run scripts/list-agri-markets.ts --network ${target.hardhatName}`);
