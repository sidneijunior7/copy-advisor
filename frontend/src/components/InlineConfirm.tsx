import { type ReactNode } from 'react';
import { Button } from './ui/Button';
import { cn } from '../lib/utils';

interface InlineConfirmProps {
    /** What happens if the user confirms */
    children: ReactNode;
    confirmLabel: string;
    icon?: ReactNode;
    loading?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    className?: string;
}

// Destructive confirmation shown in place, under the row it acts on
export default function InlineConfirm({ children, confirmLabel, icon, loading = false, onConfirm, onCancel, className }: InlineConfirmProps) {
    return (
        <div
            role="alert"
            className={cn(
                'flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 sm:flex-row sm:items-center sm:justify-between',
                className,
            )}
        >
            <p className="text-sm text-foreground">{children}</p>
            <div className="flex shrink-0 justify-end gap-1">
                <Button type="button" variant="destructive" size="sm" loading={loading} onClick={onConfirm}>
                    {!loading && icon} {confirmLabel}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={onCancel}>
                    Cancelar
                </Button>
            </div>
        </div>
    );
}
