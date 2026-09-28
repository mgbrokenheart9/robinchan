import { callProvider, fetchJson } from './adapter.js';

/**
 * Yahoo Finance's spark endpoint: the regular-session price of up to twenty
 * symbols in one request, with when it printed — the Gap board's reference.
 * No key. Kept off Finnhub on purpose: its free plan's 60 calls a minute are
 * already spent on the Market strip, and forty more symbols would starve it.
 */
const SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';
const PER_REQUEST = 20;

export type LastPrice = { symbol: string; price: number; at: number };

type SparkBody = {
  spark?: {
    result?: Array<{
      symbol?: string;
      response?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number; currency?: string } }>;
    }>;
  };
};

export async function fetchLastPrices(symbols: readonly string[]): Promise<LastPrice[]> {
  const out: LastPrice[] = [];
  for (let i = 0; i < symbols.length; i += PER_REQUEST) {
    const chunk = symbols.slice(i, i + PER_REQUEST);
    const body = await callProvider({ id: 'yahoo-spark' }, () =>
      fetchJson<SparkBody>(`${SPARK}?symbols=${chunk.map(encodeURIComponent).join(',')}&range=1d&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (robinchan gap board)' },
      }),
    );
    for (const r of body.spark?.result ?? []) {
      const meta = r.response?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const at = meta?.regularMarketTime;
      if (!r.symbol || meta?.currency !== 'USD' || price == null || at == null || !(price > 0) || !(at > 0)) continue;
      out.push({ symbol: r.symbol, price, at });
    }
  }
  return out;
}
