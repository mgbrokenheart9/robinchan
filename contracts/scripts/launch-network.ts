/**
 * Puts perps on Base or Arbitrum in one run (Multichain brief) — one wallet
 * for everything, one keystore password:
 *
 *   npm run launch:base        (npx hardhat run scripts/launch-network.ts --network base)
 *   npm run launch:arbitrum
 *
 * It deploys the stack (AgriFeed, AgriVault, AgriPerp) listing Chainlink's
 * gold and silver (and oil on Arbitrum), seeds the pool, then deploys the
 * four agri feeds, and prints the settings for Vercel and Railway in one
 * block. The wallet is DEPLOYER_PRIVATE_KEY from the keystore: it deploys,
 * owns the contracts, runs the keeper (KEEPER_PRIVATE_KEY on Railway is the
 * same key) and posts the agri prices (SINGLE_KEY).
 *
 * Defaults, each overridable from the environment: SEED_LIQUIDITY_USDC=10
 * (from the wallet's USDC on that chain), MAX_OI_USD=10 per side per market,
 * MIN_EXECUTION_FEE_WEI 0.000005 ETH on Base, 0.00001 ETH on Arbitrum.
 * The preflight runs first and nothing is sent if it fails (e.g. too little
 * ETH or USDC on the chain).
 *
 * Refuses Robinhood Chain (it stays as deployed) and a chain that already has
 * a deployment record (FORCE=true to deploy again).
 */
import { existsSync, readFileSync } from 'node:fs';

import { network } from 'hardhat';

import { targetOf } from './lib/networks.js';

const conn = await network.create();
const chainId = await (await conn.viem.getPublicClient()).getChainId();
const target = targetOf(chainId);
if (target.network === 'robinhood') throw new Error('Robinhood Chain stays as deployed: launch-network.ts is for Base and Arbitrum.');
const record = new URL(`../deployments/${chainId}.json`, import.meta.url);
/** AGRI=false: gold, silver (and oil) only — no agri feeds, so no keeper gas for their prices. */
const withAgri = process.env.AGRI?.trim() !== 'false';
/** ADD_AGRI=true: the stack is already there; only its agri feeds now. */
const addAgri = process.env.ADD_AGRI?.trim() === 'true';
if (addAgri && !existsSync(record)) throw new Error(`${target.name} has no deployment yet: run the launch first.`);
if (!addAgri && existsSync(record) && process.env.FORCE?.trim() !== 'true') {
  throw new Error(`${target.name} already has a deployment (deployments/${chainId}.json). FORCE=true deploys a second one; ADD_AGRI=true adds its agri feeds.`);
}

const defaults: Record<string, string> = {
  SINGLE_KEY: 'true',
  SEED_LIQUIDITY_USDC: '10',
  MAX_OI_USD: '10',
  MIN_EXECUTION_FEE_WEI: target.network === 'base' ? '5000000000000' : '10000000000000',
};
for (const [name, value] of Object.entries(defaults)) if (!process.env[name]?.trim()) process.env[name] = value;
// The scripts below skip their own "next steps": the summary at the end has them.
process.env.LAUNCHING = 'true';

if (!addAgri) {
  console.log(`\n=== The perps contracts on ${target.name} ===\n`);
  await import('./deploy.js');
}
if (withAgri || addAgri) {
  console.log(`\n=== The agri price feeds on ${target.name} ===\n`);
  await import('./deploy-reported-feeds.js');
}

const stack = JSON.parse(readFileSync(record, 'utf8')) as { feed: string; vault: string; perp: string; usdc: string; owner: string; block: number };
const p = target.envPrefix;
let reported = '';
if (withAgri || addAgri) {
  const feeds = JSON.parse(readFileSync(new URL(`../deployments/${chainId}-reported.json`, import.meta.url), 'utf8')) as {
    feeds: Array<{ symbol: string; feed: string }>;
  };
  reported = JSON.stringify(Object.fromEntries(feeds.feeds.map((f) => [f.symbol, f.feed])));
}
const bar = '==================================================================';
if (addAgri) {
  console.log(`
${bar}
 Done. Add this one variable in Vercel (web) AND Railway (worker):
${bar}
${p}REPORTED_FEEDS=${reported}
${bar}
Then redeploy both, wait for the keeper's first prices (10–30 minutes while the
exchange is open), and open the markets: npm run list-agri:${target.network}
`);
} else {
  console.log(`
${bar}
 Done. Copy these into Vercel (web) AND Railway (worker) variables:
${bar}
${p}RPC_URL=${target.network === 'base' ? 'https://base-rpc.publicnode.com' : 'https://arbitrum-one-rpc.publicnode.com'}
${p}CHAIN_ID=${chainId}
${p}AGRI_FEED_ADDRESS=${stack.feed}
${p}AGRI_VAULT_ADDRESS=${stack.vault}
${p}AGRI_PERP_ADDRESS=${stack.perp}
${p}AGRI_DEPLOY_BLOCK=${stack.block}
${p}PERPS_EXECUTION_FEE_WEI=${process.env.MIN_EXECUTION_FEE_WEI}${reported ? `
${p}REPORTED_FEEDS=${reported}` : ''}
${bar}
Then redeploy both. ${
    reported
      ? `Gold and silver trade at once; the agri markets open after the keeper's first prices: npm run list-agri:${target.network}`
      : `Gold and silver trade at once. The agri markets stay "coming soon" (no gas spent on them); add them later with: npm run add-agri:${target.network}`
  }

Optional — publish the source on the explorer (no key needed on Blockscout):
npx hardhat verify --network ${target.hardhatName} ${stack.feed} ${stack.owner}
npx hardhat verify --network ${target.hardhatName} ${stack.vault} ${stack.usdc} ${stack.owner}
npx hardhat verify --network ${target.hardhatName} ${stack.perp} ${stack.vault} ${stack.feed} ${stack.owner}
`);
}
