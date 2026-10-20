import { type ReactNode } from 'react';
import { cn } from '../lib/utils';

// A row that slides sideways edge to edge on phones, the grid in `className` from md up. Tiles show two
// and a bit; wide items (charts) one, with the edge of the next peeking in to say there is more
export default function SlideRow({ className, wide = false, children }: { className?: string; wide?: boolean; children: ReactNode }) {
    return (
        <div className={cn(
            '-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 scrollbar-none [&>*]:shrink-0 [&>*]:snap-start',
            wide ? '[&>*]:w-[88%]' : '[&>*]:w-[42%] [&>*]:min-w-[9.5rem]',
            'md:mx-0 md:grid md:overflow-visible md:px-0 md:[&>*]:w-auto md:[&>*]:min-w-0',
            className,
        )}>
            {children}
        </div>
    );
}
