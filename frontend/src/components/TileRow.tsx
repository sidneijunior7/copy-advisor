import { type ReactNode } from 'react';
import { cn } from '../lib/utils';

// A row of tiles: a horizontal slide edge to edge on phones, the grid in `className` from md up
export default function TileRow({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <div className={cn(
            '-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 scrollbar-none',
            '[&>*]:w-[42%] [&>*]:min-w-[9.5rem] [&>*]:shrink-0 [&>*]:snap-start',
            'md:mx-0 md:grid md:overflow-visible md:px-0 md:[&>*]:w-auto md:[&>*]:min-w-0',
            className,
        )}>
            {children}
        </div>
    );
}
