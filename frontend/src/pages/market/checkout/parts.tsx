import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Badge } from '../../../components/ui/Badge';
import { Button, type ButtonProps } from '../../../components/ui/Button';
import { cn } from '../../../lib/utils';

export function StepHeader({ badge, icon, title, children }: { badge: string; icon: ReactNode; title: ReactNode; children?: ReactNode }) {
    return (
        <div className="space-y-2 text-center">
            <Badge variant="primary">{icon} {badge}</Badge>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            {children && <div className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">{children}</div>}
        </div>
    );
}

// The step's one primary action: in the flow on a wide screen, fixed at the bottom on a phone, where the thumb is.
// The note under it (trust, what happens next) goes along in both
export function StepCta({ note, ...props }: ButtonProps & { note?: ReactNode }) {
    return (
        <>
            <div className="hidden space-y-3 sm:block">
                <Button size="lg" className="w-full" {...props} />
                {note && <div className="text-center text-xs text-muted-foreground">{note}</div>}
            </div>
            {note && <div className="text-center text-xs text-muted-foreground sm:hidden">{note}</div>}
            <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 py-3 backdrop-blur sm:hidden">
                <Button size="lg" className="w-full" {...props} />
            </div>
        </>
    );
}

// A big choice card. Every card selects the same way (primary border and a check), so no option looks like the
// wrong one before it is chosen
export function ChoiceCard({ selected, onSelect, tabbable, className, children }: {
    selected: boolean; onSelect: () => void; tabbable: boolean; className?: string; children: ReactNode;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={tabbable ? 0 : -1}
            onClick={onSelect}
            className={cn(
                'relative flex min-h-11 w-full flex-col gap-3 rounded-2xl border-2 p-4 text-left transition-all sm:p-5',
                selected ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-card hover:border-primary/40',
                className,
            )}
        >
            <span className={cn(
                'absolute right-4 top-4 flex size-5 items-center justify-center rounded-full border',
                selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card',
            )} aria-hidden>
                {selected && <Check className="size-3" />}
            </span>
            {children}
        </button>
    );
}

export function Skeleton({ className }: { className?: string }) {
    return <div className={cn('animate-pulse rounded-lg bg-secondary', className)} aria-hidden />;
}

export function CheckoutSkeleton() {
    return (
        <div className="mx-auto max-w-3xl space-y-6" aria-busy="true" aria-label="Carregando a assinatura">
            <Skeleton className="h-6 w-full" />
            <div className="panel space-y-6 p-5 sm:p-8">
                <div className="space-y-2"><Skeleton className="mx-auto h-5 w-32" /><Skeleton className="mx-auto h-8 w-3/4" /></div>
                <Skeleton className="mx-auto h-32 max-w-md" />
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    <Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="col-span-2 h-28 sm:col-span-1" />
                </div>
                <Skeleton className="h-44" />
            </div>
        </div>
    );
}
