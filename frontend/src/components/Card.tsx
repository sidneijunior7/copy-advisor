
import { type ReactNode } from 'react';
import { cn } from '../lib/utils';

interface CardProps {
    children: ReactNode;
    title?: string;
    description?: string;
    icon?: ReactNode;
    action?: ReactNode;
    className?: string;
    /** Drop the body padding, for tables that run edge to edge */
    flush?: boolean;
}

export default function Card({ children, title, description, icon, action, className, flush = false }: CardProps) {
    return (
        <section className={cn('panel', className)}>
            {title && (
                <header className="flex flex-wrap items-start justify-between gap-4 p-5 pb-0">
                    <div className="flex items-center gap-3">
                        {icon && (
                            <div className="shrink-0 rounded-lg bg-primary/10 p-2 text-primary [&_svg]:size-4">{icon}</div>
                        )}
                        <div>
                            <h2 className="font-semibold leading-tight text-foreground">{title}</h2>
                            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
                        </div>
                    </div>
                    {action}
                </header>
            )}
            <div className={flush ? 'pt-4' : 'p-5'}>{children}</div>
        </section>
    );
}
