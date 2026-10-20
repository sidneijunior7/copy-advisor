import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { compact, niceTicks, useWidth } from './useWidth';

export type LineSeries = { key: string; label: string; color: string; points: { t: number; v: number }[] };

interface LineChartProps {
    series: LineSeries[]; // Same timestamps in every series
    ariaLabel: string;
    formatValue: (v: number) => string;
    formatTime: (t: number) => string;
    height?: number;
    zeroLine?: boolean; // A baseline at 0: above it gained, below it lost
    area?: boolean; // A 10% wash under a single series
}

const MARGIN = { top: 12, right: 16, bottom: 28, left: 52 };
const END_LABEL = 84; // Room for the direct labels of a multi-series chart

// Lines over time with a crosshair: the pointer (or the arrow keys) picks the nearest point, the tooltip lists
// every series there
export default function LineChart({ series, ariaLabel, formatValue, formatTime, height = 240, zeroLine = false, area = false }: LineChartProps) {
    const [ref, width] = useWidth<HTMLDivElement>();
    const [active, setActive] = useState<number | null>(null);
    const base = series[0]?.points ?? [];
    if (base.length === 0) return null;

    const multi = series.length > 1;
    const right = MARGIN.right + (multi ? END_LABEL : 0);
    const innerW = Math.max(40, width - MARGIN.left - right);
    const innerH = height - MARGIN.top - MARGIN.bottom;
    const ts = base.map(p => p.t);
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    const values = series.flatMap(s => s.points.map(p => p.v)).concat(zeroLine ? [0] : []);
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const x = (t: number) => MARGIN.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
    const y = (v: number) => MARGIN.top + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;
    const path = (s: LineSeries) => s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const floor = zeroLine && y0 <= 0 && y1 >= 0 ? y(0) : MARGIN.top + innerH;
    // A date label takes ~70 px: as many as fit, from two on a phone to four
    const nx = Math.max(2, Math.min(4, Math.floor(innerW / 90) + 1));
    // Evenly spaced in time, not by point: points can bunch up, and their labels with them
    const xTicks = t1 === t0 ? [t0] : Array.from({ length: nx }, (_, i) => t0 + (i / (nx - 1)) * (t1 - t0));

    const nearest = (px: number) => {
        let best = 0;
        for (let i = 1; i < base.length; i++) if (Math.abs(x(base[i].t) - px) < Math.abs(x(base[best].t) - px)) best = i;
        return best;
    };
    const onMove = (e: PointerEvent<SVGSVGElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setActive(nearest(e.clientX - rect.left));
    };
    const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
        if (e.key === 'ArrowLeft') setActive(i => Math.max(0, (i ?? base.length - 1) - 1));
        else if (e.key === 'ArrowRight') setActive(i => Math.min(base.length - 1, (i ?? 0) + 1));
        else if (e.key === 'Escape') setActive(null);
        else return;
        e.preventDefault();
    };

    const at = active != null ? base[active] : null;
    const tipLeft = at ? Math.min(Math.max(x(at.t) + 12, 0), width - 180) : 0;

    return (
        <div ref={ref} className="relative">
            {multi && (
                <ul className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                    {series.map(s => (
                        <li key={s.key} className="flex items-center gap-1.5">
                            <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                            {s.label}
                        </li>
                    ))}
                </ul>
            )}
            <svg
                width={width}
                height={height}
                role="img"
                aria-label={ariaLabel}
                tabIndex={0}
                className="block outline-none focus-visible:ring-2 focus-visible:ring-ring md:touch-none"
                // On touch the page and the slides keep their swipe: a tap shows the point, a tap elsewhere hides it
                onPointerDown={onMove}
                onPointerMove={onMove}
                onPointerLeave={e => { if (e.pointerType !== 'touch') setActive(null); }}
                onFocus={e => { if (e.currentTarget.matches(':focus-visible')) setActive(base.length - 1); }} // From the keyboard, not a tap
                onBlur={() => setActive(null)}
                onKeyDown={onKey}
            >
                {ticks.map(v => (
                    <g key={v}>
                        <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={y(v)} y2={y(v)} stroke="hsl(var(--border))" strokeWidth={1} />
                        <text x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                            {compact(v)}
                        </text>
                    </g>
                ))}
                {zeroLine && y0 < 0 && y1 > 0 && (
                    <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={y(0)} y2={y(0)} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.6} strokeWidth={1} />
                )}
                {xTicks.map((t, i) => (
                    // The first and last labels stay inside the plot instead of spilling over its edges
                    <text key={t} x={x(t)} y={height - 8} textAnchor={xTicks.length > 1 && i === 0 ? 'start' : i === xTicks.length - 1 && xTicks.length > 1 ? 'end' : 'middle'}
                        className="fill-muted-foreground text-[11px] tabular-nums">
                        {formatTime(t)}
                    </text>
                ))}
                {area && !multi && (
                    <path
                        d={`${path(series[0])}L${x(t1).toFixed(1)},${floor.toFixed(1)}L${x(t0).toFixed(1)},${floor.toFixed(1)}Z`}
                        fill={series[0].color}
                        fillOpacity={0.1}
                    />
                )}
                {series.map(s => (
                    <path key={s.key} d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {multi && series.map(s => {
                    const last = s.points[s.points.length - 1];
                    return (
                        <text key={s.key} x={x(last.t) + 10} y={y(last.v)} dy="0.32em" className="fill-muted-foreground text-[11px]">
                            {s.label}
                        </text>
                    );
                })}
                {series.map(s => {
                    const p = at ? s.points.find(q => q.t === at.t) : s.points[s.points.length - 1];
                    return p && (at || multi || s.points.length === 1) ? (
                        <circle key={s.key} cx={x(p.t)} cy={y(p.v)} r={4} fill={s.color} stroke="hsl(var(--card))" strokeWidth={2} />
                    ) : null;
                })}
                {at && <line x1={x(at.t)} x2={x(at.t)} y1={MARGIN.top} y2={MARGIN.top + innerH} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} strokeWidth={1} />}
            </svg>
            {at && (
                <div
                    role="status"
                    className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg"
                    style={{ left: tipLeft }}
                >
                    <p className="mb-1 text-muted-foreground">{formatTime(at.t)}</p>
                    {series.map(s => {
                        const p = s.points.find(q => q.t === at.t);
                        return p ? (
                            <p key={s.key} className="flex items-center gap-2">
                                <span className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
                                <strong className="font-semibold text-foreground">{formatValue(p.v)}</strong>
                                {multi && <span className="text-muted-foreground">{s.label}</span>}
                            </p>
                        ) : null;
                    })}
                </div>
            )}
        </div>
    );
}
