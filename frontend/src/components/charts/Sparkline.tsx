import { useWidth } from './useWidth';

// The cumulative result of a catalog card: a single line, no axes, a baseline at zero, as wide as the card.
// The numbers next to it say what it shows; it only gives the shape
export default function Sparkline({ values, label, height = 40 }: { values: number[]; label: string; height?: number }) {
    const [ref, width] = useWidth<HTMLDivElement>(240, 80);
    if (values.length < 2) {
        return <div style={{ height }} className="flex items-center text-xs text-muted-foreground">Sem histórico</div>;
    }
    const min = Math.min(0, ...values), max = Math.max(0, ...values);
    const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 6);
    const y = (v: number) => 2 + (1 - (v - min) / (max - min || 1)) * (height - 4);
    const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    return (
        <div ref={ref} className="w-full">
            <svg width={width} height={height} role="img" aria-label={label} className="block">
                <line x1={2} x2={width - 2} y1={y(0)} y2={y(0)} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.4} strokeWidth={1} />
                <path d={path} fill="none" stroke="var(--viz-series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3} fill="var(--viz-series-1)" stroke="hsl(var(--card))" strokeWidth={2} />
            </svg>
        </div>
    );
}
