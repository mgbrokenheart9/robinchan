/**
 * Deploys a TwapRoundFeed for each RH Token with a Uniswap V2 or V3 pool, from
 * deploy/twap-feeds.json — generated from the app's registry by
 * `npx tsx scripts/perps-markets.mts` at the repo root.
 *
 *   npx hardhat run scripts/deploy-twap-feeds.ts --network rhMainnet
 *   ONLY=CASHCAT npx hardhat run scripts/deploy-twap-feeds.ts --network rhMainnet
 *
 * Each feed reads its pool's own cumulative price (a V3 pool's, its tick): the keeper calls
 * `update()` once a minute (anyone may), and a round — the 15-minute average,
 * in USD through Chainlink's ETH/USD — lands each minute once a window of
 * history is on record. Rounds answer 0 while the pool holds less than
 * `minLiquidityUsd` ($500k): a pool under the floor gets a feed, never a price.
 * The markets open once scripts/list-agri-markets.ts (FEEDS=twap) lists them.
 *
 * Before this: check the pool on chain (reserves, `price0CumulativeLast`
 * moving) and MAINNET.md §13.
 *
 * Environment:
 *   ONLY           Comma-separated symbols to deploy (default: all in the file).
 *   OWNER_ADDRESS  Who owns the feeds (sets the liquidity floor). Default: the deployer.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { network } from 'hardhat';
import { parseEther, type Address, type Hex } from 'viem';

type DeployTwapFeed = {
  symbol: string;
  description: string;
  token: Address;
  pair: Address;
  kind: 0 | 1;
  source: string;
  quoteUsdFeed: Address;
  windowSec: number;
  granularitySec: number;
  maxStalenessSec: number;
  quoteFeedMaxAgeSec: number;
  minLiquidityUsd: number;
};

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const only = env('ONLY')?.split(',').map((s) => s.trim().toUpperCase());
const feeds = (JSON.parse(readFileSync(new URL('../deploy/twap-feeds.json', import.meta.url), 'utf8')) as DeployTwapFeed[]).filter(
  (f) => !only || only.includes(f.symbol),
);

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const owner = (env('OWNER_ADDRESS') ?? deployer.account.address) as Address;

async function mined(hash: Promise<Hex>): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${receipt.transactionHash} reverted`);
}

if (!feeds.length) throw new Error('No RH Token feeds to deploy (deploy/twap-feeds.json, ONLY)');
console.log(`Deploying ${feeds.length} TWAP feeds to chain ${chainId} from ${deployer.account.address}; owner ${owner}`);
const deployed: Array<{ symbol: string; feed: Address; pair: Address; liquidityUsd: number }> = [];

for (const f of feeds) {
  const feed = await viem.deployContract('TwapRoundFeed', [
    {
      kind: f.kind,
      pair: f.pair,
      baseToken: f.token,
      quoteUsdFeed: f.quoteUsdFeed,
      window: f.windowSec,
      granularity: f.granularitySec,
      maxStaleness: f.maxStalenessSec,
      quoteFeedMaxAge: f.quoteFeedMaxAgeSec,
      minLiquidityUsd: parseEther(String(f.minLiquidityUsd)),
      description: f.description,
      source: f.source,
    },
    deployer.account.address,
  ]);
  // The first observation now: the first round lands a window later.
  await mined(feed.write.update());
  if (owner.toLowerCase() !== deployer.account.address.toLowerCase()) await mined(feed.write.transferOwnership([owner]));
  const liquidityUsd = Number(await feed.read.liquidityUsd()) / 1e18;
  deployed.push({ symbol: f.symbol, feed: feed.address, pair: f.pair, liquidityUsd });
  const floor = f.minLiquidityUsd;
  console.log(
    `  ${f.symbol.padEnd(6)} ${feed.address}  ${f.source}: $${Math.round(liquidityUsd).toLocaleString('en-US')} in the pool${
      liquidityUsd < floor ? ` — under the $${floor.toLocaleString('en-US')} floor, so its rounds answer 0 until it's deeper` : ''
    }`,
  );
}

const record = { chainId, owner, feeds: deployed, deployedAt: new Date().toISOString() };
mkdirSync(new URL('../deployments/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../deployments/${chainId}-twap.json`, import.meta.url), `${JSON.stringify(record, null, 2)}\n`);

console.log(`
Record: deployments/${chainId}-twap.json. Next:
1. Put each address in packages/shared/src/perps.ts, TWAP_ROUND_FEEDS:
${deployed.map((d) => `     ${d.symbol}: '${d.feed}',`).join('\n')}
   and deploy the worker: its keeper calls update() — every minute while an
   order waits, every 16 while the market's quiet.
2. Once each feed has a round priced above 0 (16–30 minutes on), list the
   markets (5×, the $10 launch cap a side; set-markets.ts raises it, up to $10,000):
     FEEDS=twap npx hardhat run scripts/list-agri-markets.ts --network ${chainId === 4663 ? 'rhMainnet' : chainId === 31337 ? 'localhost' : '<network>'}`);
