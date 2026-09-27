'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, IPriceLine, ISeriesApi, MouseEventParams, Time, UTCTimestamp } from 'lightweight-charts';
import type { Candle, CandleInterval } from '@robinchan/shared';
import { formatPct, formatPriceSmart } from '@robinchan/shared';

import { cx } from '@/components/ui';
import { useThemeColors, withAlpha } from './useThemeColors';

export type PriceLineSpec = { id: string; price: number; side: 'buy' | 'sell'; label: string };

/** `area` is a stepped line — how an oracle price actually moves; `candles` is OHLC. */
export type ChartMode = 'area' | 'candles';

/**
 * Price chart with `lightweight-charts` (Trade §3) — open source and light,
 * in the page's own styling rather than TradingView's embedded widget.
 *
 * Chainlink publishes only on a 0.5% move or a heartbeat, so most bars are
 * flat and a candle chart reads as a row of dashes. The default `area` mode
 * draws the price as the step it is, tinted by the period's direction; the
 * legend in the corner follows the crosshair. Position lines (entry,
 * liquidation) are dashed in either mode. Oracle bars have no volume, so the
 * volume pane only appears when some bar carries it.
 */
export function CandleChart({
  candles,
  fitKey,
  lines,
  interval,
  mode = 'area',
  height = 420,
}: {
  candles: Candle[];
  /** Changes when the view should reset to fit — the symbol and interval. */
  fitKey: string;
  lines: PriceLineSpec[];
  interval: CandleInterval;
  mode?: ChartMode;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const area = useRef<ISeriesApi<'Area'> | null>(null);
  const bars = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLines = useRef<{ series: ISeriesApi<'Area'> | ISeriesApi<'Candlestick'>; line: IPriceLine }[]>([]);
  const lineStyle = useRef<number>(2);
  const [ready, setReady] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const colors = useThemeColors();
  const pulse = useRef<{ on: number; off: number }>({ on: 0, off: 0 });
  const fitted = useRef<string>('');

  const hasVolume = useMemo(() => candles.some((c) => c.volume > 0), [candles]);
  const byTime = useMemo(() => new Map(candles.map((c) => [c.time, c])), [candles]);
  const first = candles[0];
  const last = candles.at(-1);
  const rising = !first || !last || last.close >= first.open;
  const precision = useMemo(() => pricePrecision(last?.close), [last?.close]);

  useEffect(() => {
    let disposed = false;
    void import('lightweight-charts').then(
      ({ createChart, AreaSeries, CandlestickSeries, HistogramSeries, CrosshairMode, LineStyle, LineType, LastPriceAnimationMode }) => {
        if (disposed || !box.current) return;
        lineStyle.current = LineStyle.Dashed;
        pulse.current = { on: LastPriceAnimationMode.Continuous, off: LastPriceAnimationMode.Disabled };
        chart.current = createChart(box.current, {
          autoSize: true,
          // Attribution is given in text next to the chart instead of the logo.
          layout: {
            background: { color: 'transparent' },
            attributionLogo: false,
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            fontSize: 11,
          },
          crosshair: { mode: CrosshairMode.Magnet },
          rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.18, bottom: 0.08 } },
          timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 6, minBarSpacing: 2 },
        });
        area.current = chart.current.addSeries(AreaSeries, {
          lineWidth: 2,
          lineType: LineType.WithSteps,
          lastPriceAnimation: LastPriceAnimationMode.Continuous,
          crosshairMarkerRadius: 4,
          crosshairMarkerBorderWidth: 2,
          priceLineStyle: LineStyle.Dotted,
        });
        bars.current = chart.current.addSeries(CandlestickSeries, { priceLineStyle: LineStyle.Dotted, visible: false });
        volume.current = chart.current.addSeries(HistogramSeries, {
          priceScaleId: 'volume',
          priceFormat: { type: 'volume' },
          lastValueVisible: false,
          priceLineVisible: false,
          visible: false,
        });
        chart.current.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
        chart.current.subscribeCrosshairMove(onMove);
        setReady(true);
      },
    );
    function onMove(param: MouseEventParams<Time>) {
      setHoverTime(typeof param.time === 'number' && param.point ? param.time : null);
    }
    return () => {
      disposed = true;
      chart.current?.unsubscribeCrosshairMove(onMove);
      chart.current?.remove();
      chart.current = null;
      area.current = null;
      bars.current = null;
      volume.current = null;
      priceLines.current = [];
    };
  }, []);

  // Theme, mode and direction.
  useEffect(() => {
    if (!ready || !chart.current || !area.current || !bars.current || !volume.current || !colors) return;
    const tone = rising ? colors.up : colors.down;
    const priceFormat = { type: 'price' as const, precision, minMove: 10 ** -precision };
    chart.current.applyOptions({
      layout: { textColor: colors.text3 },
      grid: { vertLines: { visible: false }, horzLines: { color: withAlpha(colors.text3, 0.09) } },
      crosshair: {
        vertLine: { color: withAlpha(colors.text3, 0.45), labelBackgroundColor: colors.text },
        horzLine: { color: withAlpha(colors.text3, 0.45), labelBackgroundColor: colors.text },
      },
      rightPriceScale: { scaleMargins: { top: 0.18, bottom: hasVolume && mode === 'candles' ? 0.2 : 0.08 } },
    });
    area.current.applyOptions({
      visible: mode === 'area',
      // The pulse draws even on a hidden series.
      lastPriceAnimation: mode === 'area' ? pulse.current.on : pulse.current.off,
      priceFormat,
      lineColor: tone,
      topColor: withAlpha(tone, colors.dark ? 0.28 : 0.22),
      bottomColor: withAlpha(tone, 0),
      crosshairMarkerBackgroundColor: tone,
      crosshairMarkerBorderColor: colors.surface,
      priceLineColor: tone,
    });
    bars.current.applyOptions({
      visible: mode === 'candles',
      priceFormat,
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    volume.current.applyOptions({ visible: hasVolume && mode === 'candles' });
  }, [ready, colors, mode, rising, precision, hasVolume]);

  // Data.
  useEffect(() => {
    if (!ready || !area.current || !bars.current || !volume.current || !colors) return;
    area.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
    bars.current.setData(
      candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    volume.current.setData(
      hasVolume
        ? candles.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: withAlpha(c.close >= c.open ? colors.up : colors.down, 0.28),
          }))
        : [],
    );
    // Refit only when the symbol or interval changes, not on every poll —
    // otherwise a user who zoomed in gets thrown back out every 30 seconds.
    if (candles.length && fitted.current !== fitKey) {
      chart.current?.timeScale().fitContent();
      fitted.current = fitKey;
    }
  }, [ready, candles, fitKey, colors, hasVolume]);

  // Position lines, on whichever series is showing.
  useEffect(() => {
    if (!ready || !area.current || !bars.current || !colors) return;
    for (const { series, line } of priceLines.current) series.removePriceLine(line);
    const target = mode === 'area' ? area.current : bars.current;
    priceLines.current = lines.map((l) => ({
      series: target,
      line: target.createPriceLine({
        price: l.price,
        color: l.side === 'buy' ? colors.up : colors.down,
        lineWidth: 1,
        lineStyle: lineStyle.current,
        axisLabelVisible: true,
        title: l.label,
      }),
    }));
  }, [ready, lines, colors, mode]);

  // The legend shows the hovered bar, or the latest one with the period's range.
  const hover = hoverTime == null ? undefined : byTime.get(hoverTime);
  const shown = hover ?? last;
  const base = first?.open;
  const change = shown && base ? ((shown.close - base) / base) * 100 : null;
  const range = useMemo(
    () => (candles.length ? { high: Math.max(...candles.map((c) => c.high)), low: Math.min(...candles.map((c) => c.low)) } : null),
    [candles],
  );

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={box} className="absolute inset-0" />
      {shown ? (
        <div className="pointer-events-none absolute left-3 top-2 z-10 flex flex-col gap-0.5 font-mono tabular-nums">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] leading-tight text-text">{formatPriceSmart(shown.close)}</span>
            {change != null ? (
              <span className={cx('text-[12px]', change >= 0 ? 'text-up' : 'text-down')}>
                {formatPct(change)}
                <span className="ml-1 text-text-3">{hover ? 'vs. start' : 'this view'}</span>
              </span>
            ) : null}
          </div>
          {mode === 'candles' || hover ? (
            <div className="flex flex-wrap gap-x-2.5 text-[10.5px] text-text-3">
              <span className="text-text-2">{formatBarTime(shown.time, interval)}</span>
              {mode === 'candles' ? (
                <>
                  <Ohlc label="O" value={shown.open} />
                  <Ohlc label="H" value={shown.high} />
                  <Ohlc label="L" value={shown.low} />
                  <Ohlc label="C" value={shown.close} />
                </>
              ) : null}
            </div>
          ) : range ? (
            <div className="flex gap-x-2.5 text-[10.5px] text-text-3">
              <Ohlc label="High" value={range.high} />
              <Ohlc label="Low" value={range.low} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Ohlc({ label, value }: { label: string; value: number }) {
  return (
    <span>
      {label} <span className="text-text-2">{formatPriceSmart(value)}</span>
    </span>
  );
}

/** Decimals the price axis needs: two at a dollar and up, more below. */
function pricePrecision(price: number | undefined): number {
  if (!price || !Number.isFinite(price) || price >= 1) return 2;
  return Math.min(8, Math.max(2, 2 - Math.floor(Math.log10(price)) + 1));
}

/** Bar times are UTC, as on the chart's own axis. */
function formatBarTime(sec: number, interval: CandleInterval): string {
  const d = new Date(sec * 1000);
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (interval === '1D') return day;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${day}, ${time} UTC`;
}
