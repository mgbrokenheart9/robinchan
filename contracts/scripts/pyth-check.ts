/**
 * The Pyth contract on Robinhood Chain, checked the way PythRoundFeed uses it,
 * with real Hermes updates and read-only calls (nothing is sent, no gas spent):
 *
 *   - a slot's first print parses with the uniqueness check on;
 *   - a later print (its predecessor already in the slot) is refused;
 *   - the same later print parses once the slot starts at it;
 *   - what parsing one update costs in gas (a push's main cost).
 *
 * Read-only calls rather than a fork: dRPC's free tier serves only the latest
 * state, and a fork reads state at a pinned block.
 *
 *   PYTH_API_KEY=… npx tsx scripts/pyth-check.ts
 *
 * Environment:
 *   PYTH_API_KEY     Hermes key (the plan must cover the feed).
 *   PYTH_FEED_ID     Default BTC/USD — coffee, cocoa and sugar need the commodities plan.
 *   RH_RPC_URL       Default https://robinhood.drpc.org.
 */
import { createPublicClient, encodeFunctionData, http, maxUint64, type Hex } from 'viem';

const PYTH = '0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a';
const BTC = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const HERMES = 'https://hermes.pyth.network';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const key = env('PYTH_API_KEY');
if (!key) throw new Error('PYTH_API_KEY is required: Hermes answers 401 without one.');
const feedId = (env('PYTH_FEED_ID') ?? BTC) as Hex;

const PYTH_ABI = [
  {
    type: 'function',
    name: 'parsePriceFeedUpdatesWithConfig',
    stateMutability: 'payable',
    inputs: [
      { name: 'updateData', type: 'bytes[]' },
      { name: 'priceIds', type: 'bytes32[]' },
      { name: 'minAllowedPublishTime', type: 'uint64' },
      { name: 'maxAllowedPublishTime', type: 'uint64' },
      { name: 'checkUniqueness', type: 'bool' },
      { name: 'checkUpdateDataIsMinimal', type: 'bool' },
      { name: 'storeUpdatesIfFresh', type: 'bool' },
    ],
    outputs: [
      {
        name: 'priceFeeds',
        type: 'tuple[]',
        components: [
          { name: 'id', type: 'bytes32' },
          { name: 'price', type: 'tuple', components: [{ name: 'price', type: 'int64' }, { name: 'conf', type: 'uint64' }, { name: 'expo', type: 'int32' }, { name: 'publishTime', type: 'uint256' }] },
          { name: 'emaPrice', type: 'tuple', components: [{ name: 'price', type: 'int64' }, { name: 'conf', type: 'uint64' }, { name: 'expo', type: 'int32' }, { name: 'publishTime', type: 'uint256' }] },
        ],
      },
      { name: 'slots', type: 'uint64[]' },
    ],
  },
  { type: 'function', name: 'version', stateMutability: 'pure', inputs: [], outputs: [{ type: 'string' }] },
] as const;

type HermesUpdate = { data: Hex; publishTime: bigint; prevPublishTime: bigint };

async function hermesAt(t: bigint): Promise<HermesUpdate> {
  const res = await fetch(`${HERMES}/v2/updates/price/${t}?ids[]=${feedId}&parsed=true`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Hermes ${res.status} for ${t}: ${(await res.text()).slice(0, 120)}`);
  const body = (await res.json()) as {
    binary: { data: string[] };
    parsed: Array<{ price: { publish_time: number }; metadata: { prev_publish_time: number } }>;
  };
  const p = body.parsed[0]!;
  return { data: `0x${body.binary.data[0]}` as Hex, publishTime: BigInt(p.price.publish_time), prevPublishTime: BigInt(p.metadata.prev_publish_time) };
}

const client = createPublicClient({ transport: http(env('RH_RPC_URL') ?? 'https://robinhood.drpc.org', { timeout: 20_000 }) });
console.log(`Pyth ${PYTH} on Robinhood Chain, version ${await client.readContract({ address: PYTH, abi: PYTH_ABI, functionName: 'version' })}`);

async function parse(u: HermesUpdate, minPublishTime: bigint) {
  const { result } = await client.simulateContract({
    address: PYTH,
    abi: PYTH_ABI,
    functionName: 'parsePriceFeedUpdatesWithConfig',
    args: [[u.data], [feedId], minPublishTime, maxUint64, true, false, false],
  });
  return result[0][0]!;
}

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};

const slotStart = (BigInt(Math.floor(Date.now() / 1000)) / 60n) * 60n - 120n;
const first = await hermesAt(slotStart);
const feed = await parse(first, slotStart);
check(feed.price.publishTime === first.publishTime && first.prevPublishTime < slotStart, `the slot’s first print parses (publish ${first.publishTime}, prev ${first.prevPublishTime})`);

const later = await hermesAt(slotStart + 5n);
let refused = false;
try {
  await parse(later, slotStart);
} catch {
  refused = true;
}
check(refused, `a later print (publish ${later.publishTime}, prev ${later.prevPublishTime}) is refused for that slot`);
check((await parse(later, later.publishTime)).price.publishTime === later.publishTime, 'the same print parses as the first of a slot starting at it');

const gas = await client.estimateGas({
  to: PYTH,
  data: encodeFunctionData({ abi: PYTH_ABI, functionName: 'parsePriceFeedUpdatesWithConfig', args: [[first.data], [feedId], slotStart, maxUint64, true, false, false] }),
});
const gasPrice = await client.getGasPrice();
console.log(`  parse gas ${gas}, at ${Number(gasPrice) / 1e9} gwei ≈ ${(Number(gas * gasPrice) / 1e18).toFixed(9)} ETH`);

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed on the real Pyth contract.');
process.exitCode = failures ? 1 : 0;
