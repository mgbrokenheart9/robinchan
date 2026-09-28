/**
 * The pool traders' profits are paid from: shows it, adds to it, or takes
 * out what no position reserves. Owner only (AgriVault's addLiquidity and
 * removeLiquidity) — not a transfer: USDG sent straight to the vault isn't
 * counted in the pool and stays stuck there.
 *
 *   npx hardhat run scripts/pool-liquidity.ts --network rhMainnet            (show)
 *   ADD=20 npx hardhat run scripts/pool-liquidity.ts --network rhMainnet     (add 20 USDG)
 *   REMOVE=5 npx hardhat run scripts/pool-liquidity.ts --network rhMainnet   (take 5 out)
 *
 * PowerShell: `$env:ADD="20"; npx hardhat run …`, then `Remove-Item Env:ADD`.
 *
 * Adding approves exactly the amount, then adds it: two transactions from
 * the owner's wallet, which must hold the USDG. Reads deployments/{chainId}.json.
 */
import { readFileSync } from 'node:fs';

import { network } from 'hardhat';
import { formatUnits, parseUnits, type Address, type Hex } from 'viem';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [owner] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const record = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), 'utf8')) as { vault: Address; usdc: Address };

const vault = await viem.getContractAt('AgriVault', record.vault);
const token = await viem.getContractAt('MockUSDC', record.usdc); // any ERC20's balanceOf / approve
const usd = (x: bigint) => `${formatUnits(x, 6)} USDG`;

async function mined(hash: Promise<Hex>): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${receipt.transactionHash} reverted`);
}

async function show(label: string): Promise<void> {
  const [pool, reserved, wallet] = await Promise.all([vault.read.poolBalance(), vault.read.reservedLiquidity(), token.read.balanceOf([owner.account.address])]);
  console.log(`${label}: pool ${usd(pool)}, reserved for positions ${usd(reserved)}, free ${usd(pool - reserved)} | your wallet ${usd(wallet)}`);
}

const vaultOwner = await vault.read.owner();
if (vaultOwner.toLowerCase() !== owner.account.address.toLowerCase()) {
  throw new Error(`${owner.account.address} isn't the vault's owner (${vaultOwner}): only the owner can add or remove liquidity`);
}
await show('Now');

const add = env('ADD');
const remove = env('REMOVE');
if (add && remove) throw new Error('Set ADD or REMOVE, not both.');

if (add) {
  const amount = parseUnits(add, 6);
  if (amount <= 0n) throw new Error('ADD must be more than 0');
  const balance = await token.read.balanceOf([owner.account.address]);
  if (balance < amount) throw new Error(`the wallet holds ${usd(balance)}, less than ${usd(amount)}`);
  // Exactly the amount: no allowance left behind.
  await mined(token.write.approve([vault.address, amount]));
  await mined(vault.write.addLiquidity([amount]));
  await show(`Added ${usd(amount)}`);
}

if (remove) {
  const amount = parseUnits(remove, 6);
  if (amount <= 0n) throw new Error('REMOVE must be more than 0');
  await mined(vault.write.removeLiquidity([amount, owner.account.address]));
  await show(`Took out ${usd(amount)}`);
}
