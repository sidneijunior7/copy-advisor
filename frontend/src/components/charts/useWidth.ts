import { useEffect, useRef, useState } from 'react';

// Width of the element, kept current: the charts draw in real pixels so marks keep their fixed sizes
export function useWidth<T extends HTMLElement>(initial = 640, min = 240) {
    const ref = useRef<T>(null);
    const [width, setWidth] = useState(initial);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new ResizeObserver(entries => setWidth(Math.max(min, Math.floor(entries[0].contentRect.width))));
        observer.observe(el);
        return () => observer.disconnect();
    }, [min]);
    return [ref, width] as const;
}

// Round tick values that cover [min, max]
export function niceTicks(min: number, max: number, count = 4): number[] {
    if (min === max) {
        const pad = Math.abs(min) || 1;
        min -= pad;
        max += pad;
    }
    const raw = (max - min) / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw) ?? 10 * magnitude;
    const ticks = [];
    for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
}

export const compact = (value: number) =>
    Math.abs(value) >= 1000
        ? value.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
        : value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
