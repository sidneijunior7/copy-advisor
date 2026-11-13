import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button, type ButtonProps } from '../../../components/ui/Button';
import { cn } from '../../../lib/utils';

// The question of the step. The stage's name is already in the progress bar: no badge repeating it above
export function StepHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
    return (
        <div className="space-y-2 text-center">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            {children && <div className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">{children}</div>}
        </div>
    );
}

// The step's one primary action: in the flow on a wide screen, fixed at the bottom on a phone, where the thumb is.
// "above" goes right over the button in both places (the summary's risk confirmation: on a phone it must sit next
// to the button it unlocks, never below the fold); the note goes under it in the flow
export function StepCta({ note, above, ...props }: ButtonProps & { note?: ReactNode; above?: (compact: boolean) => ReactNode }) {
    return (
        <>
            <div className="hidden space-y-3 sm:block">
                {above?.(false)}
                <Button size="lg" className="w-full" {...props} />
                {note && <div className="text-center text-xs text-muted-foreground">{note}</div>}
            </div>
            {note && <div className="text-center text-xs text-muted-foreground sm:hidden">{note}</div>}
            <div className="fixed inset-x-0 bottom-0 z-30 space-y-2.5 border-t border-border bg-card/95 px-4 py-3 backdrop-blur sm:hidden">
                {above?.(true)}
                <Button size="lg" className="w-full" {...props} />
            </div>
        </>
    );
}

// A big choice card. Every card selects the same way (primary border and a check), so no option looks like the
// wrong one before it is chosen. Its content must be phrasing (spans), since it is a button
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
                'relative flex min-h-11 w-full flex-col gap-2.5 rounded-2xl border-2 p-4 text-left transition-all sm:p-5',
                selected ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-card hover:border-primary/40',
                className,
            )}
        >
            <RadioDot selected={selected} className="absolute right-4 top-4" />
            {children}
        </button>
    );
}

export function RadioDot({ selected, className }: { selected: boolean; className?: string }) {
    return (
        <span className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full border',
            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card',
            className,
        )} aria-hidden>
            {selected && <Check className="size-3" />}
        </span>
    );
}

export function Skeleton({ className }: { className?: string }) {
    return <div className={cn('animate-pulse rounded-lg bg-secondary', className)} aria-hidden />;
}

export function CheckoutSkeleton() {
    return (
        <div className="mx-auto max-w-6xl lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8" aria-busy="true" aria-label="Carregando a assinatura">
            <div className="mx-auto w-full max-w-3xl space-y-6 lg:max-w-none">
                <Skeleton className="h-6 w-full" />
                <div className="panel space-y-6 p-5 sm:p-8">
                    <Skeleton className="mx-auto h-8 w-3/4" />
                    <div className="grid gap-3 sm:grid-cols-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
                    <Skeleton className="h-36" />
                    <Skeleton className="h-44" />
                </div>
            </div>
            <Skeleton className="hidden h-80 lg:block" />
        </div>
    );
}
