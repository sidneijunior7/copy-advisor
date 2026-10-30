import { useState, type ReactNode } from 'react';
import { drawnBackground } from '../../lib/education';
import { cn } from '../../lib/utils';

// An image by link, or, without one (or when the link breaks), a poster drawn from the module's colors with the
// lesson's number and title, so a row of lessons never shows empty boxes
export default function Poster({ src, seed, number, title, className, children }: {
    src: string | null | undefined; seed: number; number?: number; title?: string; className?: string; children?: ReactNode;
}) {
    const [broken, setBroken] = useState<string | null>(null);
    const image = src && broken !== src ? src : null;
    return (
        <div className={cn('relative aspect-video overflow-hidden rounded-md bg-muted', className)}>
            {image ? (
                <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(image)}
                    className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105" />
            ) : (
                <div className="absolute inset-0 transition-transform duration-500 group-hover:scale-105" style={{ background: drawnBackground(seed) }}>
                    {number !== undefined && (
                        <span className="absolute -bottom-[0.18em] right-[0.08em] font-spartan text-[4.5rem] font-extrabold leading-none text-white/15 sm:text-[5.5rem]">
                            {number}
                        </span>
                    )}
                    {title && <p className="absolute left-2.5 right-10 top-2 line-clamp-2 text-xs font-semibold leading-snug text-white/90 sm:text-sm">{title}</p>}
                </div>
            )}
            {children}
        </div>
    );
}
