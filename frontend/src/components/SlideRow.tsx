import { Children, type ReactNode } from 'react';
import { cn } from '../lib/utils';

// Rows that slide sideways edge to edge on phones, the grid in `className` from md up. Tiles show two
// and a bit; wide items (cards, charts) one, with the edge of the next peeking in to say there is more.
// More than `perRow` items split into even rows (7 are 4 + 3, not 5 + 2), each sliding on its own; from md
// up the rows step aside (display: contents) and every item sits in the one grid
export default function SlideRow({ className, wide = false, perRow = 5, children }: { className?: string; wide?: boolean; perRow?: number; children: ReactNode }) {
    const items = Children.toArray(children);
    const rows = Math.max(1, Math.ceil(items.length / perRow));
    const size = Math.ceil(items.length / rows);
    return (
        <div className={cn('flex flex-col gap-3 md:grid', className)}>
            {Array.from({ length: rows }, (_, r) => (
                <div
                    key={r}
                    className={cn(
                        '-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 scrollbar-none [&>*]:shrink-0 [&>*]:snap-start',
                        wide ? '[&>*]:w-[88%]' : '[&>*]:w-[42%] [&>*]:min-w-[9.5rem]',
                        'md:contents md:[&>*]:w-auto md:[&>*]:min-w-0',
                    )}
                >
                    {items.slice(r * size, (r + 1) * size)}
                </div>
            ))}
        </div>
    );
}
