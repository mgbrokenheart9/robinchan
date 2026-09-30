/**
 * Deploys AgriFeed, AgriVault and AgriPerp and lists every market in
 * deploy/markets.json (generated from the app's registry by
 * `npx tsx scripts/perps-markets.mts` at the repo root).
 *
 *   npx hardhat run scripts/deploy.ts --network localhost
 *   npx hardhat run scripts/deploy.ts --network rhTestnet
 *   npx hardhat run scripts/deploy.ts --network rhMainnet   (read MAINNET.md first)
 *   npx hardhat run scripts/deploy.ts --network base        (Multichain brief: MAINNET.md §15)
 *   npx hardhat run scripts/deploy.ts --network arbitrum
 *
 * Each market is listed with its Chainlink Data Feed on the chain — on Base
 * and Arbitrum, the markets in deploy/base/ and deploy/arbitrum/ (gold,
 * silver, oil); their agri markets follow on ReportedRoundFeeds
 * (deploy-reported-feeds.ts, then list-agri-markets.ts). On the local chain — or a testnet with ALLOW_MOCK_FEEDS=true — a
 * MockAggregator per market stands in, and the worker (PERPS_ORACLE=mock)
 * posts live prices into it.
 *
 * Off the local chain it runs scripts/lib/preflight.ts's checks first and
 * stops on any failure — on Robinhood Chain mainnet that includes every feed
 * against Chainlink's directory, a Safe as owner, an execution fee, launch
 * caps and a pool seed.
 *
 * Environment:
 *   USDC_ADDRESS           The settlement stablecoin. On the local chain (or
 *                          a testnet with ALLOW_MOCK_USDC=true) a mintable
 *                          MockUSDC is deployed instead; never on mainnet.
 *                          On Base and Arbitrum, Circle's USDC by default.
 *   SEED_LIQUIDITY_USDC    Pool seed (brief §11 step 5), from the deployer's
 *                          USDC. Default 1,000,000 on MockUSDC, 0 otherwise.
 *   OWNER_ADDRESS          The Safe that owns everything once it's set up.
 *   MIN_EXECUTION_FEE_WEI  Paid by every order to whoever executes it.
 *   MAX_OI_USD             Open-interest cap per side per market (launch caps;
 *                          the Safe raises them later with setMarket).
 *   ALLOW_MOCK_FEEDS       Testnet only: MockAggregators instead of Chainlink.
 *   SINGLE_KEY             true: one wallet deploys, owns and runs the keeper,
 *                          without a Safe (the preflight only warns).
 *   KEEPER_ADDRESS         Checked by the preflight (see lib/preflight.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { network } from 'hardhat';
import { maxUint256, parseUnits, type Address, type Hex, type PublicClient } from 'viem';

import { targetOf, deployFile } from './lib/networks.js';
import { preflight, printChecks } from './lib/preflight.js';

type DeployMarket = {
  symbol: string;
  maxLeverage: number;
  maxOiUsd: number;
  fundingRatePerHour: string;
  feed: { proxy: Address; description: string };
  mockPrice: number;
};

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const target = targetOf(chainId);
const local = target.local;
const mainnet = target.mainnet;
const markets = JSON.parse(readFileSync(deployFile(target, 'markets.json'), 'utf8')) as DeployMarket[];
// Circle's USDC where there is one (Base, Arbitrum), unless the environment names another or a mock is asked for.
const defaultUsdc = mainnet ? target.usdc.mainnet : env('ALLOW_MOCK_USDC') === 'true' || local ? null : target.usdc.testnet;
if (!env('USDC_ADDRESS') && defaultUsdc) process.env.USDC_ADDRESS = defaultUsdc;
const mockFeeds = local || (!mainnet && env('ALLOW_MOCK_FEEDS') === 'true');

async function mined(hash: Promise<Hex>): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${receipt.transactionHash} reverted`);
}

console.log(`Deploying to ${target.name} (chain ${chainId}) from ${deployer.account.address}`);

if (!local) {
  console.log('\nPreflight');
  const passed = printChecks(
    await preflight({
      client: publicClient as unknown as PublicClient,
      mainnet,
      markets,
      network: target.name,
      feeds: mockFeeds ? 'mock' : 'chainlink',
      usdc: env('USDC_ADDRESS'),
      owner: env('OWNER_ADDRESS'),
      deployer: deployer.account.address,
      keeper: env('KEEPER_ADDRESS'),
      singleKey: env('SINGLE_KEY') === 'true',
      minExecutionFeeWei: env('MIN_EXECUTION_FEE_WEI'),
      maxOiUsd: env('MAX_OI_USD'),
      seedUsdc: env('SEED_LIQUIDITY_USDC'),
      directoryUrl: env('CHAINLINK_DIRECTORY_URL') ?? (mainnet ? target.chainlinkDirectory : undefined),
    }),
  );
  if (!passed) throw new Error('Preflight failed: nothing was deployed.');
  console.log('');
}
const startBlock = await publicClient.getBlockNumber();

let usdcAddress = env('USDC_ADDRESS') as Address | undefined;
let mockUsdc = false;
if (!usdcAddress) {
  if (mainnet || (!local && env('ALLOW_MOCK_USDC') !== 'true')) {
    throw new Error('USDC_ADDRESS is required. On a testnet, ALLOW_MOCK_USDC=true deploys a mintable test USDC instead.');
  }
  usdcAddress = (await viem.deployContract('MockUSDC')).address;
  mockUsdc = true;
  console.log(`  MockUSDC   ${usdcAddress} (test collateral)`);
}

const feed = await viem.deployContract('AgriFeed', [deployer.account.address]);
const vault = await viem.deployContract('AgriVault', [usdcAddress, deployer.account.address]);
const perp = await viem.deployContract('AgriPerp', [vault.address, feed.address, deployer.account.address]);
await mined(vault.write.setPerp([perp.address]));
console.log(`  AgriFeed   ${feed.address}\n  AgriVault  ${vault.address}\n  AgriPerp   ${perp.address}`);

// Launch caps: a market's registry cap, or MAX_OI_USD if that's lower.
const maxOiCap = env('MAX_OI_USD') ? Number(env('MAX_OI_USD')) : Infinity;
const listed: Array<{ symbol: string; feed: Address; description: string }> = [];
for (const m of markets) {
  // A local stand-in, starting at the registry's level; the worker keeps it live.
  const proxy = mockFeeds
    ? (await viem.deployContract('MockAggregator', [8, m.feed.description, BigInt(Math.round(m.mockPrice * 1e8))])).address
    : m.feed.proxy;
  await mined(feed.write.listFeed([m.symbol, proxy]));
  const maxOi = Math.min(m.maxOiUsd, maxOiCap);
  await mined(perp.write.listMarket([m.symbol, m.maxLeverage, parseUnits(String(maxOi), 6), BigInt(m.fundingRatePerHour)]));
  listed.push({ symbol: m.symbol, feed: proxy, description: m.feed.description });
}
console.log(
  `  ${listed.length} markets listed${mockFeeds ? ' on MockAggregators' : ' on Chainlink'}: ${listed.map((l) => l.symbol).join(' ')}${
    Number.isFinite(maxOiCap) ? ` (open interest capped at $${maxOiCap.toLocaleString('en-US')} per side)` : ''
  }`,
);

// A minimum execution fee (wei) pays keepers' gas, lets anyone profitably
// execute orders when ours is slow, and makes spamming orders cost something.
// The other execution settings stay at the contract's defaults.
const minExecutionFee = env('MIN_EXECUTION_FEE_WEI');
if (!minExecutionFee && !local) {
  console.warn('  MIN_EXECUTION_FEE_WEI is unset: orders pay executors nothing, so only our keeper will execute them');
}
if (minExecutionFee) {
  const [minDelay, maxDelay, liquidationAge, requestAge] = await Promise.all([
    perp.read.minExecutionDelay(),
    perp.read.maxExecutionDelay(),
    perp.read.liquidationPriceAge(),
    perp.read.requestPriceAge(),
  ]);
  await mined(perp.write.setExecution([minDelay, maxDelay, liquidationAge, requestAge, BigInt(minExecutionFee)]));
  console.log(`  minimum execution fee: ${minExecutionFee} wei`);
}

const seed = parseUnits(env('SEED_LIQUIDITY_USDC') ?? (mockUsdc ? '1000000' : '0'), 6);
if (seed > 0n) {
  // MockUSDC's ABI covers any ERC20's approve; mint only exists on the mock.
  const token = await viem.getContractAt('MockUSDC', usdcAddress);
  if (mockUsdc) await mined(token.write.mint([deployer.account.address, seed]));
  // Exactly the seed on a real token: no allowance left behind.
  await mined(token.write.approve([vault.address, mockUsdc ? maxUint256 : seed]));
  await mined(vault.write.addLiquidity([seed]));
  console.log(`  pool seeded with ${Number(seed) / 1e6} USDC`);
}

const owner = env('OWNER_ADDRESS') as Address | undefined;
if (owner && owner.toLowerCase() !== deployer.account.address.toLowerCase()) {
  await mined(feed.write.transferOwnership([owner]));
  await mined(vault.write.transferOwnership([owner]));
  await mined(perp.write.transferOwnership([owner]));
  console.log(`  ownership moved to ${owner}`);
}

const record = {
  chainId,
  usdc: usdcAddress,
  feed: feed.address,
  vault: vault.address,
  perp: perp.address,
  mockFeeds,
  mockUsdc,
  markets: listed,
  owner: owner ?? deployer.account.address,
  deployedAt: new Date().toISOString(),
  block: Number(startBlock),
};
mkdirSync(new URL('../deployments/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), `${JSON.stringify(record, null, 2)}\n`);

// launch-network.ts prints one summary of its own.
const launching = process.env.LAUNCHING === 'true';
if (launching) console.log(`  record: deployments/${chainId}.json`);
else if (target.network !== 'robinhood') {
  const p = target.envPrefix;
  console.log(`
For the app's .env — ${target.name} runs beside Robinhood Chain, its settings under ${p}
(the worker's KEEPER_PRIVATE_KEY is shared: fund it with ETH on ${target.name} too):
${p}RPC_URL=<a provider's ${target.name} endpoint>
${p}CHAIN_ID=${chainId}
${p}AGRI_FEED_ADDRESS=${feed.address}
${p}AGRI_VAULT_ADDRESS=${vault.address}
${p}AGRI_PERP_ADDRESS=${perp.address}
${p}AGRI_DEPLOY_BLOCK=${record.block}${mockFeeds ? `
${p}PERPS_ORACLE=mock` : ''}${minExecutionFee ? `
${p}PERPS_EXECUTION_FEE_WEI=${minExecutionFee}` : ''}

Next: the agri markets' feeds (MAINNET.md §15):
npx hardhat run scripts/deploy-reported-feeds.ts --network ${target.hardhatName}`);
} else console.log(`
For the app's .env (the worker also needs KEEPER_PRIVATE_KEY to execute orders):
FEATURE_PERPS=true
PERPS_VENUE=agri-perp
AGRI_FEED_ADDRESS=${feed.address}
AGRI_VAULT_ADDRESS=${vault.address}
AGRI_PERP_ADDRESS=${perp.address}
AGRI_DEPLOY_BLOCK=${record.block}${mockFeeds ? '\nPERPS_ORACLE=mock' : ''}${
  mainnet
    ? `
NEXT_PUBLIC_CHAIN_ID=4663
NEXT_PUBLIC_CHAIN_NAME=Robinhood Chain
NEXT_PUBLIC_EXPLORER_URL=https://robinhoodchain.blockscout.com
NEXT_PUBLIC_NATIVE_SYMBOL=ETH`
    : ''
}`);
if (!local && !launching) {
  const net = target.hardhatName;
  console.log(`
Verify the source on the explorer:
npx hardhat verify --network ${net} ${feed.address} ${deployer.account.address}
npx hardhat verify --network ${net} ${vault.address} ${usdcAddress} ${deployer.account.address}
npx hardhat verify --network ${net} ${perp.address} ${vault.address} ${feed.address} ${deployer.account.address}`);
}
