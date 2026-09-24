'use client';

import { useEffect, useRef, useState } from 'react';
import type { IChartApi, IPriceLine, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '@robinchan/shared';

import { useThemeColors, withAlpha } from './useThemeColors';

export type PriceLineSpec = { id: string; price: number; side: 'buy' | 'sell'; label: string };

/**
 * Candlesticks with `lightweight-charts` (Trade §3) — open source and
 * light, in the page's own styling rather than TradingView's embedded
 * widget. Resting limit orders are drawn as dashed horizontal lines.
 */
export function CandleChart({
  candles,
  fitKey,
  lines,
  height = 420,
}: {
  candles: Candle[];
  /** Changes when the view should reset to fit — the symbol and interval. */
  fitKey: string;
  lines: PriceLineSpec[];
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const lineStyle = useRef<number>(2);
  const [ready, setReady] = useState(false);
  const colors = useThemeColors();
  const fitted = useRef<string>('');

  useEffect(() => {
    let disposed = false;
    void import('lightweight-charts').then(({ createChart, CandlestickSeries, HistogramSeries, CrosshairMode, LineStyle }) => {
      if (disposed || !box.current) return;
      lineStyle.current = LineStyle.Dashed;
      chart.current = createChart(box.current, {
        autoSize: true,
        // Attribution is given in text next to the chart instead of the logo.
        layout: { background: { color: 'transparent' }, attributionLogo: false, fontFamily: 'var(--font-mono), ui-monospace, monospace' },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      });
      series.current = chart.current.addSeries(CandlestickSeries, { priceLineVisible: true });
      volume.current = chart.current.addSeries(HistogramSeries, {
        priceScaleId: 'volume',
        priceFormat: { type: 'volume' },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.current.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      setReady(true);
    });
    return () => {
      disposed = true;
      chart.current?.remove();
      chart.current = null;
      series.current = null;
      volume.current = null;
      priceLines.current = [];
    };
  }, []);

  // Theme.
  useEffect(() => {
    if (!ready || !chart.current || !series.current || !volume.current || !colors) return;
    chart.current.applyOptions({
      layout: { textColor: colors.text3 },
      grid: { vertLines: { color: withAlpha(colors.text3, 0.08) }, horzLines: { color: withAlpha(colors.text3, 0.1) } },
      crosshair: {
        vertLine: { color: withAlpha(colors.text3, 0.5), labelBackgroundColor: colors.text2 },
        horzLine: { color: withAlpha(colors.text3, 0.5), labelBackgroundColor: colors.text2 },
      },
    });
    series.current.applyOptions({
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
  }, [ready, colors]);

  // Data.
  useEffect(() => {
    if (!ready || !series.current || !volume.current || !colors) return;
    series.current.setData(
      candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    volume.current.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: withAlpha(c.close >= c.open ? colors.up : colors.down, 0.28),
      })),
    );
    // Refit only when the symbol or interval changes, not on every poll —
    // otherwise a user who zoomed in gets thrown back out every 30 seconds.
    if (candles.length && fitted.current !== fitKey) {
      chart.current?.timeScale().fitContent();
      fitted.current = fitKey;
    }
  }, [ready, candles, fitKey, colors]);

  // Limit order lines.
  useEffect(() => {
    if (!ready || !series.current || !colors) return;
    for (const line of priceLines.current) series.current.removePriceLine(line);
    priceLines.current = lines.map((l) =>
      (series.current as ISeriesApi<'Candlestick'>).createPriceLine({
        price: l.price,
        color: l.side === 'buy' ? colors.up : colors.down,
        lineWidth: 1,
        lineStyle: lineStyle.current,
        axisLabelVisible: true,
        title: l.label,
      }),
    );
  }, [ready, lines, colors]);

  return <div ref={box} style={{ height }} className="w-full" />;
}
