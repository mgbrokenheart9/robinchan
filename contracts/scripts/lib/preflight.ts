/**
 * Checks a chain is fit for the perps contracts before anything is deployed
 * to it — read-only, plain viem, shared by scripts/preflight.ts and
 * scripts/deploy.ts (which refuses to deploy to a live chain unless every
 * check passes).
 *
 * Each market's feed is checked two ways: against Chainlink's own directory
 * of the chain's feeds (Robinhood Chain's, Base's, Arbitrum's) (the address has to be the proxy Chainlink lists
 * for it — a look-alike contract with the same description fails), and on
 * chain (its description, decimals, observation times and last round).
 */
import { readFileSync } from 'node:fs';

import { formatEther, formatUnits, parseAbi, parseUnits, type Address, type PublicClient } from 'viem';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type Check = { name: string; status: CheckStatus; detail: string };

export type PreflightInput = {
  client: PublicClient;
  /** Live chains fail on what testnets only warn about (owner, fees, caps). */
  mainnet: boolean;
  expectChainId?: number;
  /** `mock`: MockAggregators will be deployed (a testnet with ALLOW_MOCK_FEEDS). */
  feeds?: 'chainlink' | 'mock';
  usdc?: string;
  owner?: string;
  deployer?: string;
  keeper?: string;
  /**
   * One wallet deploys, owns and runs the keeper (SINGLE_KEY=true): the owner
   * check is a warning instead of a failure, and the keeper is the deployer.
   * Whoever gets that key can pause markets, change fees within their bounds
   * and withdraw the pool's unreserved liquidity — never traders' collateral.
   */
  singleKey?: boolean;
  minExecutionFeeWei?: string;
  maxOiUsd?: string;
  seedUsdc?: string;
  /** Chainlink's feed directory for the chain; the Robinhood Chain mainnet one by default. */
  directoryUrl?: string;
  /** The markets to check; deploy/markets.json (Robinhood Chain's) by default. */
  markets?: DeployMarket[];
  /** The chain, as the checks name it. */
  network?: string;
};

export const CHAINLINK_DIRECTORY = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';

/** Launch caps above this per side per market get a warning: start small, raise with the pool. */
const LAUNCH_OI_WARN_USD = 250_000;
/**
 * Gas to deploy the three contracts and list `markets` of them: measured
 * 2026-10-01 at ~6M for the stack and ~0.5M a market (Base's budget launch,
 * mocks included, 8.4M). The check asks for twice that.
 */
const deployGas = (markets: number): bigint => 6_000_000n + 500_000n * BigInt(markets);
/** AgriPerp's requestPriceAge: a feed quieter than this takes no orders. */
const REQUEST_PRICE_AGE_SEC = 90_000;
/** A feed quiet for longer than this isn't just a market's weekend. */
const QUIET_FAIL_SEC = 4 * 86_400;

const FEED_ABI = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function aggregator() view returns (address)',
  'function typeAndVersion() view returns (string)',
]);
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const SAFE_ABI = parseAbi([
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function VERSION() view returns (string)',
]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const short = (e: unknown) => (e as Error).message.split('\n')[0]?.slice(0, 140) ?? String(e);
const hours = (sec: number) => (sec < 5_400 ? `${Math.round(sec / 60)} min` : `${(sec / 3_600).toFixed(1)} h`);

export type DeployMarket = { symbol: string; feed: { proxy: Address; description: string } };

/** The markets deploy/markets.json lists, with their Chainlink feeds. */
export function deployMarkets(): DeployMarket[] {
  return JSON.parse(readFileSync(new URL('../../deploy/markets.json', import.meta.url), 'utf8')) as DeployMarket[];
}

type DirectoryEntry = { proxyAddress?: string; secondaryProxyAddress?: string; name?: string; feedCategory?: string; docs?: { shutdownDate?: string } };

export async function preflight(input: PreflightInput): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });
  const required = (ok: boolean) => (ok ? 'ok' : input.mainnet ? 'fail' : 'warn');
  const { client } = input;

  /* ---- Chain ---- */
  const chainId = await client.getChainId();
  const gasPrice = await client.getGasPrice();
  if (input.expectChainId != null && chainId !== input.expectChainId) {
    add('chain', 'fail', `the RPC is chain ${chainId}, expected ${input.expectChainId}`);
    return checks;
  }
  add('chain', 'ok', `chain ${chainId}, gas ${formatUnits(gasPrice, 9)} gwei`);
  const { timestamp } = await client.getBlock();
  const now = Number(timestamp);

  /* ---- Feeds ---- */
  const markets = input.markets ?? deployMarkets();
  const chainName = input.network ?? 'Robinhood Chain';
  if (input.feeds === 'mock') {
    add('feeds', input.mainnet ? 'fail' : 'warn', `MockAggregators for ${markets.length} markets: anyone can post a price to them — a testnet only`);
  } else {
    let directory: DirectoryEntry[] | null = null;
    if (input.mainnet || input.directoryUrl) {
      try {
        const res = await fetch(input.directoryUrl ?? CHAINLINK_DIRECTORY, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        directory = (await res.json()) as DirectoryEntry[];
        add('chainlink: directory', 'ok', `${directory.length} feeds listed for ${chainName}`);
      } catch (err) {
        add('chainlink: directory', 'fail', `couldn't read Chainlink's feed directory (${short(err)}); set CHAINLINK_DIRECTORY_URL`);
      }
    }
    for (const m of markets) {
      const name = `feed: ${m.symbol}`;
      const proxy = m.feed.proxy;
      if (directory) {
        const entry = directory.find((e) => e.proxyAddress?.toLowerCase() === proxy.toLowerCase());
        if (!entry) {
          add(name, 'fail', `${proxy} isn't a feed Chainlink lists for ${chainName}`);
          continue;
        }
        if (entry.docs?.shutdownDate || /deprecat/i.test(entry.feedCategory ?? '')) {
          add(name, 'fail', `Chainlink is retiring it${entry.docs?.shutdownDate ? ` (${entry.docs.shutdownDate})` : ''}`);
          continue;
        }
      }
      try {
        const code = await client.getCode({ address: proxy });
        if (!code || code === '0x') {
          add(name, 'fail', `no contract at ${proxy}`);
          continue;
        }
        const [description, decimals, round] = await Promise.all([
          client.readContract({ address: proxy, abi: FEED_ABI, functionName: 'description' }),
          client.readContract({ address: proxy, abi: FEED_ABI, functionName: 'decimals' }),
          client.readContract({ address: proxy, abi: FEED_ABI, functionName: 'latestRoundData' }),
        ]);
        const aggregator = await client
          .readContract({ address: proxy, abi: FEED_ABI, functionName: 'aggregator' })
          .then((a) => client.readContract({ address: a, abi: FEED_ABI, functionName: 'typeAndVersion' }))
          .catch(() => 'aggregator unknown');
        const [, answer, startedAt, updatedAt] = round;
        const age = now - Number(updatedAt);
        const problems: string[] = [];
        if (description !== m.feed.description) problems.push(`describes itself as "${description}", not "${m.feed.description}"`);
        if (decimals > 18) problems.push(`${decimals} decimals`);
        if (answer <= 0n) problems.push('a non-positive answer');
        if (startedAt === 0n || startedAt > updatedAt) problems.push('no usable observation time (orders need one)');
        const price = Number(formatUnits(answer > 0n ? answer : 0n, decimals));
        const detail = `"${description}" $${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}, ${decimals} decimals, last round ${hours(age)} ago (${aggregator})`;
        if (problems.length) add(name, 'fail', problems.join('; '));
        else if (age <= REQUEST_PRICE_AGE_SEC) add(name, 'ok', detail);
        else if (age <= QUIET_FAIL_SEC) add(name, 'warn', `${detail} — quiet, its market may be shut; it takes orders once it publishes`);
        else add(name, 'fail', `${detail} — silent for days: the feed may have stopped`);
      } catch (err) {
        add(name, 'fail', `${proxy} doesn't answer as a Chainlink feed (${short(err)})`);
      }
    }
  }

  /* ---- USDC ---- */
  const usdc = input.usdc && ADDRESS.test(input.usdc) ? (input.usdc as Address) : null;
  if (!usdc) {
    add('usdc', required(false), 'USDC_ADDRESS is not set');
  } else {
    try {
      const [symbol, decimals, supply] = await Promise.all([
        client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'symbol' }),
        client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'decimals' }),
        client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'totalSupply' }),
      ]);
      // USDC, or USDG — what bridged USDC arrives as on Robinhood Chain. Both 6 decimals.
      const ok = decimals === 6 && /^(usdc|usdg)$/i.test(symbol);
      add('usdc', ok ? 'ok' : 'fail', `${symbol}, ${decimals} decimals, ${Number(formatUnits(supply, decimals)).toLocaleString('en-US')} in circulation`);
      if (ok && supply < parseUnits('1000000', 6)) {
        add('usdc: adoption', 'warn', `under 1M in circulation on this chain — confirm it’s the ${symbol} your users actually hold (on Robinhood Chain that's USDG)`);
      }
    } catch (err) {
      add('usdc', 'fail', `${usdc} isn't a readable ERC-20 (${short(err)})`);
    }
  }

  /* ---- Owner (a Safe) ---- */
  const owner = input.owner && ADDRESS.test(input.owner) ? (input.owner as Address) : null;
  const deployerIsOwner = !owner || owner.toLowerCase() === input.deployer?.toLowerCase();
  if (input.singleKey && deployerIsOwner) {
    add(
      'owner',
      'warn',
      'one key (SINGLE_KEY): the deployer owns the contracts and runs the keeper — whoever gets it can pause markets, change fees within bounds and withdraw the pool’s unreserved liquidity (never traders’ collateral). Keep the pool small.',
    );
  } else if (!owner) {
    add('owner', required(false), 'OWNER_ADDRESS is not set — the contracts would stay owned by the deployer key');
  } else {
    const code = await client.getCode({ address: owner });
    if (!code || code === '0x') {
      add('owner', required(false), `${owner} is a plain account — use a Safe multisig, so no single key can change fees, funding or delist`);
    } else {
      try {
        const [threshold, owners, version] = await Promise.all([
          client.readContract({ address: owner, abi: SAFE_ABI, functionName: 'getThreshold' }),
          client.readContract({ address: owner, abi: SAFE_ABI, functionName: 'getOwners' }),
          client.readContract({ address: owner, abi: SAFE_ABI, functionName: 'VERSION' }),
        ]);
        add('owner', threshold >= 2n ? 'ok' : required(false), `Safe ${version}, ${threshold} of ${owners.length} signers`);
      } catch (err) {
        add('owner', required(false), `${owner} isn't a Safe (${short(err)})`);
      }
    }
  }

  /* ---- Accounts ---- */
  if (input.deployer && ADDRESS.test(input.deployer)) {
    const balance = await client.getBalance({ address: input.deployer as Address });
    const need = deployGas(markets.length) * gasPrice * 2n;
    add('deployer: gas', balance >= need ? 'ok' : 'fail', `${formatEther(balance)} ETH (deploying needs about ${formatEther(need)})`);
    if (usdc && input.seedUsdc) {
      const seed = parseUnits(input.seedUsdc, 6);
      const held = await client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [input.deployer as Address] }).catch(() => 0n);
      add('deployer: pool seed', held >= seed ? 'ok' : 'fail', `holds ${formatUnits(held, 6)} USDC, seeds ${input.seedUsdc}`);
    }
  } else {
    add('deployer', 'warn', 'DEPLOYER_ADDRESS not set — its gas and seed balances not checked');
  }
  const keeper = input.keeper ?? (input.singleKey ? input.deployer : undefined);
  if (keeper && ADDRESS.test(keeper)) {
    const balance = await client.getBalance({ address: keeper as Address });
    const need = 2_000_000n * gasPrice * 1_000n; // about a thousand keeper transactions
    add('keeper: gas', balance >= need ? 'ok' : 'warn', `${formatEther(balance)} ETH (a thousand transactions need about ${formatEther(need)})`);
  } else {
    add('keeper', required(false), 'KEEPER_ADDRESS not set — orders only execute when the worker has a funded keeper key');
  }

  /* ---- Launch parameters ---- */
  const fee = input.minExecutionFeeWei ? BigInt(input.minExecutionFeeWei) : 0n;
  add(
    'min execution fee',
    fee > 0n && fee <= 10n ** 16n ? 'ok' : required(false),
    fee > 0n ? `${formatEther(fee)} ETH per order (keeper gas is about ${formatEther(1_500_000n * gasPrice)})` : 'MIN_EXECUTION_FEE_WEI unset: executors are paid nothing, and spam costs only gas',
  );
  const cap = input.maxOiUsd ? Number(input.maxOiUsd) : NaN;
  add(
    'open-interest cap',
    Number.isFinite(cap) && cap > 0 ? (cap > LAUNCH_OI_WARN_USD ? 'warn' : 'ok') : required(false),
    Number.isFinite(cap) && cap > 0 ? `$${cap.toLocaleString('en-US')} per side per market${cap > LAUNCH_OI_WARN_USD ? ' — high for a launch' : ''}` : 'MAX_OI_USD unset: markets list with deploy/markets.json caps ($1M per side)',
  );
  const seed = input.seedUsdc ? Number(input.seedUsdc) : 0;
  add('pool seed', seed > 0 ? 'ok' : required(false), seed > 0 ? `${seed.toLocaleString('en-US')} USDC` : 'SEED_LIQUIDITY_USDC unset: no position can open until someone adds liquidity');
  return checks;
}

export function printChecks(checks: Check[]): boolean {
  const mark: Record<CheckStatus, string> = { ok: '✔', warn: '!', fail: '✖' };
  for (const c of checks) console.log(`  ${mark[c.status]} ${c.name.padEnd(24)} ${c.detail}`);
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  console.log(`\n  ${failed ? `${failed} failed` : 'all required checks passed'}${warned ? `, ${warned} warning${warned > 1 ? 's' : ''}` : ''}`);
  return failed === 0;
}
