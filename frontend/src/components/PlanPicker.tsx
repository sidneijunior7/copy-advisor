import type { Plan } from '../api';
import { formatMoney, periodLabel } from '../lib/money';
import { cn } from '../lib/utils';

// The plans of a listing paid in Stripe: one per lot limit
export default function PlanPicker({ plans, value, onChange, name = 'plano' }: { plans: Plan[]; value: number | null; onChange: (id: number) => void; name?: string }) {
    return (
        <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Plano</legend>
            {plans.map(p => (
                <label key={p.id} className={cn('flex min-h-14 cursor-pointer items-center justify-between gap-3 rounded-md border border-border p-3 text-sm transition-colors',
                    value === p.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')}>
                    <span className="flex items-center gap-2">
                        <input type="radio" name={name} checked={value === p.id} onChange={() => onChange(p.id)} />
                        <span>
                            <span className="block font-medium">{p.name}</span>
                            <span className="block text-xs text-muted-foreground">Copia ordens de até {p.max_lots.toLocaleString('pt-BR')} {p.max_lots === 1 ? 'lote' : 'lotes'} (contratos)</span>
                        </span>
                    </span>
                    <span className="shrink-0 font-semibold">{formatMoney(p.price, p.currency)}<span className="text-xs font-normal text-muted-foreground"> / {periodLabel(p.days)}</span></span>
                </label>
            ))}
        </fieldset>
    );
}
