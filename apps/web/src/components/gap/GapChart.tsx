'use client';

import { useId, useMemo, useState } from 'react';
import { formatPct } from '@robinchan/shared';

import { cx } from '@/components/ui';

const W = 600;
const H = 168;
const PAD = 10;

/**
 * A row's gap over time: the zero line is the stock's own price, the area
 * above it green (the token priced higher on chain), below it red. Plain
 * SVG stretched to its box — strokes keep their width — with a crosshair
 * that reads out the point under the pointer.
 */
export function GapChart({ points, className }: { points: Array<[number, number]>; className?: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = (points[0] as [number, number])[0];
    const t1 = (points.at(-1) as [number, number])[0];
    const values = points.map((p) => p[1]);
    const bound = Math.max(0.25, ...values.map(Math.abs)) * 1.15;
    const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD * 2);
    const y = (v: number) => H / 2 - (v / bound) * (H / 2 - PAD);
    const line = points.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const zero = y(0);
    const area = `${x(t0).toFixed(1)},${zero} ${line} ${x(t1).toFixed(1)},${zero}`;
    return { t0, t1, bound, x, y, line, area, zero };
  }, [points]);

  if (!geo) {
    return (
      <div className={cx('flex h-[168px] items-center justify-center rounded-tile border border-dashed border-border text-center text-[12.5px] text-text-3', className)}>
        The chart fills in as the board runs: one point every ten minutes.
      </div>
    );
  }

  const shown = hover != null ? points[hover] : points.at(-1);
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = geo.t0 + ((e.clientX - box.left) / box.width) * (geo.t1 - geo.t0);
    let best = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (Math.abs((points[i] as [number, number])[0] - t) < Math.abs((points[best] as [number, number])[0] - t)) best = i;
    }
    setHover(best);
  };

  const when = (sec: number) =>
    new Date(sec * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  return (
    <div className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-3 font-mono text-[11px] text-text-3">
        <span>
          {shown ? (
            <>
              <span className={cx('text-[13px]', shown[1] > 0 ? 'text-up' : shown[1] < 0 ? 'text-down' : 'text-text-2')}>{formatPct(shown[1])}</span>
              <span className="ml-2">{when(shown[0])}</span>
            </>
          ) : null}
        </span>
        <span>±{geo.bound.toFixed(2)}% scale</span>
      </div>
      <div
        className="relative h-[168px] touch-none overflow-hidden rounded-tile bg-surface-2/60"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Gap over time, from ${formatPct((points[0] as [number, number])[1])} to ${formatPct((points.at(-1) as [number, number])[1])}`}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <clipPath id={`${id}-above`}>
              <rect x="0" y="0" width={W} height={geo.zero} />
            </clipPath>
            <clipPath id={`${id}-below`}>
              <rect x="0" y={geo.zero} width={W} height={H - geo.zero} />
            </clipPath>
          </defs>
          <line x1="0" x2={W} y1={geo.zero} y2={geo.zero} style={{ stroke: 'rgb(var(--c-text-3))' }} strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <g clipPath={`url(#${id}-above)`}>
            <polygon points={geo.area} style={{ fill: 'rgb(var(--c-up) / 0.16)' }} />
            <polyline points={geo.line} fill="none" style={{ stroke: 'rgb(var(--c-up))' }} strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
          <g clipPath={`url(#${id}-below)`}>
            <polygon points={geo.area} style={{ fill: 'rgb(var(--c-down) / 0.14)' }} />
            <polyline points={geo.line} fill="none" style={{ stroke: 'rgb(var(--c-down))' }} strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
          {hover != null ? (
            <line
              x1={geo.x((points[hover] as [number, number])[0])}
              x2={geo.x((points[hover] as [number, number])[0])}
              y1="0"
              y2={H}
              style={{ stroke: 'rgb(var(--c-text-2))' }}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <span className="pointer-events-none absolute left-2 top-1.5 font-mono text-[10px] text-text-3">token above</span>
        <span className="pointer-events-none absolute bottom-1.5 left-2 font-mono text-[10px] text-text-3">token below</span>
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-text-3">
        <span>{when(geo.t0)}</span>
        <span>now</span>
      </div>
    </div>
  );
}
