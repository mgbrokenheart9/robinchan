'use client';

import { useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { PortfolioPoint } from '@robinchan/shared';

import { useThemeColors, withAlpha } from './useThemeColors';

/**
 * The portfolio value line (Portfolio §7): one line, mint, a thin gradient
 * under it — never one line per asset, which stops being readable past
 * three holdings. `lightweight-charts` is loaded on demand so pages without
 * a chart don't carry it.
 */
export function ValueChart({ points, height = 260 }: { points: PortfolioPoint[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Area'> | null>(null);
  const [ready, setReady] = useState(false);
  const colors = useThemeColors();

  // Create once.
  useEffect(() => {
    let disposed = false;
    void import('lightweight-charts').then(({ createChart, AreaSeries, CrosshairMode }) => {
      if (disposed || !box.current) return;
      chart.current = createChart(box.current, {
        autoSize: true,
        // Attribution is given in text next to the chart (<ChartAttribution>),
        // which the library's license allows in place of its logo.
        layout: { background: { color: 'transparent' }, attributionLogo: false, fontFamily: 'var(--font-mono), ui-monospace, monospace' },
        crosshair: { mode: CrosshairMode.Magnet },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        handleScroll: false,
        handleScale: false,
      });
      series.current = chart.current.addSeries(AreaSeries, { lineWidth: 2, priceLineVisible: false });
      setReady(true);
    });
    return () => {
      disposed = true;
      chart.current?.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // Theme and data, whenever either changes.
  useEffect(() => {
    if (!ready || !chart.current || !series.current || !colors) return;
    chart.current.applyOptions({
      layout: { textColor: colors.text3 },
      grid: { vertLines: { visible: false }, horzLines: { color: withAlpha(colors.text3, 0.12) } },
    });
    series.current.applyOptions({
      lineColor: colors.up,
      topColor: withAlpha(colors.up, colors.dark ? 0.22 : 0.18),
      bottomColor: withAlpha(colors.up, 0),
    });
    // The library needs strictly increasing times; a live point landing on
    // the same second as the last bar replaces it.
    const byTime = new Map<number, number>();
    for (const p of [...points].sort((a, b) => a.time - b.time)) byTime.set(p.time, p.value);
    series.current.setData([...byTime].map(([time, value]) => ({ time: time as UTCTimestamp, value })));
    chart.current.timeScale().fitContent();
  }, [ready, points, colors]);

  return <div ref={box} style={{ height }} className="w-full" />;
}

/** Credit for the chart library, given in text in place of its logo. */
export function ChartAttribution() {
  return (
    <a
      href="https://www.tradingview.com/"
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-[10px] text-text-3 transition-colors hover:text-text-2"
    >
      Charts: TradingView Lightweight Charts™
    </a>
  );
}
