import type { Address } from './types';

/* ------------------------------------------------------------------ */
/* Robinhood stock tokens                                              */
/* ------------------------------------------------------------------ */

export type StockToken = {
  symbol: string;
  /** The company or fund, shortened from the token's `name()` ("Tesla • Robinhood Token"). */
  name: string;
  address: Address;
  decimals: number;
  /** A private company: no public share price to compare with, so it's off the Gap board. */
  unlisted?: true;
};

/**
 * Robinhood's own stock tokens on Robinhood Chain mainnet — every one named
 * "<Company> • Robinhood Token" on chain. Found through their DexScreener
 * pools and confirmed on chain (`name`, `symbol`, `decimals`) on 2026-09-28.
 * Not every stock token Robinhood has issued: the ones with pools worth
 * tracking. The Gap board tracks these, and Token Check tells them apart
 * from the memecoins that borrow their tickers.
 */
export const STOCK_TOKENS: StockToken[] = [
  { symbol: 'AAPL', name: 'Apple', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18 },
  { symbol: 'AMZN', name: 'Amazon', address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', decimals: 18 },
  { symbol: 'GOOGL', name: 'Alphabet', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18 },
  { symbol: 'META', name: 'Meta Platforms', address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', decimals: 18 },
  { symbol: 'MSFT', name: 'Microsoft', address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', decimals: 18 },
  { symbol: 'NVDA', name: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18 },
  { symbol: 'TSLA', name: 'Tesla', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18 },
  { symbol: 'NFLX', name: 'Netflix', address: '0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8', decimals: 18 },
  { symbol: 'AMD', name: 'AMD', address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', decimals: 18 },
  { symbol: 'PLTR', name: 'Palantir', address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A', decimals: 18 },
  { symbol: 'COIN', name: 'Coinbase', address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b', decimals: 18 },
  { symbol: 'MSTR', name: 'Strategy', address: '0xec262a75e413fAfD0dF80480274532C79D42da09', decimals: 18 },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18 },
  { symbol: 'QQQ', name: 'Invesco QQQ', address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', decimals: 18 },
  { symbol: 'INTC', name: 'Intel', address: '0xc72b96e0E48ecd4DC75E1e45396e26300BC39681', decimals: 18 },
  { symbol: 'AVGO', name: 'Broadcom', address: '0x156E175DD063a8cE274C50654eF40e0032b3fbcF', decimals: 18 },
  { symbol: 'ORCL', name: 'Oracle', address: '0xb0992820E760d836549ba69BC7598b4af75dEE03', decimals: 18 },
  { symbol: 'CRM', name: 'Salesforce', address: '0xd95B44124e475743a7589e68F3D74008A5536D44', decimals: 18 },
  { symbol: 'SHOP', name: 'Shopify', address: '0xF53F66751B1Eff985311b693531E3290F600c410', decimals: 18 },
  { symbol: 'BABA', name: 'Alibaba', address: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4', decimals: 18 },
  { symbol: 'COST', name: 'Costco', address: '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2', decimals: 18 },
  { symbol: 'RBLX', name: 'Roblox', address: '0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8', decimals: 18 },
  { symbol: 'GME', name: 'GameStop', address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', decimals: 18 },
  { symbol: 'AMC', name: 'AMC Entertainment', address: '0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B', decimals: 18 },
  { symbol: 'SOFI', name: 'SoFi', address: '0x98E75885157C80992A8D41b696D8c9C6Fb30A926', decimals: 18 },
  { symbol: 'SMCI', name: 'Super Micro Computer', address: '0xc01aA1fECeC0605b13bc84874ff7256C0f5F562a', decimals: 18 },
  { symbol: 'MU', name: 'Micron', address: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD', decimals: 18 },
  { symbol: 'TSM', name: 'Taiwan Semiconductor', address: '0x58FfE4a942d3885bAa22D7520691F611EF09e7AA', decimals: 18 },
  { symbol: 'LLY', name: 'Eli Lilly', address: '0x8005d266423c7ea827372c9c864491e5786600ea', decimals: 18 },
  { symbol: 'CRWD', name: 'CrowdStrike', address: '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931', decimals: 18 },
  { symbol: 'HIMS', name: 'Hims & Hers', address: '0xCceE82fE024c36fA15E1005edE3E9e4787e23D09', decimals: 18 },
  { symbol: 'GLD', name: 'SPDR Gold Trust', address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', decimals: 18 },
  { symbol: 'ASML', name: 'ASML', address: '0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA', decimals: 18 },
  { symbol: 'IBM', name: 'IBM', address: '0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619', decimals: 18 },
  { symbol: 'ADBE', name: 'Adobe', address: '0x232B8ed6377BE97813853B0Ac104c4Cda8378d1B', decimals: 18 },
  { symbol: 'QCOM', name: 'Qualcomm', address: '0x0f17206447090e464C277571124dD2688E48AEA9', decimals: 18 },
  { symbol: 'CSCO', name: 'Cisco', address: '0xF543967EEBB6f1917992eF0E68De63ab07a5a0dA', decimals: 18 },
  { symbol: 'XOM', name: 'ExxonMobil', address: '0xf9B46d3D1B22199D4D1025a9cEDB540A33F1a2d5', decimals: 18 },
  { symbol: 'CRCL', name: 'Circle', address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', decimals: 18 },
  { symbol: 'RDDT', name: 'Reddit', address: '0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C', decimals: 18 },
  { symbol: 'SNOW', name: 'Snowflake', address: '0xBa0CAB75495255d0cB58E22B648bFED4ECD1F47E', decimals: 18 },
  { symbol: 'SPCX', name: 'SpaceX', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18, unlisted: true },
];

const STOCK_BY_SYMBOL = new Map(STOCK_TOKENS.map((t) => [t.symbol, t]));
const STOCK_BY_ADDRESS = new Map(STOCK_TOKENS.map((t) => [t.address.toLowerCase(), t]));

export function stockToken(symbol: string): StockToken | null {
  return STOCK_BY_SYMBOL.get(symbol.toUpperCase()) ?? null;
}

export function stockTokenAt(address: string): StockToken | null {
  return STOCK_BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

/* ------------------------------------------------------------------ */
/* The US market's clock                                               */
/* ------------------------------------------------------------------ */

/**
 * Where Wall Street is at a given moment, as the Gap board needs it:
 *
 * - `regular`   9:30–16:00 New York on a trading day
 * - `extended`  pre-market (4:00–9:30) and after hours (16:00–20:00)
 * - `overnight` 20:00–4:00, Sunday night to Friday morning — Robinhood's
 *               24-hour market, which is also when its Chainlink stock feeds
 *               keep publishing (24/5)
 * - `weekend`   Friday 20:00 to Sunday 20:00: no US price is made anywhere
 * - `holiday`   an NYSE holiday
 *
 * The last two are when the stock tokens are the only market left.
 */
export type UsSessionState = 'regular' | 'extended' | 'overnight' | 'weekend' | 'holiday';

export type UsSession = {
  state: UsSessionState;
  /** Short label for the status pill: "Weekend", "After hours", … */
  label: string;
  /** No US price is being made right now (weekend or holiday). */
  closed: boolean;
  /** The next regular-session open, ISO. */
  nextOpen: string;
  /** Today's regular close while the regular session runs, ISO; null otherwise. */
  nextClose: string | null;
  /** The holiday's name on a holiday. */
  holiday: string | null;
};

/**
 * NYSE full-day closures, 2026–2027 (New York dates). A date missing from
 * here is assumed to be a trading day, so extend this before 2028.
 */
export const NYSE_HOLIDAYS: Record<string, string> = {
  '2026-01-01': "New Year's Day",
  '2026-01-19': 'Martin Luther King Jr. Day',
  '2026-02-16': "Washington's Birthday",
  '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day',
  '2026-06-19': 'Juneteenth',
  '2026-07-03': 'Independence Day',
  '2026-09-07': 'Labor Day',
  '2026-11-26': 'Thanksgiving',
  '2026-12-25': 'Christmas',
  '2027-01-01': "New Year's Day",
  '2027-01-18': 'Martin Luther King Jr. Day',
  '2027-02-15': "Washington's Birthday",
  '2027-03-26': 'Good Friday',
  '2027-05-31': 'Memorial Day',
  '2027-06-18': 'Juneteenth',
  '2027-07-05': 'Independence Day',
  '2027-09-06': 'Labor Day',
  '2027-11-25': 'Thanksgiving',
  '2027-12-24': 'Christmas',
};

/** Days the regular session ends at 13:00 New York. */
export const NYSE_EARLY_CLOSES: Record<string, number> = {
  '2026-11-27': 13 * 60,
  '2026-12-24': 13 * 60,
  '2027-11-26': 13 * 60,
};

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const PRE_MIN = 4 * 60;
const POST_END_MIN = 20 * 60;

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

type NyParts = { y: number; mo: number; d: number; minutes: number };

function nyParts(at: number): NyParts {
  const parts = NY.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), minutes: get('hour') * 60 + get('minute') };
}

function isoDate(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A New York wall-clock time as a UTC timestamp, DST included. */
function nyToUtc(y: number, mo: number, d: number, minutes: number): number {
  const wanted = Date.UTC(y, mo - 1, d, 0, minutes);
  let t = wanted + 5 * 3_600_000;
  for (let i = 0; i < 2; i += 1) {
    const p = nyParts(t);
    t += wanted - Date.UTC(p.y, p.mo - 1, p.d, 0, p.minutes);
  }
  return t;
}

/** Calendar day `offset` days after a New York date: its parts and weekday (0 = Sunday). */
function dayAfter(p: NyParts, offset: number): { y: number; mo: number; d: number; weekday: number; date: string } {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + offset));
  const y = t.getUTCFullYear();
  const mo = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  return { y, mo, d, weekday: t.getUTCDay(), date: isoDate(y, mo, d) };
}

export function isTradingDay(date: string, weekday: number): boolean {
  return weekday >= 1 && weekday <= 5 && !(date in NYSE_HOLIDAYS);
}

export function usSession(at: number = Date.now()): UsSession {
  const now = nyParts(at);
  const today = dayAfter(now, 0);
  const m = now.minutes;
  const closeMin = NYSE_EARLY_CLOSES[today.date] ?? CLOSE_MIN;

  // The next regular open: today's if it hasn't come yet, else the next trading day's.
  let nextOpen = 0;
  for (let k = 0; k < 14 && !nextOpen; k += 1) {
    const day = dayAfter(now, k);
    if (!isTradingDay(day.date, day.weekday)) continue;
    const open = nyToUtc(day.y, day.mo, day.d, OPEN_MIN);
    if (open > at) nextOpen = open;
  }
  const base = { nextOpen: new Date(nextOpen).toISOString(), nextClose: null, holiday: null };

  const weekend = today.weekday === 6 || (today.weekday === 5 && m >= POST_END_MIN) || (today.weekday === 0 && m < POST_END_MIN);
  if (weekend) return { ...base, state: 'weekend', label: 'Weekend', closed: true };

  const holiday = NYSE_HOLIDAYS[today.date];
  if (holiday) return { ...base, state: 'holiday', label: `Holiday · ${holiday}`, closed: true, holiday };

  if (today.weekday !== 0 && m >= OPEN_MIN && m < closeMin) {
    return {
      ...base,
      state: 'regular',
      label: 'US market open',
      closed: false,
      nextClose: new Date(nyToUtc(today.y, today.mo, today.d, closeMin)).toISOString(),
    };
  }
  if (today.weekday !== 0 && m >= PRE_MIN && m < OPEN_MIN) return { ...base, state: 'extended', label: 'Pre-market', closed: false };
  if (today.weekday !== 0 && m >= closeMin && m < POST_END_MIN) return { ...base, state: 'extended', label: 'After hours', closed: false };
  return { ...base, state: 'overnight', label: 'Overnight session', closed: false };
}

/* ------------------------------------------------------------------ */
/* The Gap board                                                       */
/* ------------------------------------------------------------------ */

/** One pool a stock token trades in, as DexScreener reports it. */
export type GapPool = {
  dex: string;
  /** "v3", "v4" … when DexScreener labels it. */
  version: string | null;
  quote: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24h: number;
  url: string;
};

/**
 * `yahoo`: the stock's regular-session price — live while Wall Street is
 * open, its last close otherwise. `chainlink`: Robinhood Chain's own feed
 * for the stock, the fallback (it moves only on a 0.5% change).
 */
export type GapReferenceSource = 'yahoo' | 'chainlink' | 'sample';

export type GapRow = {
  symbol: string;
  name: string;
  token: Address;
  /** The token's price across its pools, weighted by liquidity; null with no usable pool. */
  onchain: number | null;
  /** The stock's own price: live in the regular session, its last close otherwise. */
  reference: number | null;
  /** When that price was set, ISO. */
  referenceAt: string | null;
  referenceSource: GapReferenceSource | null;
  /** On-chain price against the reference, in percent; null when either is missing. */
  gapPct: number | null;
  liquidityUsd: number;
  volume24h: number;
  /** The deepest pools, deepest first (at most five). */
  pools: GapPool[];
  /** The gap over the last 24 hours, oldest first, one point per half hour. */
  spark: number[];
};

export type GapSummary = {
  tracked: number;
  above: number;
  below: number;
  /** Median of the absolute gaps, percent. */
  typicalGapPct: number | null;
  widest: { symbol: string; gapPct: number } | null;
  liquidityUsd: number;
  volume24h: number;
};

export type GapBoard = {
  session: UsSession;
  rows: GapRow[];
  /** Stock tokens left off: no pool deep enough to price them. */
  unpriced: string[];
  summary: GapSummary;
  /** Robinchan's line about the board. */
  read: string;
  /** `sample` only ever appears in `RC_ENV=dev`, when no live price could be read. */
  source: 'live' | 'sample';
  computedAt: string;
};

/** A row's gap history for its chart: [UNIX seconds, gap %], oldest first. */
export type GapHistory = {
  symbol: string;
  points: Array<[number, number]>;
};
