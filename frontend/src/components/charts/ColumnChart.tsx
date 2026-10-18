import { useState } from 'react';
import { compact, niceTicks, useWidth } from './useWidth';

interface ColumnChartProps {
    data: { label: string; value: number }[];
    ariaLabel: string;
    formatValue: (v: number) => string;
    height?: number;
}

const MARGIN = { top: 12, right: 8, bottom: 28, left: 52 };
const MAX_COLUMN = 24;
const RADIUS = 4;

// A column per period growing from zero: above it gained (positive hue), below it lost (negative hue). The
// column is its own hover and focus target, the whole height of its band
export default function ColumnChart({ data, ariaLabel, formatValue, height = 220 }: ColumnChartProps) {
    const [ref, width] = useWidth<HTMLDivElement>();
    const [active, setActive] = useState<number | null>(null);
    if (data.length === 0) return null;

    const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
    const innerH = height - MARGIN.top - MARGIN.bottom;
    const ticks = niceTicks(Math.min(0, ...data.map(d => d.value)), Math.max(0, ...data.map(d => d.value)));
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const y = (v: number) => MARGIN.top + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;
    const band = innerW / data.length;
    const colW = Math.min(MAX_COLUMN, band * 0.6);
    const every = Math.ceil(36 / band); // Month labels that would collide are skipped; the tooltip has them all

    // Rounded at the data end, square at the baseline
    const column = (cx: number, value: number) => {
        const left = cx - colW / 2, right = cx + colW / 2, base = y(0), end = y(value);
        const r = Math.min(RADIUS, colW / 2, Math.abs(base - end));
        if (value >= 0) {
            return `M${left},${base}V${end + r}Q${left},${end} ${left + r},${end}H${right - r}Q${right},${end} ${right},${end + r}V${base}Z`;
        }
        return `M${left},${base}V${end - r}Q${left},${end} ${left + r},${end}H${right - r}Q${right},${end} ${right},${end - r}V${base}Z`;
    };

    const hovered = active != null ? data[active] : null;
    const tipLeft = active != null ? Math.min(Math.max(MARGIN.left + band * active + band / 2 + 12, 0), width - 160) : 0;

    return (
        <div ref={ref} className="relative">
            <svg width={width} height={height} role="group" aria-label={ariaLabel} className="block">
                {ticks.map(v => (
                    <g key={v}>
                        <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={y(v)} y2={y(v)} stroke="hsl(var(--border))" strokeWidth={1} />
                        <text x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                            {compact(v)}
                        </text>
                    </g>
                ))}
                <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={y(0)} y2={y(0)} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.6} strokeWidth={1} />
                {data.map((d, i) => {
                    const cx = MARGIN.left + band * i + band / 2;
                    return (
                        <g
                            key={d.label}
                            tabIndex={0}
                            role="img"
                            aria-label={`${d.label}: ${formatValue(d.value)}`}
                            className="outline-none"
                            onPointerEnter={() => setActive(i)}
                            onPointerLeave={() => setActive(null)}
                            onFocus={() => setActive(i)}
                            onBlur={() => setActive(null)}
                        >
                            <rect x={MARGIN.left + band * i} y={MARGIN.top} width={band} height={innerH} fill="transparent" />
                            {d.value !== 0 && (
                                <path
                                    d={column(cx, d.value)}
                                    fill={d.value > 0 ? 'var(--viz-positive)' : 'var(--viz-negative)'}
                                    style={{ filter: active === i ? 'brightness(1.15)' : undefined }}
                                />
                            )}
                            {i % every === 0 && (
                                <text x={cx} y={height - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">{d.label}</text>
                            )}
                        </g>
                    );
                })}
            </svg>
            {hovered && (
                <div
                    role="status"
                    className="pointer-events-none absolute top-2 z-10 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg"
                    style={{ left: tipLeft }}
                >
                    <p className="mb-1 text-muted-foreground">{hovered.label}</p>
                    <p className="flex items-center gap-2">
                        <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: hovered.value >= 0 ? 'var(--viz-positive)' : 'var(--viz-negative)' }} />
                        <strong className="font-semibold text-foreground">{formatValue(hovered.value)}</strong>
                    </p>
                </div>
            )}
        </div>
    );
}
