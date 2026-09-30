import { type ReactNode } from 'react';
import { cn } from '../lib/utils';

interface EmptyStateProps {
    icon: ReactNode;
    title: string;
    description?: string;
    className?: string;
}

export default function EmptyState({ icon, title, description, className }: EmptyStateProps) {
    return (
        <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
            <div className="mb-3 rounded-full bg-muted p-3 text-muted-foreground [&_svg]:size-5">{icon}</div>
            <p className="font-medium text-foreground">{title}</p>
            {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
        </div>
    );
}
