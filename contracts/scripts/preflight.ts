/**
 * Read-only readiness check for a live deployment — no key needed. Run it
 * before scripts/deploy.ts, which runs the same checks again and refuses to
 * deploy to Robinhood Chain mainnet on any failure:
 *
 *   RPC_URL=https://robinhood.drpc.org npx tsx scripts/preflight.ts
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
 *   CHAINLINK_DIRECTORY_URL Chainlink's feed list for the chain (default: Robinhood Chain mainnet's)
 */
import { createPublicClient, http, type PublicClient } from 'viem';

import { preflight, printChecks } from './lib/preflight.js';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const rpc = env('RPC_URL');
if (!rpc) throw new Error('Set RPC_URL to the chain to check, e.g. RPC_URL=https://robinhood.drpc.org');
const client = createPublicClient({ transport: http(rpc, { timeout: 20_000 }) }) as PublicClient;
const chainId = await client.getChainId();
const mainnet = chainId === 4663;

console.log(`Preflight on chain ${chainId} via ${new URL(rpc).host}\n`);
const checks = await preflight({
  client,
  mainnet,
  feeds: !mainnet && env('ALLOW_MOCK_FEEDS') === 'true' ? 'mock' : 'chainlink',
  usdc: env('USDC_ADDRESS'),
  owner: env('OWNER_ADDRESS'),
  deployer: env('DEPLOYER_ADDRESS'),
  keeper: env('KEEPER_ADDRESS'),
  minExecutionFeeWei: env('MIN_EXECUTION_FEE_WEI'),
  maxOiUsd: env('MAX_OI_USD'),
  seedUsdc: env('SEED_LIQUIDITY_USDC'),
  directoryUrl: env('CHAINLINK_DIRECTORY_URL'),
});
if (!printChecks(checks)) process.exitCode = 1;
