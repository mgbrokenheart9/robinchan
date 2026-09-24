import type { Candle, CalendarEvent, CandleInterval, MediaClip, NewsItem } from '@robinchan/shared';
import { SYMBOL_NAMES, WATCHED_SYMBOLS } from '@robinchan/shared';
import { INTERVAL_SEC, bucketStart } from '@robinchan/core';

import { scoreSentiment } from '../lib/sentiment.js';
import { shorten } from './finnhub.js';
import type { RawQuote } from './finnhub.js';

/**
 * Fake data for the `dev` environment (brief §16: "provider data is faked").
 * Only used when the real adapter fails or isn't configured, and always
 * marks itself via the `source` field so it never gets mistaken for real
 * data on staging or production.
 */

export function fixturesEnabled(): boolean {
  return (process.env.RC_ENV ?? 'dev') === 'dev';
}

const BASE_PRICES: Record<string, number> = {
  AAPL: 238.4,
  NVDA: 176.22,
  TSLA: 412.87,
  MSFT: 511.03,
  AMZN: 229.65,
  META: 742.11,
  GOOGL: 253.48,
  COIN: 318.9,
  SPX: 6842.3,
  NDX: 25_318.7,
  DJI: 47_112.4,
  VIX: 14.82,
  RCHAN: 0.0421,
};

/** Deterministic random walk per minute so numbers move but don't go wild. */
function drift(symbol: string, at = Date.now()): number {
  const seed = [...symbol].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7);
  const minute = Math.floor(at / 60_000);
  const x = Math.sin(seed * 0.37 + minute * 0.11) + Math.sin(seed * 1.91 + minute * 0.043) * 0.5;
  return x / 1.5;
}

export function fixtureQuote(symbol: string): RawQuote {
  const base = BASE_PRICES[symbol] ?? 100;
  const changePct = Number((drift(symbol) * 2.4).toFixed(2));
  const price = Number((base * (1 + changePct / 100)).toFixed(base < 1 ? 5 : 2));
  return {
    symbol,
    price,
    change: Number((price - base).toFixed(4)),
    changePct,
  };
}

export function fixtureQuotes(symbols: readonly string[]): RawQuote[] {
  return symbols.map(fixtureQuote);
}

export function fixtureSpark(symbol: string, points = 24): number[] {
  const base = BASE_PRICES[symbol] ?? 100;
  const now = Date.now();
  return Array.from({ length: points }, (_, i) => {
    const at = now - (points - 1 - i) * 15 * 60_000;
    return Number((base * (1 + (drift(symbol, at) * 2.4) / 100)).toFixed(base < 1 ? 5 : 2));
  });
}

const HEADLINES: Array<{
  cat: NewsItem['cat'];
  title: string;
  symbols: string[];
}> = [
  {
    cat: 'NEWS',
    title: 'Apple beats quarterly revenue estimates as services growth accelerates',
    symbols: ['AAPL'],
  },
  {
    cat: 'SEC',
    title: 'NVIDIA Corp. files 8-K disclosing new supply agreement',
    symbols: ['NVDA'],
  },
  {
    cat: 'NEWS',
    title: 'Tesla cuts delivery guidance, shares drop in extended trading',
    symbols: ['TSLA'],
  },
  {
    cat: 'CHAIN',
    title: 'Tokenized equity volume on Robinhood Chain sets a new weekly record',
    symbols: ['RCHAN'],
  },
  {
    cat: 'NEWS',
    title: 'Microsoft raises dividend and expands buyback program',
    symbols: ['MSFT'],
  },
  {
    cat: 'SEC',
    title: 'Coinbase Global receives subpoena tied to ongoing market probe',
    symbols: ['COIN'],
  },
  {
    cat: 'NEWS',
    title: 'Amazon logistics margins strong despite weak holiday guidance',
    symbols: ['AMZN'],
  },
  {
    cat: 'CHAIN',
    title: 'Liquidity on the main RCHAN pair deepens after market-maker rotation',
    symbols: ['RCHAN'],
  },
  {
    cat: 'NEWS',
    title: 'Meta upgraded to outperform on advertising recovery',
    symbols: ['META'],
  },
  {
    cat: 'NEWS',
    title: 'Alphabet fined by regulator over ad-tech bundling practices',
    symbols: ['GOOGL'],
  },
  {
    cat: 'SEC',
    title: 'Tesla Inc. files 10-Q for the third quarter',
    symbols: ['TSLA'],
  },
  {
    cat: 'CHAIN',
    title: 'Bridge throughput normalizes after scheduled sequencer upgrade',
    symbols: ['RCHAN'],
  },
];

export function fixtureNews(limit: number): NewsItem[] {
  const now = Date.now();
  return HEADLINES.slice(0, limit).map((h, i) => ({
    id: `fx_${i}_${Math.floor(now / 3_600_000)}`,
    cat: h.cat,
    title: h.title,
    short: shorten(h.title),
    symbols: h.symbols,
    sentiment: scoreSentiment(h.title),
    url: 'https://example.invalid/fixture',
    source: 'fixture — dev',
    publishedAt: new Date(now - i * 11 * 60_000).toISOString(),
    pinned: i < 6,
  }));
}

export function fixtureCalendar(): CalendarEvent[] {
  const today = new Date();
  const day = (offset: number) =>
    new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  return [
    {
      id: 'fx_cal_1',
      date: day(1),
      title: 'NVDA — Q3 report',
      subtitle: 'After market close · EPS estimate 1.24',
      kind: 'earnings',
      symbol: 'NVDA',
    },
    {
      id: 'fx_cal_2',
      date: day(2),
      title: 'US CPI release',
      subtitle: '08:30 ET · consensus 2.7% y/y',
      kind: 'macro',
      symbol: null,
    },
    {
      id: 'fx_cal_3',
      date: day(4),
      title: 'AAPL — Q4 report',
      subtitle: 'After market close · EPS estimate 2.38',
      kind: 'earnings',
      symbol: 'AAPL',
    },
    {
      id: 'fx_cal_4',
      date: day(6),
      title: 'FOMC rate decision',
      subtitle: '14:00 ET · market expects a hold',
      kind: 'macro',
      symbol: null,
    },
    {
      id: 'fx_cal_5',
      date: day(9),
      title: '$RCHAN treasury unlock',
      subtitle: 'Second tranche · tracked on the Buyback page',
      kind: 'chain',
      symbol: 'RCHAN',
    },
  ];
}

export function fixtureClips(): MediaClip[] {
  const now = Date.now();
  return [
    { title: 'Market close recap', channel: 'Bloomberg TV', mins: 8 },
    {
      title: "What's moving before the opening bell",
      channel: 'Yahoo Finance',
      mins: 12,
    },
    {
      title: 'Tokenized equity: who actually profits',
      channel: 'CoinDesk',
      mins: 17,
    },
    {
      title: 'Interview: where Fed policy goes next',
      channel: 'Reuters',
      mins: 21,
    },
  ].map((c, i) => ({
    id: `fx_clip_${i}`,
    title: c.title,
    channel: c.channel,
    videoId: '',
    durationSec: c.mins * 60,
    publishedAt: new Date(now - (i + 1) * 3 * 3_600_000).toISOString(),
    url: 'https://www.youtube.com/',
  }));
}

/** A float in [0, 1) that only depends on the string it's given. */
function unit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h += h << 13;
  h ^= h >>> 7;
  h += h << 3;
  h ^= h >>> 17;
  h += h << 5;
  return (h >>> 0) / 4294967296;
}

/** Roughly normal, from two deterministic uniforms (Box–Muller). */
function gauss(key: string): number {
  const u = Math.max(1e-9, unit(`${key}:a`));
  const v = unit(`${key}:b`);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Typical shares (or tokens) traded per day, for fixture volume. */
const DAILY_VOLUME: Record<string, number> = {
  AAPL: 52e6,
  NVDA: 210e6,
  TSLA: 95e6,
  MSFT: 21e6,
  AMZN: 41e6,
  META: 14e6,
  GOOGL: 27e6,
  COIN: 9e6,
  RCHAN: 38e6,
};

/**
 * Fake OHLCV bars for `RC_ENV=dev`. Each bar's return depends only on the
 * symbol, interval and bar time, so the chart keeps its shape from one run
 * to the next; the whole series is then scaled so the latest bar closes at
 * `anchor` — the current price — which moves the level, never the shape.
 */
export function fixtureCandles(
  symbol: string,
  interval: CandleInterval,
  anchor: number,
  count: number,
): Candle[] {
  const size = INTERVAL_SEC[interval];
  const last = bucketStart(Math.floor(Date.now() / 1000), interval);
  const sigma = (symbol === 'RCHAN' ? 0.06 : 0.018) * Math.sqrt(size / 86_400);
  const times = Array.from({ length: count }, (_, i) => last - (count - 1 - i) * size);
  const returns = times.map((t) => sigma * Math.max(-3, Math.min(3, gauss(`${symbol}:${interval}:${t}`))));

  // Walk back from the anchor: close[i] = close[i+1] / e^(r[i+1]).
  const closes = new Array<number>(count);
  closes[count - 1] = anchor;
  for (let i = count - 2; i >= 0; i -= 1) {
    closes[i] = (closes[i + 1] as number) / Math.exp(returns[i + 1] as number);
  }

  const perBar = ((DAILY_VOLUME[symbol] ?? 5e6) * size) / 86_400;
  const digits = anchor < 1 ? 6 : 2;
  const round = (n: number) => Number(n.toFixed(digits));
  return times.map((time, i) => {
    const close = closes[i] as number;
    const open = i === 0 ? close / Math.exp(returns[0] as number) : (closes[i - 1] as number);
    const wick = sigma * 0.6;
    const high = Math.max(open, close) * (1 + wick * unit(`${symbol}:${interval}:${time}:h`));
    const low = Math.min(open, close) * (1 - wick * unit(`${symbol}:${interval}:${time}:l`));
    // Busier on bigger moves, averaging ~1× the typical volume over a day.
    const activity = 0.4 + (0.75 * Math.abs(returns[i] as number)) / sigma;
    return {
      time,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(perBar * activity * (0.5 + unit(`${symbol}:${interval}:${time}:v`))),
    };
  });
}

/** Fake on-chain stats for the heat-score component while there's no contract address yet. */
export function fixtureOnchain(symbol: string): {
  volumeRatio: number;
  holderGrowth: number;
  liquidityHealth: number;
} {
  const d = drift(`${symbol}-onchain`);
  return {
    volumeRatio: 0.9 + d * 0.8,
    holderGrowth: 0.02 + d * 0.05,
    liquidityHealth: 0.55 + d * 0.35,
  };
}

export const FIXTURE_SYMBOLS = WATCHED_SYMBOLS;
export const FIXTURE_NAMES = SYMBOL_NAMES;
