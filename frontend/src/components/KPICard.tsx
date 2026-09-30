import { type ReactNode } from 'react';
import { cn } from '../lib/utils';

interface KPICardProps {
    label: string;
    value: ReactNode;
    subValue?: ReactNode;
    icon?: ReactNode;
    valueClassName?: string;
}

export default function KPICard({ label, value, subValue, icon, valueClassName }: KPICardProps) {
    return (
        <div className="kpi-card animate-fade-in">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                    <p className="kpi-label">{label}</p>
                    <p className={cn('kpi-value truncate', valueClassName)}>{value}</p>
                    {subValue && <p className="truncate text-xs text-muted-foreground">{subValue}</p>}
                </div>
                {icon && <div className="hidden shrink-0 rounded-lg sm:block bg-primary/10 p-2.5 text-primary [&_svg]:size-4">{icon}</div>}
            </div>
        </div>
    );
}
