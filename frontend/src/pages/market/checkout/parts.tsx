import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button, type ButtonProps } from '../../../components/ui/Button';
import { cn } from '../../../lib/utils';

// A step sits on the page itself, not in a card: the cards are kept for what the client chooses
export function Step({ children }: { children: ReactNode }) {
    return <section className="space-y-7">{children}</section>;
}

// The question of the step, aligned with the rest of the column. The stage's name is in the progress bar already
export function StepHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
    return (
        <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{title}</h1>
            {children && <div className="max-w-2xl text-sm text-muted-foreground sm:text-base">{children}</div>}
        </div>
    );
}

// The step's one primary action: at the end of the step and to the right on a wide screen, fixed at the bottom on a
// phone, where the thumb is. "above" goes right over the button in both places (the summary's risk confirmation: on
// a phone it must sit next to the button it unlocks, never below the fold); the note goes under it
export function StepCta({ note, above, ...props }: ButtonProps & { note?: ReactNode; above?: (compact: boolean) => ReactNode }) {
    return (
        <>
            <div className="hidden space-y-4 border-t border-border pt-6 sm:block">
                {above?.(false)}
                <div className="flex flex-col items-end gap-2">
                    <Button size="lg" className="min-w-64" {...props} />
                    {note && <div className="text-right text-xs text-muted-foreground">{note}</div>}
                </div>
            </div>
            {note && <div className="text-xs text-muted-foreground sm:hidden">{note}</div>}
            <div className="fixed inset-x-0 bottom-0 z-30 space-y-2.5 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:hidden">
                {above?.(true)}
                <Button size="lg" className="w-full" {...props} />
            </div>
        </>
    );
}

// A form's own submit: full width on a phone, to the right on a wide screen like the steps' button
export function FormCta(props: ButtonProps) {
    return (
        <div className="flex justify-end pt-2">
            <Button type="submit" size="lg" className="w-full sm:w-auto sm:min-w-56" {...props} />
        </div>
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
                'relative flex min-h-11 w-full flex-col gap-2.5 rounded-xl border p-4 text-left transition-colors sm:p-5',
                selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-foreground/30',
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
            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
            className,
        )} aria-hidden>
            {selected && <Check className="size-3" />}
        </span>
    );
}

export function Skeleton({ className }: { className?: string }) {
    return <div className={cn('animate-pulse rounded-lg bg-secondary', className)} aria-hidden />;
}

// The page's two halves, to the edges of the screen: the steps, and the order on a tinted band beside them
export function CheckoutColumns({ main, side, mainClassName }: { main: ReactNode; side?: ReactNode; mainClassName?: string }) {
    return (
        <div className="flex-1 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,36%)] 2xl:grid-cols-[minmax(0,1fr)_minmax(28rem,34%)]">
            <div className={cn('px-4 py-6 sm:px-6 sm:py-8 lg:px-12 lg:py-10 xl:px-16', mainClassName)}>
                <div className="mx-auto w-full max-w-3xl lg:ml-auto lg:mr-0 xl:max-w-[56rem] 2xl:max-w-[72rem]">{main}</div>
            </div>
            <div className="hidden border-l border-border bg-secondary/30 lg:block">
                <div className="sticky top-14 max-w-md px-10 py-10 xl:px-12 2xl:max-w-xl 2xl:px-14">{side}</div>
            </div>
        </div>
    );
}

export function CheckoutSkeleton() {
    return (
        <CheckoutColumns
            main={
                <div className="space-y-7" aria-busy="true" aria-label="Carregando a assinatura">
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-8 w-1/2" />
                    <div className="grid gap-3 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
                    <Skeleton className="h-36" />
                    <Skeleton className="h-44" />
                </div>
            }
            side={<div className="space-y-4"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-16" /></div>}
        />
    );
}
