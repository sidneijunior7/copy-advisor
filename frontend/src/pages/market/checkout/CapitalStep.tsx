import { useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { SimulationStep } from '../../../api';
import { Input } from '../../../components/ui/Field';
import { formatMoney } from '../../../lib/money';
import { cn } from '../../../lib/utils';
import { lotsLabel, maskCapital, parseCapital } from './format';
import { Step, StepCta, StepHeader } from './parts';

// The first question of the checkout: how much the client means to leave at the broker. Everything after it (the plan
// that fits, the result, the costs and what is left) is said over this amount
export default function CapitalStep({ steps, minCapital, capital, currency, onSubmit }: {
    steps: SimulationStep[];
    minCapital: number;
    capital: number | null;
    currency: string;
    onSubmit: (capital: number) => void;
}) {
    const [draft, setDraft] = useState(() => maskCapital(String(Math.round(capital ?? minCapital))));
    const [error, setError] = useState<string | null>(null);
    const value = parseCapital(draft);
    const belowMin = value > 0 && minCapital > 0 && value < minCapital;
    const symbol = currency === 'USD' ? 'US$' : 'R$';

    // Each plan's suggested capital is a shortcut: one tap and the amount fits that plan
    const shortcuts = steps
        .map(s => ({ capital: Math.round(s.recommended_capital), label: lotsLabel(s.lots, s.unit) }))
        .filter((s, i, all) => s.capital > 0 && all.findIndex(o => o.capital === s.capital) === i);

    const submit = (e?: FormEvent) => {
        e?.preventDefault();
        if (!(value > 0)) { setError('Digite quanto você pretende investir.'); return; }
        onSubmit(value);
    };

    return (
        <Step>
            <StepHeader title="Quanto você pretende investir?">
                O valor que você vai deixar na corretora. Com ele, mostramos o plano que cabe, como ele teria ido e quanto
                sobraria depois dos custos.
            </StepHeader>

            <form onSubmit={submit} className="space-y-4">
                <div className="space-y-2">
                    <label htmlFor="checkout-capital" className="text-sm font-medium">Seu capital na corretora</label>
                    <div className="relative max-w-sm">
                        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg font-semibold text-muted-foreground">{symbol}</span>
                        <Input id="checkout-capital" type="text" inputMode="numeric" autoComplete="off" value={draft} autoFocus
                            onChange={e => { setDraft(maskCapital(e.target.value)); setError(null); }}
                            placeholder="Ex.: 10.000" aria-invalid={error != null} aria-describedby="checkout-capital-hint"
                            className={cn('h-14 pl-14 text-2xl font-bold tracking-tight', error && 'border-destructive')} />
                    </div>
                    <p id="checkout-capital-hint" className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
                        {error ?? (minCapital > 0 ? `Mínimo sugerido pelo trader: ${formatMoney(minCapital, currency)}` : 'Valores inteiros, sem centavos')}
                    </p>
                </div>

                {shortcuts.length > 1 && (
                    <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">Capital sugerido de cada plano</p>
                        <div className="flex flex-wrap gap-2">
                            {shortcuts.map(s => (
                                <button key={s.capital} type="button" onClick={() => { setDraft(maskCapital(String(s.capital))); setError(null); }}
                                    className={cn('min-h-11 rounded-full border px-3.5 py-1.5 text-sm transition-colors',
                                        value === s.capital ? 'border-primary bg-primary/5 font-medium text-foreground ring-1 ring-primary' : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground')}>
                                    {formatMoney(s.capital, currency)} <span className="text-xs opacity-75">· {s.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {belowMin && (
                    <p className="flex max-w-2xl items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                        Abaixo do mínimo sugerido pelo trader ({formatMoney(minCapital, currency)}). Você pode seguir, mas as quedas
                        pesam mais no seu saldo.
                    </p>
                )}
            </form>

            <StepCta onClick={() => submit()}>Ver a simulação <ArrowRight /></StepCta>
        </Step>
    );
}
