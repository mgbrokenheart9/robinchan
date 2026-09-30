/**
 * Is the wallet ready? Read-only, no key, no password:
 *
 *   npm run wallet:check                       (the Robinchan wallet)
 *   WALLET=0x… npm run wallet:check            (any other)
 *
 * One wallet runs everything (Multichain brief): it deploys, owns the
 * contracts, runs the keeper and posts the agri prices on Robinhood Chain,
 * Base and Arbitrum. This shows its ETH (gas) and USDC (the pool's seed) on
 * each, against what the launch and about a month of keeping need.
 */
import { createPublicClient, formatEther, formatUnits, http, parseAbi, parseEther, parseUnits, type Address } from 'viem';

const WALLET = (process.env.WALLET?.trim() || '0x6c079ff20b77fbbc89fb5c90c5f43cf24166d7d4') as Address;
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

type Chain = {
  name: string;
  rpc: string;
  usdc: Address | null;
  /** ETH it should hold: the launch (if any) and about a month of keeper transactions. */
  needEth: string;
  /** USDC for the pool's seed, spent once at launch. */
  needUsdc: string;
  why: string;
};

const CHAINS: Chain[] = [
  {
    name: 'Robinhood Chain',
    rpc: 'https://robinhood.drpc.org',
    usdc: null,
    needEth: '0.02',
    needUsdc: '0',
    why: 'the live keeper: orders, liquidations, agri prices, RH Token averages',
  },
  {
    name: 'Base',
    rpc: 'https://base-rpc.publicnode.com',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    needEth: '0.005',
    needUsdc: '10',
    why: 'the launch (~0.0002 ETH) and the keeper',
  },
  {
    name: 'Arbitrum',
    rpc: 'https://arbitrum-one-rpc.publicnode.com',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    needEth: '0.01',
    needUsdc: '10',
    why: 'the launch (~0.0005 ETH) and the keeper',
  },
];

console.log(`Wallet ${WALLET}\n`);
let ready = true;
for (const c of CHAINS) {
  const client = createPublicClient({ transport: http(c.rpc, { retryCount: 3, timeout: 20_000 }) });
  try {
    const [eth, usdc] = await Promise.all([
      client.getBalance({ address: WALLET }),
      c.usdc ? client.readContract({ address: c.usdc, abi: ERC20, functionName: 'balanceOf', args: [WALLET] }) : Promise.resolve(null),
    ]);
    const ethOk = eth >= parseEther(c.needEth);
    const usdcOk = usdc == null || usdc >= parseUnits(c.needUsdc, 6);
    ready &&= ethOk && usdcOk;
    const mark = (ok: boolean) => (ok ? 'OK  ' : 'LOW ');
    console.log(`${c.name}`);
    console.log(`  ${mark(ethOk)} ETH  ${Number(formatEther(eth)).toFixed(6)}  (want ${c.needEth} — ${c.why})`);
    if (usdc != null) console.log(`  ${mark(usdcOk)} USDC ${Number(formatUnits(usdc, 6)).toFixed(2)}  (want ${c.needUsdc} — the pool's first liquidity)`);
    if (!ethOk) console.log(`       → send ${(Number(c.needEth) - Number(formatEther(eth))).toFixed(4)} ETH on ${c.name} to ${WALLET}`);
    if (!usdcOk) console.log(`       → send ${c.needUsdc} USDC on ${c.name} to ${WALLET}`);
  } catch (err) {
    ready = false;
    console.log(`${c.name}\n  ?    couldn't read it (${(err as Error).message.split('\n')[0]})`);
  }
  console.log('');
}
console.log(ready ? 'Ready: npm run launch:base, then npm run launch:arbitrum.' : 'Not ready yet: top up what says LOW, then run this again.');
