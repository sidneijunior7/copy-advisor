import { useState } from 'react';
import { AlertTriangle, ArrowRight, Minus, Pencil, Plus, ShieldAlert, Sparkles, TrendingUp, Wallet } from 'lucide-react';
import type { PortfolioSimulation, SimulationStep } from '../../../api';
import ColumnChart from '../../../components/charts/ColumnChart';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Field';
import { formatMonth } from '../../../lib/labels';
import { formatMoney } from '../../../lib/money';
import { riskOf } from '../../../lib/risk';
import { cn } from '../../../lib/utils';
import { lotsLabel, periodWords, tierPriceText } from './format';
import { StepCta, StepHeader } from './parts';

// Above this share of the capital, the manager's suggested capital is called a minimum, never "with room to spare"
const TIGHT_CAPITAL_PCT = 50;

// Signed money as one text node: the sign never wraps away from the number
const signedMoney = (value: number, currency: string) =>
    `${value > 0 ? '+' : value < 0 ? '−' : ''} ${formatMoney(Math.abs(value), currency)}`;

// Whole reais typed the Brazilian way: 5.000 or 5000; cents are ignored
const parseCapital = (text: string) => Number(text.split(',')[0].replace(/\D/g, ''));
const maskCapital = (text: string) => {
    const n = parseCapital(text);
    return n > 0 ? n.toLocaleString('pt-BR') : '';
};

export default function ContractsStep({ steps, tierIdx, onTier, simulation, currency, customCapital, onCapital, periodLabel, onContinue }: {
    steps: SimulationStep[];
    tierIdx: number;
    onTier: (idx: number) => void;
    simulation: PortfolioSimulation | null;
    currency: string;
    customCapital: number | null;
    onCapital: (capital: number | null) => void;
    periodLabel: (days: number) => string;
    onContinue: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const tier = steps[tierIdx];
    const lots = lotsLabel(tier.lots);
    const days = simulation?.days ?? 0;
    const period = days > 0 ? periodWords(days) : null;

    // The risk is over the capital of the chosen size: the suggested one, or the client's own when it said
    const capital = customCapital && customCapital > 0 ? customCapital : tier.recommended_capital;
    const ddPct = capital > 0 ? Math.round((tier.max_drawdown / capital) * 1000) / 10 : null;
    const overCapital = ddPct != null && ddPct > 100;
    const risk = riskOf(ddPct);
    const tightCapital = tier.recommended_capital > 0 && (tier.max_drawdown / tier.recommended_capital) * 100 > TIGHT_CAPITAL_PCT;
    const months = (simulation?.months ?? []).map(m => ({ label: formatMonth(m.month), value: Math.round(m.net * tier.lots * 100) / 100 }));
    // What the plan would have cost over the same period: the result above is before it
    const fees = tier.price && tier.price > 0 && days > 0 ? tier.price * (days / (tier.days || 30)) : 0;
    const base = steps[0];
    const perContract = (t: SimulationStep) => (t.price && t.price > 0 && t.lots > 1 && t !== base
        ? `${formatMoney(t.price / t.lots, t.currency)} por contrato` : null);

    const applyCapital = () => {
        const n = parseCapital(draft);
        setEditing(false);
        if (!(n > 0)) return;
        onCapital(n);
        // Start on the biggest size that fits the capital the client has
        const fits = steps.map((s, i) => [s, i] as const).filter(([s]) => s.recommended_capital <= n);
        onTier(fits.length ? fits[fits.length - 1][1] : 0);
    };

    return (
        <section className="panel space-y-6 p-5 sm:p-8">
            <StepHeader badge="Monte o seu plano" icon={<Sparkles className="size-3" />} title="Quantos contratos você quer copiar?">
                Mude a quantidade e veja o resultado que o portfólio teve{period ? ` nos últimos ${period}` : ''}, o capital sugerido e o risco.
            </StepHeader>

            <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5">
                <div className="flex w-full items-center justify-between gap-4">
                    <button type="button" aria-label="Diminuir contratos" disabled={tierIdx <= 0} onClick={() => onTier(tierIdx - 1)}
                        className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-card shadow-sm transition-all hover:border-primary hover:bg-primary/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40">
                        <Minus className="size-5" />
                    </button>
                    <div className="min-w-0 text-center">
                        <p className="text-3xl font-extrabold tracking-tight sm:text-4xl">{lots}</p>
                        <p className="mt-0.5 text-xs font-medium text-primary">{tier.name !== lots && `${tier.name} · `}{tierPriceText(tier, periodLabel)}</p>
                        {perContract(tier) && <p className="text-xs text-muted-foreground">{perContract(tier)}</p>}
                    </div>
                    <button type="button" aria-label="Aumentar contratos" disabled={tierIdx >= steps.length - 1} onClick={() => onTier(tierIdx + 1)}
                        className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-primary/50 bg-primary text-primary-foreground shadow-md shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95 disabled:pointer-events-none disabled:opacity-40">
                        <Plus className="size-5" />
                    </button>
                </div>
                {steps.length > 1 && (
                    <div className="flex flex-wrap justify-center gap-1.5 pt-1" role="group" aria-label="Opções de contratos">
                        {steps.map((s, idx) => (
                            <button key={`${s.lots}-${idx}`} type="button" onClick={() => onTier(idx)} aria-pressed={idx === tierIdx}
                                className={cn('inline-flex min-h-9 items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition-all',
                                    idx === tierIdx ? 'bg-primary text-primary-foreground shadow-sm'
                                        : 'border border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground')}>
                                {lotsLabel(s.lots)}
                                {s.popular && <span className={cn('rounded-full px-1.5 text-[10px]', idx === tierIdx ? 'bg-primary-foreground/20' : 'bg-primary/10 text-primary')}>Mais escolhido</span>}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Profit and risk side by side on a phone, so the risk is never below the fold; the capital spans the row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4" aria-live="polite">
                <div className={cn('rounded-xl border-2 p-3 sm:p-4',
                    tier.simulated_profit >= 0 ? 'border-success/40 bg-gradient-to-br from-success/15 via-success/5 to-transparent' : 'border-destructive/40 bg-destructive/5')}>
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <TrendingUp className={cn('size-4 shrink-0', tier.simulated_profit >= 0 ? 'text-success' : 'text-destructive')} />
                        {period ? `Resultado em ${period}` : 'Resultado no período'}
                    </p>
                    <p className={cn('mt-2 whitespace-nowrap text-xl font-extrabold tracking-tight sm:text-3xl', tier.simulated_profit >= 0 ? 'text-success' : 'text-destructive')}>
                        {signedMoney(tier.simulated_profit, currency)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {simulation && simulation.trades > 0 ? `${simulation.trades} operações fechadas com ${lots}` : `Projeção proporcional para ${lots}`}
                    </p>
                </div>

                <div className={cn('rounded-xl border-2 p-3 sm:p-4', overCapital ? 'border-destructive/50 bg-destructive/5' : 'border-border bg-secondary/40')}>
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <ShieldAlert className="size-4 shrink-0 text-warning" /> Maior queda
                        </span>
                        {risk && !overCapital && <Badge variant={risk.variant}>{risk.label}</Badge>}
                    </div>
                    <p className="mt-2 whitespace-nowrap text-xl font-extrabold tracking-tight sm:text-3xl">
                        {signedMoney(-tier.max_drawdown, currency)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {overCapital ? 'Maior que o capital da conta' : ddPct != null ? `${ddPct.toLocaleString('pt-BR')}% de ${formatMoney(capital, currency)}` : 'No período'}
                    </p>
                </div>

                <div className="order-last col-span-2 rounded-xl border border-border bg-secondary/40 p-3 sm:order-none sm:col-span-1 sm:p-4">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <Wallet className="size-4 shrink-0 text-primary" /> {tightCapital ? 'Capital mínimo sugerido pelo gestor' : 'Capital recomendado'}
                    </p>
                    <p className="mt-2 whitespace-nowrap text-xl font-bold tracking-tight sm:text-3xl">{formatMoney(tier.recommended_capital, currency)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {tightCapital ? `Para ${lots}. A queda histórica já passou da metade dele` : `Para operar ${lots} com folga`}
                    </p>
                </div>
            </div>

            {overCapital && (
                <p role="alert" className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    Com esse capital, a maior queda histórica seria maior do que o saldo da conta. Escolha menos contratos ou aumente o capital.
                </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-4 py-3 text-xs">
                <p className="font-medium">
                    Risco calculado para um capital de <strong className="text-primary">{formatMoney(capital, currency)}</strong>
                    {customCapital ? ' (o seu)' : ' (o sugerido)'}
                </p>
                {editing ? (
                    <form onSubmit={e => { e.preventDefault(); applyCapital(); }} className="flex items-center gap-2">
                        <label htmlFor="checkout-capital" className="sr-only">Seu capital na corretora, em reais</label>
                        <Input id="checkout-capital" type="text" inputMode="numeric" value={draft} onChange={e => setDraft(maskCapital(e.target.value))}
                            placeholder="Ex.: 10.000" className="h-9 w-32 text-sm" autoFocus />
                        <Button size="sm" type="submit">Aplicar</Button>
                    </form>
                ) : (
                    <div className="flex flex-wrap items-center gap-2">
                        {customCapital != null && (
                            <button type="button" onClick={() => onCapital(null)}
                                className="min-h-9 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 font-medium text-primary hover:bg-primary/20">
                                Usar o sugerido
                            </button>
                        )}
                        <button type="button" onClick={() => { setDraft(maskCapital(String(Math.round(capital)))); setEditing(true); }}
                            className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium hover:border-primary/40">
                            <Pencil className="size-3" /> Informar meu capital
                        </button>
                    </div>
                )}
            </div>

            {months.length > 0 && (
                <div className="space-y-2 rounded-xl border border-border bg-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold">Mês a mês com {lots}{period ? `, últimos ${period}` : ''}</p>
                        <span className="text-xs text-muted-foreground">Operações reais fechadas</span>
                    </div>
                    <ColumnChart data={months} ariaLabel={`Resultado mensal simulado para ${lots}`} formatValue={v => formatMoney(v, currency)} height={170} />
                </div>
            )}

            <p className="text-center text-xs text-muted-foreground">
                Antes de custos: corretagem, emolumentos, slippage{fees > 0 ? ` e ${formatMoney(fees, tier.currency)} de mensalidades no período` : ''}.
                Resultados passados não garantem resultados futuros.
            </p>

            <StepCta onClick={onContinue}>Continuar com {lots} <ArrowRight /></StepCta>
        </section>
    );
}
