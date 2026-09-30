import { type HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const variants = {
    success: 'border-success/30 bg-success/10 text-success',
    destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    primary: 'border-primary/20 bg-primary/10 text-primary',
    muted: 'border-border bg-muted/50 text-muted-foreground',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
    variant?: keyof typeof variants;
}

export function Badge({ className, variant = 'muted', ...props }: BadgeProps) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold',
                variants[variant],
                className,
            )}
            {...props}
        />
    );
}
