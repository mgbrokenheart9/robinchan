import type { Address, Hex } from 'viem';

/**
 * Owner-only calls go out with the deployer key while it still owns the
 * contracts — or, once they belong to the Safe (SAFE_TX=true), are printed
 * for the Safe's signers instead: the address and calldata to paste into the
 * Safe's transaction builder ("custom data"). The deployer key is still what
 * Hardhat connects with, but it signs nothing in that mode.
 */
export const safeMode = (): boolean => process.env.SAFE_TX?.trim() === 'true';

export async function ownerCall(opts: {
  what: string;
  to: Address;
  data: Hex;
  send: () => Promise<Hex>;
  wait: (hash: Hex) => Promise<unknown>;
}): Promise<void> {
  if (safeMode()) {
    console.log(`${opts.what}\n  Safe transaction → to: ${opts.to}\n                     value: 0\n                     data: ${opts.data}`);
    return;
  }
  const hash = await opts.send();
  await opts.wait(hash);
  console.log(`${opts.what} (tx ${hash})`);
}
