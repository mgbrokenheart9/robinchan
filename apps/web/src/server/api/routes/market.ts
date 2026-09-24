import type { CandleSeries, MarketIndex, SymbolInfo, Ticker } from '@robinchan/shared';
import { CANDLE_INTERVALS, SYMBOLS, symbolInfo } from '@robinchan/shared';
import { readCandles } from '@robinchan/core';
import { z } from 'zod';

import { ApiFailure, FRESH_FOR, emptyEnvelope, envelope, readCached } from '../envelope';
import type { ApiRouter } from '../router';

const symbolParams = z.object({
  symbol: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[A-Za-z0-9.\-]+$/, 'symbol may only contain letters, digits, dots, and dashes'),
});

const candleQuery = z.object({
  interval: z.enum(CANDLE_INTERVALS).default('1H'),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});

export function marketRoutes(app: ApiRouter): void {
  // Top five tickers for the Home panel (brief §4).
  app.get('/api/market/snapshot', async () => {
    const hit = await readCached<Ticker[]>('market', 'snapshot');
    if (!hit) return emptyEnvelope<Ticker[]>([]);
    return envelope(hit.data, hit);
  });

  app.get('/api/market/indices', async () => {
    const hit = await readCached<MarketIndex[]>('market', 'indices');
    if (!hit) return emptyEnvelope<MarketIndex[]>([]);
    return envelope(hit.data, hit);
  });

  app.get('/api/market/quote/:symbol', async (request) => {
    const parsed = symbolParams.safeParse(request.params);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid symbol', 400);

    const symbol = parsed.data.symbol.toUpperCase();
    // Indices and $RCHAN are published together as one list.
    const indices = await readCached<MarketIndex[]>('market', 'indices');
    const index = indices?.data.find((i) => i.symbol === symbol);
    if (index && indices) {
      const ticker: Ticker = {
        symbol: index.symbol,
        name: index.name,
        price: index.price,
        change: index.change,
        changePct: index.changePct,
        currency: index.currency,
      };
      return envelope(ticker, indices);
    }
    const hit = await readCached<Ticker>('price', symbol);
    if (!hit) throw new ApiFailure('NOT_FOUND', `no price yet for ${symbol}`, 404);
    return envelope(hit.data, hit);
  });

  /** Every symbol the app can open, with whether it can be ordered (Trade §4). */
  app.get('/api/market/symbols', async () => envelope<SymbolInfo[]>(SYMBOLS, { stale: false }));

  /**
   * Chart bars (Trade §3). `from`/`to` are UNIX seconds. The worker writes
   * them; this only reads, with the last bar brought up to the latest price.
   */
  app.get('/api/market/candles/:symbol', async (request) => {
    const params = symbolParams.safeParse(request.params);
    const parsed = candleQuery.safeParse(request.query);
    if (!params.success || !parsed.success) {
      throw new ApiFailure('BAD_REQUEST', parsed.success ? 'invalid symbol' : (parsed.error.issues[0]?.message ?? 'invalid query'));
    }
    const symbol = params.data.symbol.toUpperCase();
    if (!symbolInfo(symbol)) throw new ApiFailure('NOT_FOUND', `${symbol} is not a known symbol`, 404);

    const { interval, from, to } = parsed.data;
    const read = await readCandles(symbol, interval, { from, to });
    if (!read) {
      return emptyEnvelope<CandleSeries>({ symbol, interval, candles: [], source: 'provider' });
    }
    return envelope(read.series, {
      stale: read.ageSec > (FRESH_FOR.candles ?? 600),
      asOf: new Date(Date.now() - read.ageSec * 1000).toISOString(),
    });
  });
}
