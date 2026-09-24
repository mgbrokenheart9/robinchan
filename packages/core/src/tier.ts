import type { Address, TierId, TierState } from '@robinchan/shared';
import { TIER_FEATURES, TIER_ORDER } from '@robinchan/shared';
import { cacheKey, getCache } from '@robinchan/store';
import { formatUnits, parseUnits } from 'viem';

import { ERC20_ABI, publicClient } from './chain';
import { devTierFor } from './env';
import { rchanToken } from './tokens';

/**
 * Tier from the $RCHAN balance on chain (brief §14), cached 60 seconds per
 * address. Never from anything the client sends.
 *
 * Until the contract address (open decision #2) and the thresholds (#3)
 * exist, every wallet is `free` with `source: 'unconfigured'` — except in
 * `RC_ENV=dev`, where `RC_DEV_TIER` can stand in for testing.
 */
const TIER_CACHE_SEC = 60;

function unlockedFor(tier: TierId): string[] {
  const upto = TIER_ORDER.indexOf(tier);
  return TIER_ORDER.slice(0, upto + 1).flatMap((t) => TIER_FEATURES[t]);
}

function thresholds(decimals: number): Array<{ tier: TierId; min: bigint }> {
  const out: Array<{ tier: TierId; min: bigint }> = [];
  for (const [tier, name] of [
    ['tier3', 'TIER_3_MIN'],
    ['tier2', 'TIER_2_MIN'],
    ['tier1', 'TIER_1_MIN'],
  ] as const) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;
    try {
      out.push({ tier, min: parseUnits(raw, decimals) });
    } catch {
      console.warn(`[tier] ${name}=${raw} is not a number; ignored`);
    }
  }
  return out;
}

export async function resolveTier(address: Address): Promise<TierState> {
  const override = devTierFor(address);
  if (override) {
    return { tier: override, balance: '0', unlocked: unlockedFor(override), source: 'dev-override' };
  }

  const token = rchanToken();
  const client = publicClient();
  const levels = token ? thresholds(token.decimals) : [];
  if (!token || !client || levels.length === 0) {
    return { tier: 'free', balance: '0', unlocked: unlockedFor('free'), source: 'unconfigured' };
  }

  const key = cacheKey('tier', address.toLowerCase());
  const cached = await getCache().getWithAge<TierState>(key).catch(() => null);
  if (cached && cached.ageSec < TIER_CACHE_SEC) return cached.value;

  let balance: bigint;
  try {
    balance = await client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    });
  } catch (err) {
    // RPC hiccup: a recent answer beats demoting a holder to free.
    if (cached) return cached.value;
    throw err;
  }

  const tier = levels.find((l) => balance >= l.min)?.tier ?? 'free';
  const state: TierState = {
    tier,
    balance: formatUnits(balance, token.decimals),
    unlocked: unlockedFor(tier),
    source: 'chain',
  };
  await getCache().set(key, state, TIER_CACHE_SEC).catch(() => undefined);
  return state;
}
