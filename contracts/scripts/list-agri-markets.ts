/**
 * Opens the agri and RH Token markets: lists each deployed round feed on
 * AgriFeed and its market on AgriPerp — once the feed has a round (AgriFeed
 * refuses a feed without a price). Run by the owner of the perps contracts,
 * after the feeds' deploy script and once the keeper is posting rounds.
 *
 *   npx hardhat run scripts/list-agri-markets.ts --network rhMainnet
 *   FEEDS=pyth npx hardhat run scripts/list-agri-markets.ts --network rhMainnet
 *   FEEDS=twap npx hardhat run scripts/list-agri-markets.ts --network rhMainnet
 *   npx hardhat run scripts/list-agri-markets.ts --network base      (Base's agri markets)
 *   npx hardhat run scripts/list-agri-markets.ts --network arbitrum
 *
 * Reads deployments/{chainId}.json (the perps contracts) and
 * deployments/{chainId}-{FEEDS}.json (the feeds). A market already listed is
 * skipped; a feed with no round yet is left for a later run.
 *
 * Environment:
 *   FEEDS        reported (default: the operator's, from Yahoo Finance), pyth,
 *                or twap (the RH Tokens, priced by their Uniswap V2/V3 pools).
 *   MAX_OI_USD   Open-interest cap per side per market at launch (default 10,
 *                like the other markets' launch caps); the owner raises it later
 *                with set-markets.ts — for an RH Token, to the brief's $10,000 at
 *                most, which then caps one position too.
 *
 * An RH Token's feed is listed only while its latest round prices it: a pool
 * under the $500k floor answers 0, and stays unlisted.
 */
import { readFileSync } from 'node:fs';

import { network } from 'hardhat';
import { keccak256, parseUnits, toBytes, type Address, type Hex } from 'viem';

import { targetOf } from './lib/networks.js';

const kind = process.env.FEEDS?.trim() || 'reported';
if (kind !== 'reported' && kind !== 'pyth' && kind !== 'twap') throw new Error('FEEDS is reported, pyth or twap');

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as T;

const target = targetOf(chainId);
if (target.network !== 'robinhood' && kind !== 'reported') throw new Error(`${target.name} has only the operator's agri feeds (FEEDS=reported)`);

const perps = read<{ feed: Address; perp: Address }>(`../deployments/${chainId}.json`);
const deployed = read<{ feeds: Array<{ symbol: string; feed: Address }> }>(`../deployments/${chainId}-${kind}.json`);
// Each network's own terms: deploy/base/reported-feeds.json on Base (Multichain brief).
const terms = read<Array<{ symbol: string; maxLeverage: number }>>(`../deploy/${target.dir}${kind}-feeds.json`);
const maxOi = parseUnits(process.env.MAX_OI_USD?.trim() || '10', 6);

const agriFeed = await viem.getContractAt('AgriFeed', perps.feed);
const agriPerp = await viem.getContractAt('AgriPerp', perps.perp);

async function mined(hash: Promise<Hex>): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${receipt.transactionHash} reverted`);
}

for (const { symbol, feed } of deployed.feeds) {
  const rounds =
    kind === 'pyth'
      ? await (await viem.getContractAt('PythRoundFeed', feed)).read.roundCount()
      : kind === 'twap'
        ? await (await viem.getContractAt('TwapRoundFeed', feed)).read.roundCount()
        : await (await viem.getContractAt('ReportedRoundFeed', feed)).read.roundCount();
  const market = keccak256(toBytes(symbol));
  if (rounds === 0n) {
    console.log(
      `  ${symbol}: no round yet — ${
        kind === 'pyth'
          ? 'the keeper pushes once Hermes serves the feed (PYTH_API_KEY on the commodities plan)'
          : kind === 'twap'
            ? 'the first 15-minute average lands a window after the keeper starts calling update()'
            : 'the keeper posts once its market trades and the feed is in the registry'
      }`,
    );
    continue;
  }
  if (kind === 'twap') {
    const twap = await viem.getContractAt('TwapRoundFeed', feed);
    const [, answer] = await twap.read.latestRoundData();
    if (answer <= 0n) {
      const liquidity = Number(await twap.read.liquidityUsd()) / 1e18;
      console.log(`  ${symbol}: its latest average priced nothing — the pool holds $${Math.round(liquidity).toLocaleString('en-US')} (under its floor), or the rounds stopped. Not listed.`);
      continue;
    }
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
