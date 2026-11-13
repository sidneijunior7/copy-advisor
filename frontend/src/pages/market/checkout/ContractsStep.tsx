import { useState } from 'react';
import { AlertTriangle, ArrowRight, Pencil } from 'lucide-react';
import type { PortfolioSimulation, SimulationStep } from '../../../api';
import ColumnChart from '../../../components/charts/ColumnChart';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Field';
import { formatMonth } from '../../../lib/labels';
import { formatMoney, periodLabel as periodName } from '../../../lib/money';
import { riskOf } from '../../../lib/risk';
import { cn } from '../../../lib/utils';
import { lotsLabel, perContractFalls, periodWords, planTitle, radioKeys, signedMoney } from './format';
import { RadioDot, Step, StepCta, StepHeader } from './parts';

// Past this share of the capital, the drop is shown in the warning colour
const HEAVY_DROP_PCT = 50;

// Whole reais typed the Brazilian way: 5.000 or 5000; cents are ignored
const parseCapital = (text: string) => Number(text.split(',')[0].replace(/\D/g, ''));
const maskCapital = (text: string) => {
    const n = parseCapital(text);
    return n > 0 ? n.toLocaleString('pt-BR') : '';
};

const COLS: Record<number, string> = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2' };

// One plan as a card: what it is, what it costs and the capital it asks. On a phone a compact row, on a wide screen
// a column, like a pricing table
function PlanCard({ tier, selected, tabbable, perContract, onSelect }: {
    tier: SimulationStep; selected: boolean; tabbable: boolean; perContract: string | null; onSelect: () => void;
}) {
    const free = tier.price === 0;
    return (
        <button type="button" role="radio" aria-checked={selected} tabIndex={tabbable ? 0 : -1} onClick={onSelect}
            className={cn(
                'relative flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-colors sm:flex-col sm:items-start sm:gap-2 sm:p-5',
                selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-foreground/30',
            )}>
            {tier.popular && (
                <span className="absolute -top-2.5 left-3 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">Mais escolhido</span>
            )}
            <RadioDot selected={selected} className="sm:absolute sm:right-3 sm:top-3" />
            <span className="min-w-0 flex-1 sm:pr-6">
                <span className="block font-semibold">{planTitle(tier)}</span>
                <span className="block text-xs text-muted-foreground">Capital sugerido<br />{formatMoney(tier.recommended_capital, tier.currency)}</span>
            </span>
            <span className="shrink-0 text-right sm:text-left">
                <span className="block whitespace-nowrap text-base font-bold sm:text-2xl">
                    {tier.price == null ? 'Sob consulta' : free ? 'Gratuito' : formatMoney(tier.price, tier.currency)}
                    {tier.price != null && !free && <span className="text-xs font-normal text-muted-foreground"> /{periodName(tier.days)}</span>}
                </span>
                {perContract && <span className="block text-xs text-muted-foreground">{perContract}</span>}
            </span>
        </button>
    );
}

export default function ContractsStep({ steps, tierIdx, onTier, simulation, currency, customCapital, onCapital, onContinue }: {
    steps: SimulationStep[];
    tierIdx: number;
    onTier: (idx: number) => void;
    simulation: PortfolioSimulation | null;
    currency: string;
    customCapital: number | null;
    onCapital: (capital: number | null) => void;
    onContinue: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const tier = steps[tierIdx];
    const lots = lotsLabel(tier.lots, tier.unit);
    const days = simulation?.days ?? 0;
    const period = days > 0 ? periodWords(days) : null;

    // The risk is over the capital of the chosen size: the suggested one, or the client's own when it said
    const capital = customCapital && customCapital > 0 ? customCapital : tier.recommended_capital;
    const ddPct = capital > 0 ? Math.round((tier.max_drawdown / capital) * 1000) / 10 : null;
    const overCapital = ddPct != null && ddPct > 100;
    const risk = riskOf(ddPct);
    // What the plan would have cost over the same period: the result above is before it
    const fees = tier.price && tier.price > 0 && days > 0 ? tier.price * (days / (tier.days || 30)) : 0;
    const showPerContract = perContractFalls(steps);

    // The period starts and ends in the middle of a month: those columns are partial, and say so
    const now = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const months = simulation?.months ?? [];
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const partial = (i: number) => (i === 0 && months.length > 1 && start.getDate() !== 1) || (i === months.length - 1 && months[i].month === thisMonth);
    const columns = months.map((m, i) => ({
        label: `${formatMonth(m.month)}${partial(i) ? '*' : ''}`,
        value: Math.round(m.net * tier.lots * 100) / 100,
    }));
    const anyPartial = months.some((_, i) => partial(i));

    const applyCapital = () => {
        const n = parseCapital(draft);
        setEditing(false);
        if (!(n > 0)) return;
        onCapital(n);
        // Start on the biggest plan that fits the capital the client has
        const fits = steps.map((s, i) => [s, i] as const).filter(([s]) => s.recommended_capital <= n);
        onTier(fits.length ? fits[fits.length - 1][1] : 0);
    };

    return (
        <Step>
            <StepHeader title="Escolha o seu plano">
                Veja como cada plano teria ido{period ? ` nos últimos ${period}` : ''}, com o risco e o capital que ele pede.
            </StepHeader>

            <div role="radiogroup" aria-label="Planos" onKeyDown={radioKeys}
                className={cn('grid grid-cols-1 gap-3 pt-1', COLS[steps.length] ?? 'sm:grid-cols-3')}>
                {steps.map((s, i) => (
                    <PlanCard key={`${s.lots}-${i}`} tier={s} selected={i === tierIdx} tabbable={i === tierIdx} onSelect={() => onTier(i)}
                        perContract={showPerContract && i > 0 && s.price ? `${formatMoney(s.price / s.lots, s.currency)} por ${s.unit ?? 'contrato'}` : null} />
                ))}
            </div>

            {/* Result and drop with the same weight: the profit keeps its colour, not a louder box */}
            <div className="rounded-xl bg-secondary/40 p-4 sm:p-6" aria-live="polite">
                <p className="text-sm font-semibold">{period ? `Como foram os últimos ${period} com ${lots}` : `Resultado com ${lots}`}</p>
                <div className="mt-3 grid grid-cols-2 divide-x divide-border">
                    <div className="min-w-0 pr-3 sm:pr-5">
                        <p className="text-xs text-muted-foreground">Resultado</p>
                        <p className={cn('mt-1 whitespace-nowrap text-[clamp(1rem,4.3vw,1.5rem)] font-bold tracking-tight sm:text-3xl',
                            tier.simulated_profit >= 0 ? 'text-success' : 'text-destructive')}>
                            {signedMoney(tier.simulated_profit, currency)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            {simulation && simulation.trades > 0 ? `${simulation.trades} operações fechadas` : 'Projeção proporcional'}
                        </p>
                    </div>
                    <div className="min-w-0 pl-3 sm:pl-5">
                        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            Maior queda {risk && !overCapital && <Badge variant={risk.variant}>{risk.label}</Badge>}
                        </p>
                        <p className="mt-1 whitespace-nowrap text-[clamp(1rem,4.3vw,1.5rem)] font-bold tracking-tight sm:text-3xl">
                            {signedMoney(-tier.max_drawdown, currency)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Do topo ao fundo no período</p>
                    </div>
                </div>
                <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <p>
                        {customCapital
                            ? <>Seu capital: <strong>{formatMoney(capital, currency)}</strong>. </>
                            : <>Capital sugerido pelo gestor: <strong>{formatMoney(capital, currency)}</strong>. </>}
                        {overCapital
                            ? <span className="font-medium text-destructive">A maior queda passaria do saldo.</span>
                            : ddPct != null && <>A maior queda {customCapital ? 'seria' : 'foi'}{' '}
                                <strong className={cn(ddPct > HEAVY_DROP_PCT && 'text-warning')}>{ddPct.toLocaleString('pt-BR')}%</strong> dele.</>}
                    </p>
                    {editing ? (
                        <form onSubmit={e => { e.preventDefault(); applyCapital(); }} className="flex shrink-0 items-center gap-2">
                            <label htmlFor="checkout-capital" className="sr-only">Seu capital na corretora, em reais</label>
                            <Input id="checkout-capital" type="text" inputMode="numeric" value={draft} onChange={e => setDraft(maskCapital(e.target.value))}
                                placeholder="Ex.: 10.000" className="h-9 w-32 text-sm" autoFocus />
                            <Button size="sm" type="submit">Aplicar</Button>
                        </form>
                    ) : (
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                            {customCapital != null && (
                                <Button size="sm" variant="ghost" onClick={() => onCapital(null)}>Usar o sugerido</Button>
                            )}
                            <Button size="sm" variant="outline" onClick={() => { setDraft(maskCapital(String(Math.round(capital)))); setEditing(true); }}>
                                <Pencil /> Informar meu capital
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {overCapital && (
                <p role="alert" className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    Com esse capital, a maior queda histórica seria maior do que o saldo da conta. Escolha um plano menor ou aumente o capital.
                </p>
            )}

            {columns.length > 0 && (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold">Mês a mês com {lots}</p>
                        <span className="text-xs text-muted-foreground">Operações reais fechadas</span>
                    </div>
                    <ColumnChart data={columns} ariaLabel={`Resultado mensal simulado para ${lots}`} formatValue={v => formatMoney(v, currency)}
                        height={170} positiveColor="hsl(var(--success))" />
                    {anyPartial && <p className="text-xs text-muted-foreground">* Mês incompleto: o período começa ou termina no meio dele.</p>}
                </div>
            )}

            <p className="text-xs text-muted-foreground">
                Antes de custos: corretagem, emolumentos, slippage{fees > 0 ? ` e ${formatMoney(fees, tier.currency)} de mensalidades no período` : ''}.
                Resultados passados não garantem resultados futuros.
            </p>

            <StepCta onClick={onContinue}>Continuar com {lots} <ArrowRight /></StepCta>
        </Step>
    );
}
