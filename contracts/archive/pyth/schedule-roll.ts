/**
 * Announces an agri market's move to its next futures month (the owner's
 * job; the app's servers hold no admin key). AgriFeed needs at least a day's
 * notice; when the time comes, the worker's keeper carries the roll out with
 * the first price of each month published after it — nobody picks the
 * prices.
 *
 *   ROLL_SYMBOL=COFF npx hardhat run scripts/schedule-roll.ts --network rhTestnet
 *
 * The time comes from the registry (deploy/markets.json, the contract's
 * `rollAt`); ROLL_AT=2026-11-12T15:00:00Z overrides it. Pick a time when
 * both months trade. A roll not carried out within an hour of its time
 * lapses and has to be announced again. Once a Safe owns the contracts,
 * SAFE_TX=true prints the call for the Safe to sign instead of sending it.
 */
import { readFileSync } from 'node:fs';

import { network } from 'hardhat';
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';

import { ownerCall } from './lib/owner-call.js';

type DeployMarket = { symbol: string; contracts: Array<{ feedId: Hex; pythSymbol: string; rollAt: string | null }> };

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const symbol = env('ROLL_SYMBOL')?.toUpperCase();
if (!symbol) throw new Error('Set ROLL_SYMBOL, e.g. ROLL_SYMBOL=COFF');

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
const deployment = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), 'utf8')) as { feed: Address };
const markets = JSON.parse(readFileSync(new URL('../deploy/markets.json', import.meta.url), 'utf8')) as DeployMarket[];
const market = markets.find((m) => m.symbol === symbol);
if (!market) throw new Error(`${symbol} isn't in deploy/markets.json`);

const feed = await viem.getContractAt('AgriFeed', deployment.feed);
const [current] = await feed.read.feedOf([keccak256(toBytes(symbol))]);
const at = market.contracts.findIndex((c) => c.feedId.toLowerCase() === current.toLowerCase());
const from = market.contracts[at];
const to = market.contracts[at + 1];
if (!from || !to) throw new Error(`${symbol} is on ${current}; the registry lists no contract after it — add the next month first`);

const when = env('ROLL_AT') ?? from.rollAt;
if (!when) throw new Error(`No roll time for ${from.pythSymbol}: set ROLL_AT`);
const notBefore = BigInt(Math.floor(Date.parse(when) / 1000));
await ownerCall({
  what: `${symbol}: roll ${from.pythSymbol} → ${to.pythSymbol} at ${new Date(Number(notBefore) * 1000).toISOString()}`,
  to: feed.address,
  data: encodeFunctionData({ abi: feed.abi, functionName: 'scheduleRoll', args: [symbol, to.feedId, notBefore] }),
  send: () => feed.write.scheduleRoll([symbol, to.feedId, notBefore]),
  wait: (hash) => publicClient.waitForTransactionReceipt({ hash }),
});
