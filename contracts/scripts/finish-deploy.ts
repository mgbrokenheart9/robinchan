/**
 * Finishes a launch that stopped part-way (npm run finish:base): the
 * contracts are deployed, but not every market, the execution fee or the
 * pool seed went through — e.g. an RPC that refused a call mid-deploy. It
 * reads what's already on chain and does only what's missing:
 *
 *   PERP=0x… npm run finish:base       (the AgriPerp the launch deployed)
 *
 * Each market in deploy/<network>/markets.json gets its feed listed on
 * AgriFeed and its market on AgriPerp (MAX_OI_USD, default 10 per side);
 * the minimum execution fee is raised to MIN_EXECUTION_FEE_WEI (default as
 * launch-network.ts); an empty pool gets SEED_LIQUIDITY_USDC (default 2).
 * Then it writes deployments/<chainId>.json and prints the app's settings.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { network } from 'hardhat';
import { getAddress, keccak256, parseUnits, toBytes, type Address } from 'viem';

import { deployFile, targetOf } from './lib/networks.js';
import { settled } from './lib/settle.js';

type DeployMarket = { symbol: string; maxLeverage: number; maxOiUsd: number; fundingRatePerHour: string; feed: { proxy: Address; description: string } };

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const perpAddress = env('PERP');
if (!perpAddress || !/^0x[0-9a-fA-F]{40}$/.test(perpAddress)) throw new Error('Set PERP to the AgriPerp address the launch deployed.');

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const target = targetOf(chainId);
const markets = JSON.parse(readFileSync(deployFile(target, 'markets.json'), 'utf8')) as DeployMarket[];
const mined = (hash: Promise<`0x${string}`>) => settled(publicClient, hash);

const perp = await viem.getContractAt('AgriPerp', getAddress(perpAddress));
const feed = await viem.getContractAt('AgriFeed', await perp.read.feed());
const vault = await viem.getContractAt('AgriVault', await perp.read.vault());
const usdc = await vault.read.usdc();
console.log(`Finishing ${target.name} (chain ${chainId}) from ${owner.account.address}`);
console.log(`  AgriPerp ${perp.address}\n  AgriFeed ${feed.address}\n  AgriVault ${vault.address}\n  USDC ${usdc}`);
if ((await perp.read.owner()).toLowerCase() !== owner.account.address.toLowerCase()) throw new Error('This wallet doesn’t own that AgriPerp.');
if ((await vault.read.perp()).toLowerCase() !== perp.address.toLowerCase()) {
  await mined(vault.write.setPerp([perp.address]));
  console.log('  vault linked to the perp');
}

const maxOiCap = Number(env('MAX_OI_USD') ?? '10');
for (const m of markets) {
  const key = keccak256(toBytes(m.symbol));
  if (!(await feed.read.isListed([key]))) {
    await mined(feed.write.listFeed([m.symbol, m.feed.proxy]));
    console.log(`  ${m.symbol}: feed listed (${m.feed.description})`);
  }
  if (!(await perp.read.markets([key]))[0]) {
    const maxOi = Math.min(m.maxOiUsd, maxOiCap);
    await mined(perp.write.listMarket([m.symbol, m.maxLeverage, parseUnits(String(maxOi), 6), BigInt(m.fundingRatePerHour)]));
    console.log(`  ${m.symbol}: market listed, up to ${m.maxLeverage}×, $${maxOi} per side`);
  } else console.log(`  ${m.symbol}: already listed`);
}

const fee = BigInt(env('MIN_EXECUTION_FEE_WEI') ?? (target.network === 'base' ? '5000000000000' : '10000000000000'));
if ((await perp.read.minExecutionFee()) < fee) {
  const [minDelay, maxDelay, liquidationAge, requestAge] = await Promise.all([
    perp.read.minExecutionDelay(),
    perp.read.maxExecutionDelay(),
    perp.read.liquidationPriceAge(),
    perp.read.requestPriceAge(),
  ]);
  await mined(perp.write.setExecution([minDelay, maxDelay, liquidationAge, requestAge, fee]));
  console.log(`  minimum execution fee: ${fee} wei`);
}

const seed = parseUnits(env('SEED_LIQUIDITY_USDC') ?? '2', 6);
if ((await vault.read.poolBalance()) === 0n && seed > 0n) {
  const token = await viem.getContractAt('MockUSDC', usdc);
  await mined(token.write.approve([vault.address, seed]));
  await mined(vault.write.addLiquidity([seed]));
  console.log(`  pool seeded with ${Number(seed) / 1e6} USDC`);
}

// Nothing has traded yet: the indexer can start a little before now.
const block = Number((await publicClient.getBlockNumber()) - 5_000n);
const record = {
  chainId,
  usdc,
  feed: feed.address,
  vault: vault.address,
  perp: perp.address,
  mockFeeds: false,
  mockUsdc: false,
  markets: markets.map((m) => ({ symbol: m.symbol, feed: m.feed.proxy, description: m.feed.description })),
  owner: owner.account.address,
  deployedAt: new Date().toISOString(),
  block,
};
mkdirSync(new URL('../deployments/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), `${JSON.stringify(record, null, 2)}\n`);

const p = target.envPrefix;
console.log(`
==================================================================
 Done. Copy these into Vercel (web) AND Railway (worker) variables:
==================================================================
${p}RPC_URL=${target.network === 'base' ? 'https://base.gateway.tenderly.co' : 'https://arb1.arbitrum.io/rpc'}
${p}CHAIN_ID=${chainId}
${p}AGRI_FEED_ADDRESS=${feed.address}
${p}AGRI_VAULT_ADDRESS=${vault.address}
${p}AGRI_PERP_ADDRESS=${perp.address}
${p}AGRI_DEPLOY_BLOCK=${block}
${p}PERPS_EXECUTION_FEE_WEI=${fee}
==================================================================`);
