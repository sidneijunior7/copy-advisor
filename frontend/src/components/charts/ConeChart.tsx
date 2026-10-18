import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ConeBand } from '../../api';
import { signedPct as pctLabel } from '../../lib/money';
import { niceTicks, useWidth } from './useWidth';

interface ConeChartProps {
    bands: ConeBand[]; // One point per plotted trade number, live result included
    ariaLabel: string;
    height?: number;
}

const MARGIN = { top: 12, right: 16, bottom: 28, left: 52 };
const BAND = 'var(--viz-series-1)';
const LIVE = 'var(--viz-series-2)';

// The backtest's Monte Carlo cone (the middle 90% and 50% of the scenarios, and their median) with the live result
// drawn in it, by trade number. The pointer or the arrow keys pick a trade; the tooltip gives every line there
export default function ConeChart({ bands, ariaLabel, height = 260 }: ConeChartProps) {
    const [ref, width] = useWidth<HTMLDivElement>();
    const [active, setActive] = useState<number | null>(null);
    if (bands.length === 0) return null;

    const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
    const innerH = height - MARGIN.top - MARGIN.bottom;
    const k0 = 0, k1 = bands[bands.length - 1].k;
    const values = bands.flatMap(b => [b.p5, b.p95, b.live]).concat(0);
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const x = (k: number) => MARGIN.left + ((k - k0) / (k1 - k0 || 1)) * innerW;
    const y = (v: number) => MARGIN.top + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;
    // Every line starts at trade 0, at 0%
    const line = (pick: (b: ConeBand) => number) =>
        `M${x(0).toFixed(1)},${y(0).toFixed(1)}` + bands.map(b => `L${x(b.k).toFixed(1)},${y(pick(b)).toFixed(1)}`).join('');
    const area = (low: (b: ConeBand) => number, high: (b: ConeBand) => number) =>
        line(high) + [...bands].reverse().map(b => `L${x(b.k).toFixed(1)},${y(low(b)).toFixed(1)}`).join('') +
        `L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
    const xTicks = Array.from(new Set([0, 1, 2, 3, 4].map(i => Math.round((i / 4) * k1))));

    const nearest = (px: number) => {
        let best = 0;
        for (let i = 1; i < bands.length; i++) if (Math.abs(x(bands[i].k) - px) < Math.abs(x(bands[best].k) - px)) best = i;
        return best;
    };
    const onMove = (e: PointerEvent<SVGSVGElement>) => setActive(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left));
    const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
        if (e.key === 'ArrowLeft') setActive(i => Math.max(0, (i ?? bands.length - 1) - 1));
        else if (e.key === 'ArrowRight') setActive(i => Math.min(bands.length - 1, (i ?? 0) + 1));
        else if (e.key === 'Escape') setActive(null);
        else return;
        e.preventDefault();
    };
    const at = active != null ? bands[active] : null;
    const tipLeft = at ? Math.min(Math.max(x(at.k) + 12, 0), width - 230) : 0;
    const last = bands[bands.length - 1];

    return (
        <div ref={ref} className="relative">
            <ul className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <li className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-3 rounded-full" style={{ background: LIVE }} />Ao vivo (Master)</li>
                <li className="flex items-center gap-1.5"><span className="inline-block h-0 w-3 border-t-2 border-dashed" style={{ borderColor: BAND }} />Mediana do backtest</li>
                <li className="flex items-center gap-1.5"><span className="inline-block size-3 rounded-sm" style={{ background: BAND, opacity: 0.35 }} />50% dos cenários</li>
                <li className="flex items-center gap-1.5"><span className="inline-block size-3 rounded-sm" style={{ background: BAND, opacity: 0.15 }} />90% dos cenários</li>
            </ul>
            <svg
                width={width}
                height={height}
                role="img"
                aria-label={ariaLabel}
                tabIndex={0}
                className="block touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onPointerMove={onMove}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(bands.length - 1)}
                onBlur={() => setActive(null)}
                onKeyDown={onKey}
            >
                {ticks.map(v => (
                    <g key={v}>
                        <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={y(v)} y2={y(v)} stroke="hsl(var(--border))" strokeWidth={1} />
                        <text x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                            {v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
                        </text>
                    </g>
                ))}
                {y0 < 0 && y1 > 0 && (
                    <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={y(0)} y2={y(0)} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.6} strokeWidth={1} />
                )}
                {xTicks.map((k, i) => (
                    <text key={k} x={x(k)} y={height - 8} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
                        className="fill-muted-foreground text-[11px] tabular-nums">
                        {k === 0 ? 'operação 0' : k}
                    </text>
                ))}
                <path d={area(b => b.p5, b => b.p95)} fill={BAND} fillOpacity={0.12} />
                <path d={area(b => b.p25, b => b.p75)} fill={BAND} fillOpacity={0.22} />
                <path d={line(b => b.p50)} fill="none" stroke={BAND} strokeWidth={1.5} strokeDasharray="5 4" />
                <path d={line(b => b.live)} fill="none" stroke={LIVE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={x((at ?? last).k)} cy={y((at ?? last).live)} r={4} fill={LIVE} stroke="hsl(var(--card))" strokeWidth={2} />
                {at && <line x1={x(at.k)} x2={x(at.k)} y1={MARGIN.top} y2={MARGIN.top + innerH} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} strokeWidth={1} />}
            </svg>
            {at && (
                <div role="status" className="pointer-events-none absolute top-8 z-10 min-w-52 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg"
                    style={{ left: tipLeft }}>
                    <p className="mb-1 text-muted-foreground">Depois de {at.k} {at.k === 1 ? 'operação' : 'operações'}</p>
                    <p className="flex items-center gap-2">
                        <span className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: LIVE }} />
                        <strong className="font-semibold text-foreground">{pctLabel(at.live)}</strong> ao vivo
                    </p>
                    <p className="text-muted-foreground">Mediana do backtest: {pctLabel(at.p50)}</p>
                    <p className="text-muted-foreground">50% dos cenários: {pctLabel(at.p25)} a {pctLabel(at.p75)}</p>
                    <p className="text-muted-foreground">90% dos cenários: {pctLabel(at.p5)} a {pctLabel(at.p95)}</p>
                </div>
            )}
        </div>
    );
}
