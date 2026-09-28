/**
 * Deploys a PythRoundFeed for each agri market Pyth prices (coffee, cocoa,
 * sugar), from deploy/pyth-feeds.json — generated from the app's registry by
 * `npx tsx scripts/perps-markets.mts` at the repo root.
 *
 *   npx hardhat run scripts/deploy-pyth-feeds.ts --network rhMainnet
 *
 * Each feed starts on the front month (the first whose roll time hasn't
 * passed), with the roll to the next month announced when there is one. The
 * feeds need no Pyth data to deploy; they get rounds once the keeper can read
 * Hermes (PYTH_API_KEY, on a plan that covers commodities), and the markets
 * open once scripts/list-pyth-markets.ts lists them on the perps contracts.
 *
 * Environment:
 *   PYTH_ADDRESS    Default Pyth on Robinhood Chain mainnet (confirmed by Pyth,
 *                   2026-09-26). A local chain gets a TestPyth instead.
 *   PYTH_SLOT_SEC   Seconds between rounds (default 300). Each round is a
 *                   keeper transaction, ~0.000003 ETH on Robinhood Chain.
 *   OWNER_ADDRESS   Who owns the feeds (announces rolls). Default: the deployer —
 *                   with SINGLE_KEY the keeper then announces rolls itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { network } from 'hardhat';
import { type Address, type Hex } from 'viem';

type DeployPythFeed = {
  symbol: string;
  description: string;
  unitExp: number;
  maxConfBps: number;
  months: Array<{ pythSymbol: string; feedId: Hex; rollAt: string | null }>;
};

const PYTH_MAINNET = '0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a';
const ROLL_NOTICE_SEC = 86_400;

const feeds = JSON.parse(readFileSync(new URL('../deploy/pyth-feeds.json', import.meta.url), 'utf8')) as DeployPythFeed[];
const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const local = chainId === 31337;
const slot = BigInt(env('PYTH_SLOT_SEC') ?? '300');
const owner = (env('OWNER_ADDRESS') ?? deployer.account.address) as Address;

async function mined(hash: Promise<Hex>): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${receipt.transactionHash} reverted`);
}

let pyth = env('PYTH_ADDRESS') as Address | undefined;
if (!pyth) {
  if (chainId === 4663) pyth = PYTH_MAINNET;
  else if (local) pyth = (await viem.deployContract('TestPyth', [60n, 0n])).address;
  else throw new Error('PYTH_ADDRESS is required off Robinhood Chain mainnet and the local chain.');
}
if (!(await publicClient.getCode({ address: pyth }))) throw new Error(`no contract at PYTH_ADDRESS ${pyth}`);

console.log(`Deploying ${feeds.length} Pyth round feeds to chain ${chainId} from ${deployer.account.address}, Pyth ${pyth}, a round every ${slot}s`);
const now = Math.floor(Date.now() / 1000);
const deployed: Array<{ symbol: string; feed: Address; month: string; roll: { to: string; at: string } | null }> = [];

for (const f of feeds) {
  // The front month: the first whose roll time is still ahead (or that has none).
  const i = f.months.findIndex((m) => !m.rollAt || Date.parse(m.rollAt) / 1000 > now + ROLL_NOTICE_SEC);
  if (i < 0) throw new Error(`${f.symbol}: every listed month has rolled — add the next one to the registry`);
  const month = f.months[i]!;
  const feed = await viem.deployContract('PythRoundFeed', [
    pyth,
    month.feedId,
    slot,
    f.unitExp,
    f.maxConfBps,
    0n,
    f.description,
    deployer.account.address,
  ]);

  let roll: { to: string; at: string } | null = null;
  const next = f.months[i + 1];
  if (month.rollAt && next) {
    await mined(feed.write.scheduleRoll([next.feedId, BigInt(Math.floor(Date.parse(month.rollAt) / 1000))]));
    roll = { to: next.pythSymbol, at: month.rollAt };
  }
  if (owner.toLowerCase() !== deployer.account.address.toLowerCase()) await mined(feed.write.transferOwnership([owner]));
  deployed.push({ symbol: f.symbol, feed: feed.address, month: month.pythSymbol, roll });
  console.log(`  ${f.symbol.padEnd(5)} ${feed.address}  on ${month.pythSymbol}${roll ? `, rolls to ${roll.to} at ${roll.at}` : ''}`);
}

const record = { chainId, pyth, slot: Number(slot), owner, feeds: deployed, deployedAt: new Date().toISOString() };
mkdirSync(new URL('../deployments/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../deployments/${chainId}-pyth.json`, import.meta.url), `${JSON.stringify(record, null, 2)}\n`);

console.log(`
Record: deployments/${chainId}-pyth.json. Next:
1. Put each address in packages/shared/src/perps.ts as the market's \`roundFeed\`:
${deployed.map((d) => `     ${d.symbol}: roundFeed: '${d.feed}',`).join('\n')}
2. Give the worker PYTH_API_KEY (Railway). Once Hermes serves the feeds (the
   commodities plan), the keeper pushes a round per slot.
3. List the markets once each feed has a round:
     npx hardhat run scripts/list-pyth-markets.ts --network ${local ? 'localhost' : chainId === 4663 ? 'rhMainnet' : '<network>'}`);
