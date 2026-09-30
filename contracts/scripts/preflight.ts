/**
 * Read-only readiness check for a live deployment — no key needed. Run it
 * before scripts/deploy.ts, which runs the same checks again and refuses to
 * deploy to Robinhood Chain mainnet on any failure:
 *
 *   RPC_URL=https://robinhood.drpc.org npx tsx scripts/preflight.ts
 *   RPC_URL=https://base-rpc.publicnode.com npx tsx scripts/preflight.ts          (Base)
 *   RPC_URL=https://arbitrum-one-rpc.publicnode.com npx tsx scripts/preflight.ts  (Arbitrum One)
 *
 * The chain id decides which network's markets and Chainlink directory are
 * checked; on Base and Arbitrum, USDC_ADDRESS defaults to Circle's USDC.
 *
 * Environment (the same as deploy.ts):
 *   RPC_URL                 the target chain (Robinhood's own RPC is blocked by
 *                           Indonesian ISPs; a provider's works)
 *   USDC_ADDRESS            the settlement stablecoin
 *   OWNER_ADDRESS           the Safe that will own the contracts
 *   DEPLOYER_ADDRESS        the account that will deploy (checks its balances)
 *   KEEPER_ADDRESS          the worker's keeper account (it only needs gas)
 *   MIN_EXECUTION_FEE_WEI   paid by every order to whoever executes it
 *   MAX_OI_USD              open-interest cap per side per market at launch
 *   SEED_LIQUIDITY_USDC     the pool's first liquidity, from the deployer
 *   ALLOW_MOCK_FEEDS        testnet only: MockAggregators instead of Chainlink
 *   SINGLE_KEY              true: one wallet deploys, owns and keeps (no Safe) — see lib/preflight.ts
 *   CHAINLINK_DIRECTORY_URL Chainlink's feed list for the chain (default: Robinhood Chain mainnet's)
 */
import { createPublicClient, http, type PublicClient } from 'viem';

import { readFileSync } from 'node:fs';

import { deployFile, targetOf } from './lib/networks.js';
import { preflight, printChecks, type DeployMarket } from './lib/preflight.js';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const rpc = env('RPC_URL');
if (!rpc) throw new Error('Set RPC_URL to the chain to check, e.g. RPC_URL=https://robinhood.drpc.org');
// Public endpoints rate-limit bursts (dRPC's free tier refuses some parallel reads): retry with backoff.
const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 6, retryDelay: 1_500 }) }) as PublicClient;
const chainId = await client.getChainId();
const target = targetOf(chainId);
const mainnet = target.mainnet;

console.log(`Preflight on ${target.name} (chain ${chainId}) via ${new URL(rpc).host}\n`);
const checks = await preflight({
  client,
  mainnet,
  network: target.name,
  markets: JSON.parse(readFileSync(deployFile(target, 'markets.json'), 'utf8')) as DeployMarket[],
  feeds: !mainnet && env('ALLOW_MOCK_FEEDS') === 'true' ? 'mock' : 'chainlink',
  usdc: env('USDC_ADDRESS') ?? (mainnet ? target.usdc.mainnet : target.usdc.testnet) ?? undefined,
  owner: env('OWNER_ADDRESS'),
  deployer: env('DEPLOYER_ADDRESS'),
  keeper: env('KEEPER_ADDRESS'),
  singleKey: env('SINGLE_KEY') === 'true',
  minExecutionFeeWei: env('MIN_EXECUTION_FEE_WEI'),
  maxOiUsd: env('MAX_OI_USD'),
  seedUsdc: env('SEED_LIQUIDITY_USDC'),
  directoryUrl: env('CHAINLINK_DIRECTORY_URL') ?? (mainnet ? target.chainlinkDirectory : undefined),
});
if (!printChecks(checks)) process.exitCode = 1;
