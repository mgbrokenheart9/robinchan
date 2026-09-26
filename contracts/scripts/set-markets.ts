/**
 * Pauses or resumes markets, or changes their caps — the owner's levers in
 * an incident and as the pool grows. Paused markets take no new orders;
 * closes, liquidations and settlement never stop.
 *
 *   MARKETS=ALL ENABLED=false npx hardhat run scripts/set-markets.ts --network rhMainnet
 *   MARKETS=BTC,ETH MAX_OI_USD=100000 npx hardhat run scripts/set-markets.ts --network rhMainnet
 *
 * MARKETS      comma-separated symbols, or ALL (every listed market)
 * ENABLED      true | false; unset keeps each market's current state
 * MAX_OI_USD   new open-interest cap per side; unset keeps the current one
 * MAX_LEVERAGE new leverage cap; unset keeps the current one
 * SAFE_TX=true prints one Safe transaction per market instead of sending.
 */
import { readFileSync } from 'node:fs';

import { network } from 'hardhat';
import { encodeFunctionData, formatUnits, keccak256, parseUnits, toBytes, type Address } from 'viem';

import { ownerCall } from './lib/owner-call.js';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const wanted = env('MARKETS');
if (!wanted) throw new Error('Set MARKETS, e.g. MARKETS=ALL or MARKETS=BTC,ETH');
const enabled = env('ENABLED');
if (enabled && enabled !== 'true' && enabled !== 'false') throw new Error('ENABLED is true or false');
const maxOiUsd = env('MAX_OI_USD');
const maxLeverage = env('MAX_LEVERAGE');
if (!enabled && !maxOiUsd && !maxLeverage) throw new Error('Nothing to change: set ENABLED, MAX_OI_USD and/or MAX_LEVERAGE');

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployment = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), 'utf8')) as {
  perp: Address;
  markets: Array<{ symbol: string }>;
};
const perp = await viem.getContractAt('AgriPerp', deployment.perp);
const symbols = wanted.toUpperCase() === 'ALL' ? deployment.markets.map((m) => m.symbol) : wanted.split(',').map((s) => s.trim().toUpperCase());

for (const symbol of symbols) {
  const market = keccak256(toBytes(symbol));
  // listed, enabled, delisted, maxLeverage, fundingUpdatedAt, fundingRatePerHour, fundingIndex, longOi, shortOi, maxOi, …
  const m = await perp.read.markets([market]);
  if (!m[0]) {
    console.warn(`${symbol}: not listed, skipped`);
    continue;
  }
  if (m[2]) {
    console.warn(`${symbol}: delisted, skipped`);
    continue;
  }
  const args = [
    market,
    enabled ? enabled === 'true' : m[1],
    maxLeverage ? Number(maxLeverage) : m[3],
    maxOiUsd ? parseUnits(maxOiUsd, 6) : m[9],
  ] as const;
  await ownerCall({
    what: `${symbol}: ${args[1] ? 'open' : 'PAUSED'}, up to ${args[2]}×, cap $${Number(formatUnits(args[3], 6)).toLocaleString('en-US')} per side`,
    to: perp.address,
    data: encodeFunctionData({ abi: perp.abi, functionName: 'setMarket', args }),
    send: () => perp.write.setMarket(args),
    wait: (hash) => publicClient.waitForTransactionReceipt({ hash }),
  });
}
