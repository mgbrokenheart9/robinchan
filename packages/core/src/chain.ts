import { explorerTxUrl, type ChainConfig } from '@robinchan/shared';
import { createPublicClient, defineChain, http, type PublicClient } from 'viem';

import { chainConfig } from './env';

/**
 * Server-side chain access: reads only. The server never holds a key that
 * can sign (brief §1) — everything here is balance reads, gas estimates,
 * quotes, and receipt lookups.
 */

let cached: { key: string; client: PublicClient } | null = null;
let override: PublicClient | null = null;

/**
 * Tests only: stand a scripted chain in for the RPC, so the transaction
 * lifecycle (pending, mined, reverted, replaced) can be exercised without a
 * node. Pass null to restore.
 */
export function setPublicClientForTests(client: PublicClient | null): void {
  override = client;
}

export function viemChain(config: ChainConfig) {
  return defineChain({
    id: config.id,
    name: config.name,
    nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: config.explorerUrl
      ? { default: { name: 'Explorer', url: config.explorerUrl } }
      : undefined,
    contracts: {
      // Multicall3 is deployed at the same address on nearly every EVM chain,
      // Arbitrum Orbit chains included. When it isn't, multicall() fails and
      // callers fall back to one read per token.
      multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    },
  });
}

export function publicClient(): PublicClient | null {
  if (override) return override;
  const config = chainConfig();
  if (!config) return null;
  const key = `${config.id}:${config.rpcUrl}`;
  if (cached?.key !== key) {
    cached = {
      key,
      client: createPublicClient({
        chain: viemChain(config),
        transport: http(config.rpcUrl, { timeout: 8_000, retryCount: 1 }),
      }) as PublicClient,
    };
  }
  return cached.client;
}

export function explorerTx(hash: string | null): string | null {
  return hash ? explorerTxUrl(chainConfig(), hash) : null;
}

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;
