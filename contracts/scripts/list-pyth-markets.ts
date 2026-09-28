/**
 * Opens the Pyth agri markets: lists each deployed PythRoundFeed on AgriFeed
 * and its market on AgriPerp — once the feed has a round (AgriFeed refuses a
 * feed without a price). Run by the owner of the perps contracts, after
 * scripts/deploy-pyth-feeds.ts and once the keeper is pushing rounds.
 *
 *   npx hardhat run scripts/list-pyth-markets.ts --network rhMainnet
 *
 * Reads deployments/{chainId}.json (the perps contracts) and
 * deployments/{chainId}-pyth.json (the feeds). A market already listed is
 * skipped; a feed with no round yet is left for a later run.
 *
 * Environment:
 *   MAX_OI_USD   Open-interest cap per side per market at launch (default 10,
 *                like the other markets' launch caps); the owner raises it later.
 */
import { readFileSync } from 'node:fs';

import { network } from 'hardhat';
import { keccak256, parseUnits, toBytes, type Address, type Hex } from 'viem';

type DeployPythFeed = { symbol: string; maxLeverage: number };

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../deployments/${file}`, import.meta.url), 'utf8')) as T;

const perps = read<{ feed: Address; perp: Address }>(`${chainId}.json`);
const pyth = read<{ feeds: Array<{ symbol: string; feed: Address }> }>(`${chainId}-pyth.json`);
const terms = JSON.parse(readFileSync(new URL('../deploy/pyth-feeds.json', import.meta.url), 'utf8')) as DeployPythFeed[];
const maxOi = parseUnits(process.env.MAX_OI_USD?.trim() || '10', 6);

const agriFeed = await viem.getContractAt('AgriFeed', perps.feed);
const agriPerp = await viem.getContractAt('AgriPerp', perps.perp);

async function mined(hash: Promise<Hex>): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${receipt.transactionHash} reverted`);
}

for (const { symbol, feed } of pyth.feeds) {
  const round = await viem.getContractAt('PythRoundFeed', feed);
  const rounds = await round.read.roundCount();
  const market = keccak256(toBytes(symbol));
  if (rounds === 0n) {
    console.log(`  ${symbol}: no round yet — the keeper pushes once Hermes serves the feed (PYTH_API_KEY on the commodities plan)`);
    continue;
  }
  if (!(await agriFeed.read.isListed([market]))) {
    await mined(agriFeed.write.listFeed([symbol, feed]));
    console.log(`  ${symbol}: feed listed (${feed})`);
  }
  const listed = (await agriPerp.read.markets([market]))[0];
  if (!listed) {
    const leverage = terms.find((t) => t.symbol === symbol)?.maxLeverage ?? 5;
    await mined(agriPerp.write.listMarket([symbol, leverage, maxOi, 0n]));
    console.log(`  ${symbol}: market listed, up to ${leverage}×, open interest capped at $${Number(maxOi) / 1e6} per side`);
  } else {
    console.log(`  ${symbol}: already listed`);
  }
}
