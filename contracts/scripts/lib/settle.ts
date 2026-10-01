import type { Hex } from 'viem';

type Client = {
  waitForTransactionReceipt: (args: { hash: Hex; timeout?: number }) => Promise<{ status: string; blockNumber: bigint; transactionHash: Hex }>;
  getBlockNumber: (args?: { cacheTime?: number }) => Promise<bigint>;
};

/**
 * A transaction mined — and visible. Public endpoints sit behind load
 * balancers: the next call can reach a node a block or two behind the one
 * that returned the receipt, and see the chain as if the transaction hadn't
 * happened (on Base, 2026-10-01: `listMarket` reverted FeedNotListed right
 * after `listFeed` was mined). So this also waits until the endpoint
 * answers with a block past the receipt's, then a moment more.
 */
export async function settled(client: Client, hash: Hex | Promise<Hex>): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash: await hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`transaction ${receipt.transactionHash} reverted`);
  for (let i = 0; i < 30; i += 1) {
    const head = await client.getBlockNumber({ cacheTime: 0 }).catch(() => 0n);
    if (head > receipt.blockNumber) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await new Promise((r) => setTimeout(r, 1_500));
}
