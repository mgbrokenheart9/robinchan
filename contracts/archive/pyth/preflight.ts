/**
 * Checks a chain is fit for the perps contracts before anything is deployed
 * to it — read-only, plain viem, shared by scripts/preflight.ts and
 * scripts/deploy.ts (which refuses to deploy to a live chain unless every
 * check passes).
 *
 * The oracle is checked against Pyth's production deployment on Arbitrum
 * One rather than against a list of addresses: same data sources, same
 * governance source, same guardian keys — and, with a Hermes API key, a real
 * signed update for every market has to verify on the target contract. A
 * Pyth-shaped contract that trusts anything else (a staging deployment, a
 * copy with its own signers) fails, whatever address it sits at.
 */
import { readFileSync } from 'node:fs';

import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  maxUint64,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type Check = { name: string; status: CheckStatus; detail: string };

export type PreflightInput = {
  client: PublicClient;
  /** Live chains fail on what testnets only warn about (owner, fees, caps). */
  mainnet: boolean;
  expectChainId?: number;
  pyth?: string;
  usdc?: string;
  owner?: string;
  deployer?: string;
  keeper?: string;
  minExecutionFeeWei?: string;
  maxOiUsd?: string;
  seedUsdc?: string;
  pythApiKey?: string;
  hermesUrl?: string;
  referenceRpc?: string;
};

/** Pyth's production deployment the target's configuration is compared with. */
export const PYTH_REFERENCE = {
  name: 'Arbitrum One',
  rpc: 'https://arb1.arbitrum.io/rpc',
  pyth: '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C' as Address,
};

/** Launch caps above this per side per market get a warning: start small, raise with the pool. */
const LAUNCH_OI_WARN_USD = 250_000;
/** Deploying the three contracts and listing 14 markets costs about this much gas. */
const DEPLOY_GAS = 40_000_000n;

const PYTH_ABI = parseAbi([
  'function version() view returns (string)',
  'function wormhole() view returns (address)',
  'function validDataSources() view returns ((uint16 chainId, bytes32 emitterAddress)[])',
  'function governanceDataSource() view returns ((uint16 chainId, bytes32 emitterAddress))',
  'function getUpdateFee(bytes[] updateData) view returns (uint256)',
  'function parsePriceFeedUpdatesWithConfig(bytes[] updateData, bytes32[] priceIds, uint64 minAllowedPublishTime, uint64 maxAllowedPublishTime, bool checkUniqueness, bool checkUpdateDataIsMinimal, bool storeUpdatesIfFresh) payable returns ((bytes32 id, (int64 price, uint64 conf, int32 expo, uint256 publishTime) price, (int64 price, uint64 conf, int32 expo, uint256 publishTime) emaPrice)[] priceFeeds, uint64[] slots)',
  'error PriceFeedNotFoundWithinRange()',
  'error InvalidUpdateData()',
  'error InvalidWormholeVaa()',
  'error InvalidUpdateDataSource()',
  'error InsufficientFee()',
]);
const WORMHOLE_ABI = parseAbi([
  'function getCurrentGuardianSetIndex() view returns (uint32)',
  'function getGuardianSet(uint32 index) view returns ((address[] keys, uint32 expirationTime))',
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

type DeployMarket = { symbol: string; contracts: Array<{ feedId: Hex; pythSymbol: string; rollAt: string | null }> };

/** The Pyth feed each market in deploy/markets.json would be listed with today. */
export function scheduledFeeds(now = Date.now()): Array<{ symbol: string; feedId: Hex; pythSymbol: string }> {
  const markets = JSON.parse(readFileSync(new URL('../../deploy/markets.json', import.meta.url), 'utf8')) as DeployMarket[];
  return markets.flatMap((m) => {
    const c = m.contracts.find((x) => x.rollAt == null || Date.parse(x.rollAt) > now);
    return c ? [{ symbol: m.symbol, feedId: c.feedId, pythSymbol: c.pythSymbol }] : [];
  });
}

async function pythConfig(client: PublicClient, pyth: Address) {
  const [version, wormhole, sources, governance] = await Promise.all([
    client.readContract({ address: pyth, abi: PYTH_ABI, functionName: 'version' }),
    client.readContract({ address: pyth, abi: PYTH_ABI, functionName: 'wormhole' }),
    client.readContract({ address: pyth, abi: PYTH_ABI, functionName: 'validDataSources' }),
    client.readContract({ address: pyth, abi: PYTH_ABI, functionName: 'governanceDataSource' }),
  ]);
  const index = await client.readContract({ address: wormhole, abi: WORMHOLE_ABI, functionName: 'getCurrentGuardianSetIndex' });
  const set = await client.readContract({ address: wormhole, abi: WORMHOLE_ABI, functionName: 'getGuardianSet', args: [index] });
  return {
    version,
    sources: sources.map((s) => `${s.chainId}:${s.emitterAddress.toLowerCase()}`).sort(),
    governance: `${governance.chainId}:${governance.emitterAddress.toLowerCase()}`,
    guardianIndex: index,
    guardians: set.keys.map((k) => k.toLowerCase()),
  };
}

function revertErrorName(err: unknown): string | null {
  const raw = (err as { walk?: (f: (e: unknown) => boolean) => { data?: Hex } | null }).walk?.(
    (e) => typeof (e as { data?: unknown }).data === 'string',
  )?.data;
  if (!raw || raw.length < 10) return null;
  try {
    return decodeErrorResult({ abi: PYTH_ABI, data: raw }).errorName;
  } catch {
    return `unknown error ${raw.slice(0, 10)}`;
  }
}

/**
 * The latest signed update for each feed, one request per feed: Hermes
 * refuses a whole request when the key's plan leaves out any feed in it, and
 * the preflight has to say which ones.
 */
async function hermesLatest(
  hermesUrl: string,
  apiKey: string,
  ids: Hex[],
): Promise<{ updateData: Hex[]; found: Set<string>; notEntitled: Set<string> }> {
  const hex = (s: string) => (s.startsWith('0x') ? s : `0x${s}`).toLowerCase() as Hex;
  const updateData: Hex[] = [];
  const found = new Set<string>();
  const notEntitled = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(`${hermesUrl.replace(/\/$/, '')}/v2/updates/price/latest?ids[]=${id}&encoding=hex&parsed=true`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403 && /not entitled/i.test(await res.clone().text())) {
        notEntitled.add(id.toLowerCase());
        return;
      }
      if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`);
      const body = (await res.json()) as { binary?: { data: string[] }; parsed?: Array<{ id: string }> };
      updateData.push(...(body.binary?.data ?? []).map(hex));
      for (const p of body.parsed ?? []) found.add(hex(p.id));
    }),
  );
  return { updateData, found, notEntitled };
}

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

  /* ---- Pyth ---- */
  const pyth = input.pyth && ADDRESS.test(input.pyth) ? (input.pyth as Address) : null;
  if (!pyth) {
    add('pyth: address', 'fail', 'PYTH_CONTRACT_ADDRESS is not set to an address');
  } else {
    const code = await client.getCode({ address: pyth });
    if (!code || code === '0x') add('pyth: address', 'fail', `no contract at ${pyth}`);
    else await checkPyth(pyth);
  }

  async function checkPyth(address: Address) {
    let target: Awaited<ReturnType<typeof pythConfig>>;
    try {
      target = await pythConfig(client, address);
      add('pyth: contract', 'ok', `Pyth ${target.version} at ${address}`);
    } catch (err) {
      add('pyth: contract', 'fail', `${address} doesn't answer as a Pyth contract (${short(err)})`);
      return;
    }
    if (input.mainnet) {
      try {
        const referenceClient = createPublicClient({ transport: http(input.referenceRpc ?? PYTH_REFERENCE.rpc, { timeout: 15_000 }) });
        const reference = await pythConfig(referenceClient as PublicClient, PYTH_REFERENCE.pyth);
        const sameSources = JSON.stringify(target.sources) === JSON.stringify(reference.sources);
        const sameGovernance = target.governance === reference.governance;
        const sameGuardians = target.guardianIndex === reference.guardianIndex && JSON.stringify(target.guardians) === JSON.stringify(reference.guardians);
        add(
          'pyth: trust roots',
          sameSources && sameGovernance && sameGuardians ? 'ok' : 'fail',
          sameSources && sameGovernance && sameGuardians
            ? `same data sources, governance and ${target.guardians.length} guardian keys (set #${target.guardianIndex}) as production Pyth on ${PYTH_REFERENCE.name}`
            : `differs from production Pyth on ${PYTH_REFERENCE.name}: data sources ${sameSources ? 'match' : 'DIFFER'}, governance ${sameGovernance ? 'matches' : 'DIFFERS'}, guardians ${sameGuardians ? 'match' : 'DIFFER'} — not a production deployment`,
        );
        if (target.version !== reference.version) {
          add('pyth: version', 'warn', `${target.version} here, ${reference.version} on ${PYTH_REFERENCE.name} — ask Pyth whether this deployment is supported for production`);
        }
      } catch (err) {
        add('pyth: trust roots', 'fail', `couldn't read production Pyth on ${PYTH_REFERENCE.name} to compare (${short(err)}); set PYTH_REFERENCE_RPC`);
      }
    }
    // AgriPerp settles orders with parsePriceFeedUpdatesWithConfig: it has to exist.
    try {
      await client.call({
        to: address,
        data: encodeFunctionData({
          abi: PYTH_ABI,
          functionName: 'parsePriceFeedUpdatesWithConfig',
          args: [[], ['0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace'], 0n, 1n, true, false, false],
        }),
      });
      add('pyth: parsePriceFeedUpdatesWithConfig', 'warn', 'an empty update parsed without reverting — unexpected');
    } catch (err) {
      const name = revertErrorName(err);
      add(
        'pyth: parsePriceFeedUpdatesWithConfig',
        name === 'PriceFeedNotFoundWithinRange' || name === 'InvalidUpdateData' ? 'ok' : 'fail',
        name ? `present (reverts ${name} on an empty update, as it should)` : 'missing: calling it reverts without an error — AgriPerp can’t settle orders here',
      );
    }
    // With a Hermes key: every market's real, signed price has to verify here.
    const feeds = scheduledFeeds();
    if (!input.pythApiKey) {
      add('pyth: signed prices', required(false), 'PYTH_API_KEY not set — can’t prove this contract accepts Hermes’ signed prices for every market');
      return;
    }
    try {
      const ids = feeds.map((f) => f.feedId.toLowerCase() as Hex);
      const { updateData, found, notEntitled } = await hermesLatest(input.hermesUrl ?? 'https://pyth.dourolabs.app/hermes', input.pythApiKey, ids);
      const name = (f: (typeof feeds)[number]) => `${f.symbol} (${f.pythSymbol})`;
      const refused = feeds.filter((f) => notEntitled.has(f.feedId.toLowerCase())).map(name);
      const missing = feeds.filter((f) => !found.has(f.feedId.toLowerCase()) && !notEntitled.has(f.feedId.toLowerCase())).map(name);
      if (refused.length) add('pyth: data plan', 'fail', `the plan behind PYTH_API_KEY doesn't include ${refused.length} of ${feeds.length} markets: ${refused.join(', ')}`);
      if (missing.length) add('pyth: feeds on Hermes', 'fail', `no price for ${missing.join(', ')}`);
      if (!refused.length && !missing.length) add('pyth: feeds on Hermes', 'ok', `all ${feeds.length} markets priced`);
      const present = ids.filter((id) => found.has(id));
      if (!present.length) {
        add('pyth: signed prices', 'fail', 'no feed this key can read, so nothing to verify');
        return;
      }
      const fee = await client.readContract({ address, abi: PYTH_ABI, functionName: 'getUpdateFee', args: [updateData] });
      await client.call({
        to: address,
        value: fee,
        data: encodeFunctionData({
          abi: PYTH_ABI,
          functionName: 'parsePriceFeedUpdatesWithConfig',
          args: [updateData, present, 0n, maxUint64, false, false, false],
        }),
      });
      add('pyth: signed prices', 'ok', `Hermes' signed update for ${present.length} feeds verifies here (update fee ${fee} wei)`);
    } catch (err) {
      add('pyth: signed prices', 'fail', `Hermes' signed update doesn't verify here: ${revertErrorName(err) ?? short(err)}`);
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
      const ok = decimals === 6 && /usdc/i.test(symbol);
      add('usdc', ok ? 'ok' : 'fail', `${symbol}, ${decimals} decimals, ${Number(formatUnits(supply, decimals)).toLocaleString('en-US')} in circulation`);
      if (ok && supply < parseUnits('1000000', 6)) {
        add('usdc: adoption', 'warn', 'under 1M in circulation on this chain — confirm it’s the USDC your users actually hold');
      }
    } catch (err) {
      add('usdc', 'fail', `${usdc} isn't a readable ERC-20 (${short(err)})`);
    }
  }

  /* ---- Owner (a Safe) ---- */
  const owner = input.owner && ADDRESS.test(input.owner) ? (input.owner as Address) : null;
  if (!owner) {
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
    const need = DEPLOY_GAS * gasPrice * 2n;
    add('deployer: gas', balance >= need ? 'ok' : 'fail', `${formatEther(balance)} ETH (deploying needs about ${formatEther(need)})`);
    if (usdc && input.seedUsdc) {
      const seed = parseUnits(input.seedUsdc, 6);
      const held = await client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [input.deployer as Address] }).catch(() => 0n);
      add('deployer: pool seed', held >= seed ? 'ok' : 'fail', `holds ${formatUnits(held, 6)} USDC, seeds ${input.seedUsdc}`);
    }
  } else {
    add('deployer', 'warn', 'DEPLOYER_ADDRESS not set — its gas and seed balances not checked');
  }
  if (input.keeper && ADDRESS.test(input.keeper)) {
    const balance = await client.getBalance({ address: input.keeper as Address });
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
  for (const c of checks) console.log(`  ${mark[c.status]} ${c.name.padEnd(38)} ${c.detail}`);
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  console.log(`\n  ${failed ? `${failed} failed` : 'all required checks passed'}${warned ? `, ${warned} warning${warned > 1 ? 's' : ''}` : ''}`);
  return failed === 0;
}
