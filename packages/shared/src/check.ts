import { RCHAN_TOKEN, USDG_TOKEN } from './constants';

/**
 * Token Check: any token on Robinhood Chain, read from its contract, its
 * pools and a simulated buy and sell — what Robinchan finds, as facts, with
 * a verdict on top. Never a recommendation.
 */

/**
 * - `official` a token whose issuer we know: Robinhood's stock tokens, $RCHAN, USDG, WETH
 * - `clean`    nothing we check for came up
 * - `caution`  something to know before trading it
 * - `danger`   a red flag: selling looks blocked, it impersonates another token, …
 * - `unknown`  not a token we can read
 */
export type CheckVerdict = 'official' | 'clean' | 'caution' | 'danger' | 'unknown';

export type CheckSeverity = 'good' | 'info' | 'warn' | 'danger';

export type CheckFinding = {
  id: string;
  severity: CheckSeverity;
  title: string;
  detail: string;
};

/** Owner-only powers found in the contract's code. */
export type CheckCapability = 'mint' | 'blacklist' | 'pause' | 'fees' | 'limits' | 'trading' | 'roles';

export type CheckKnownKind = 'stock' | 'rchan' | 'stable' | 'wrapped';

export type CheckKnown = {
  kind: CheckKnownKind;
  symbol: string;
  name: string;
};

export type CheckPool = {
  dex: string;
  version: string | null;
  pair: string;
  quote: string;
  liquidityUsd: number;
  volume24h: number;
  url: string;
};

export type CheckMarket = {
  priceUsd: number | null;
  change24hPct: number | null;
  liquidityUsd: number;
  volume24h: number;
  fdv: number | null;
  marketCap: number | null;
  buys24h: number;
  sells24h: number;
  /** When its first pool was created, ISO. */
  firstPoolAt: string | null;
  pools: CheckPool[];
  imageUrl: string | null;
  links: Array<{ label: string; url: string }>;
};

export type CheckContract = {
  proxy: 'eip1967' | 'beacon' | 'clone' | null;
  implementation: string | null;
  /** Someone can swap the code: an EIP-1967 or beacon proxy. */
  upgradeable: boolean;
  owner: string | null;
  /** `none`: no `owner()` at all. */
  ownerState: 'renounced' | 'active' | 'none';
  capabilities: CheckCapability[];
  codeSize: number;
};

export type CheckSimLeg = {
  ok: boolean;
  /** Share of the amount that didn't arrive, percent. */
  taxPct: number | null;
  error: string | null;
};

export type CheckSimulation = {
  status: 'passed' | 'failed' | 'skipped';
  /** Which pool the simulated trade came from and went back to. */
  via: string | null;
  buy: CheckSimLeg | null;
  sell: CheckSimLeg | null;
  note: string;
};

/** Where the supply sits, percent of total. */
export type CheckSupply = {
  inPoolsPct: number | null;
  burnedPct: number;
  ownerPct: number | null;
  contractPct: number;
  restPct: number;
};

export type TokenCheck = {
  address: string;
  verdict: CheckVerdict;
  /** Robinchan's line about it. */
  headline: string;
  token: { name: string; symbol: string; decimals: number; totalSupply: number | null } | null;
  known: CheckKnown | null;
  impersonates: { symbol: string; name: string; address: string; by: 'name' | 'ticker' } | null;
  findings: CheckFinding[];
  market: CheckMarket | null;
  contract: CheckContract | null;
  simulation: CheckSimulation;
  supply: CheckSupply | null;
  checkedAt: string;
};

export type RecentCheck = {
  address: string;
  symbol: string;
  name: string;
  verdict: CheckVerdict;
  imageUrl: string | null;
  at: string;
};

/** Bridged ETH on Robinhood Chain, the quote side of most memecoin pools. */
export const WETH_TOKEN = {
  address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
} as const;

/** Tokens besides the stock tokens whose issuer is known. */
export const KNOWN_TOKENS: Array<{ address: string; known: CheckKnown }> = [
  { address: RCHAN_TOKEN.address, known: { kind: 'rchan', symbol: 'RCHAN', name: 'Robinchan' } },
  { address: USDG_TOKEN.address, known: { kind: 'stable', symbol: 'USDG', name: 'Global Dollar (Paxos)' } },
  { address: WETH_TOKEN.address, known: { kind: 'wrapped', symbol: 'WETH', name: 'Wrapped Ether' } },
];

export const CHECK_VERDICT_LABEL: Record<CheckVerdict, string> = {
  official: 'Official',
  clean: 'No red flags',
  caution: 'Be careful',
  danger: 'High risk',
  unknown: "Can't tell",
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Shaped like an EVM address — whether it's a token is the check's job. */
export function looksLikeAddress(value: string): boolean {
  return ADDRESS.test(value.trim());
}
