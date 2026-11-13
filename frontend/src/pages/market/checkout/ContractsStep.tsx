import { AlertTriangle, ArrowRight, Pencil } from 'lucide-react';
import type { HostingPrice, PortfolioSimulation, SimulationStep } from '../../../api';
import ColumnChart from '../../../components/charts/ColumnChart';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { formatMonth } from '../../../lib/labels';
import { formatMoney, hostingPriceLabel, periodLabel as periodName, signedPct } from '../../../lib/money';
import { riskOf } from '../../../lib/risk';
import { cn } from '../../../lib/utils';
import { lotsLabel, perContractFalls, periodWords, planTitle, radioKeys, signedMoney } from './format';
import { RadioDot, Step, StepCta, StepHeader } from './parts';

// Past this share of the capital, the drop is shown in the warning colour
const HEAVY_DROP_PCT = 50;

const COLS: Record<number, string> = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2' };

// One plan as a card: what it is, what it costs and the capital it asks. On a phone a compact row, on a wide screen
// a column, like a pricing table
function PlanCard({ tier, selected, tabbable, perContract, aboveCapital, onSelect }: {
    tier: SimulationStep; selected: boolean; tabbable: boolean; perContract: string | null; aboveCapital: boolean; onSelect: () => void;
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
                {aboveCapital && <span className="mt-0.5 block text-xs font-medium text-warning">Pede mais do que o seu capital</span>}
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

// One line of the costs: what it is, how it was counted and the amount, signed
function CostLine({ label, detail, value, currency, strong }: {
    label: string; detail?: string | null; value: number | null; currency: string; strong?: boolean;
}) {
    return (
        <div className={cn('flex items-baseline justify-between gap-3 py-2', strong && 'pt-3')}>
            <dt className="min-w-0">
                <span className={cn('block', strong ? 'font-semibold' : 'text-muted-foreground')}>{label}</span>
                {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
            </dt>
            <dd className={cn('shrink-0 whitespace-nowrap',
                strong ? 'text-lg font-bold sm:text-xl' : 'font-medium',
                strong && value != null && (value >= 0 ? 'text-success' : 'text-destructive'))}>
                {value == null ? 'Sob consulta' : signedMoney(value, currency)}
            </dd>
        </div>
    );
}

// The simulation in one sentence a beginner reads at once: the money put in back then, the money there today, and
// the drop on the way, so the profit never shows without the risk beside it
function HindsightCard({ capital, result, afterFees, drop, start, period, currency }: {
    capital: number; result: number; afterFees: boolean; drop: number; start: Date | null; period: string | null; currency: string;
}) {
    const today = capital + result;
    const gain = result >= 0;
    const since = start ? start.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' }) : null;
    const pct = capital > 0 ? Math.round((result / capital) * 1000) / 10 : null;
    return (
        <div className={cn('rounded-xl border p-4 sm:p-6', gain ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5')}>
            <p className="text-base sm:text-lg">
                Se você tivesse começado com <strong>{formatMoney(capital, currency)}</strong>
                {period ? <> há <strong>{period}</strong></> : null}, hoje teria{' '}
                <strong className={gain ? 'text-success' : 'text-destructive'}>{formatMoney(today, currency)}</strong>:{' '}
                {gain ? 'um lucro' : 'um prejuízo'} {afterFees ? 'líquido ' : ''}de{' '}
                <strong className={gain ? 'text-success' : 'text-destructive'}>{formatMoney(Math.abs(result), currency)}</strong>.
            </p>

            <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
                <div className="min-w-0 rounded-lg bg-background/60 p-3">
                    <p className="text-xs text-muted-foreground">{since ? `Em ${since}` : 'No início'}</p>
                    <p className="mt-0.5 whitespace-nowrap text-[clamp(0.95rem,4vw,1.25rem)] font-bold tracking-tight sm:text-2xl">{formatMoney(capital, currency)}</p>
                    <p className="text-xs text-muted-foreground">Você investe</p>
                </div>
                <ArrowRight className={cn('size-5 shrink-0', gain ? 'text-success' : 'text-destructive')} aria-hidden />
                <div className={cn('min-w-0 rounded-lg p-3 ring-1', gain ? 'bg-success/10 ring-success/30' : 'bg-destructive/10 ring-destructive/30')}>
                    <p className="text-xs text-muted-foreground">Hoje</p>
                    <p className={cn('mt-0.5 whitespace-nowrap text-[clamp(0.95rem,4vw,1.25rem)] font-bold tracking-tight sm:text-2xl', gain ? 'text-success' : 'text-destructive')}>
                        {formatMoney(today, currency)}
                    </p>
                    <p className="text-xs text-muted-foreground">{pct != null ? `${signedPct(pct)} ${afterFees ? 'já sem a assinatura' : 'antes da assinatura'}` : ''}</p>
                </div>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
                No caminho, chegou a cair <strong className="text-foreground">{formatMoney(drop, currency)}</strong> do ponto mais alto ao mais baixo.
                É com essa queda que você precisa estar confortável. Resultados passados não garantem resultados futuros.
            </p>
        </div>
    );
}

export default function ContractsStep({ steps, tierIdx, onTier, simulation, currency, capital, hostingPrice, onEditCapital, onContinue }: {
    steps: SimulationStep[];
    tierIdx: number;
    onTier: (idx: number) => void;
    simulation: PortfolioSimulation | null;
    currency: string;
    capital: number; // The amount the client said in the step before, or the suggested minimum
    hostingPrice: HostingPrice | null; // The cloud's price, when it is offered and charged apart
    onEditCapital: () => void;
    onContinue: () => void;
}) {
    const tier = steps[tierIdx];
    const lots = lotsLabel(tier.lots, tier.unit);
    const days = simulation?.days ?? 0;
    const period = days > 0 ? periodWords(days) : null;

    // The risk and the return are over the client's own capital
    const ddPct = capital > 0 ? Math.round((tier.max_drawdown / capital) * 1000) / 10 : null;
    const overCapital = ddPct != null && ddPct > 100;
    const risk = riskOf(ddPct);
    const showPerContract = perContractFalls(steps);

    // What the plan costs over the same period, and what is left of the result after it
    const gross = tier.simulated_profit;
    const fees = tier.price == null ? null : tier.price > 0 && days > 0 ? tier.price * (days / (tier.days || 30)) : 0;
    const net = fees == null ? null : Math.round((gross - fees) * 100) / 100;
    const netPct = net != null && capital > 0 ? Math.round((net / capital) * 1000) / 10 : null;
    const feeDetail = tier.price == null ? null : tier.price === 0 ? 'Plano gratuito'
        : `${formatMoney(tier.price, tier.currency)} /${periodName(tier.days)}${period ? ` por ${period}` : ''}`;

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

    return (
        <Step>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <StepHeader title={<>Sua simulação com {formatMoney(capital, currency)}</>}>
                    Escolhemos o maior plano que cabe nesse valor. Veja como ele teria ido{period ? ` nos últimos ${period}` : ''},
                    quanto custaria e o que sobraria.
                </StepHeader>
                <Button size="sm" variant="outline" className="shrink-0 self-start" onClick={onEditCapital}>
                    <Pencil /> Alterar o valor
                </Button>
            </div>

            <div role="radiogroup" aria-label="Planos" onKeyDown={radioKeys}
                className={cn('grid grid-cols-1 gap-3 pt-1', COLS[steps.length] ?? 'sm:grid-cols-3')}>
                {steps.map((s, i) => (
                    <PlanCard key={`${s.lots}-${i}`} tier={s} selected={i === tierIdx} tabbable={i === tierIdx} onSelect={() => onTier(i)}
                        aboveCapital={s.recommended_capital > capital}
                        perContract={showPerContract && i > 0 && s.price ? `${formatMoney(s.price / s.lots, s.currency)} por ${s.unit ?? 'contrato'}` : null} />
                ))}
            </div>

            <div aria-live="polite">
                <HindsightCard capital={capital} result={net ?? gross} afterFees={net != null} drop={tier.max_drawdown}
                    start={days > 0 ? start : null} period={period} currency={currency} />
            </div>

            <div className="rounded-xl bg-secondary/40 p-4 sm:p-6">
                <p className="text-sm font-semibold">{period ? `Os últimos ${period} com ${lots}` : `Resultado com ${lots}`}</p>

                {/* Result and drop with the same weight: the profit keeps its colour, not a louder box */}
                <div className="mt-3 grid grid-cols-2 divide-x divide-border">
                    <div className="min-w-0 pr-3 sm:pr-5">
                        <p className="text-xs text-muted-foreground">Resultado das operações</p>
                        <p className={cn('mt-1 whitespace-nowrap text-[clamp(1rem,4.3vw,1.5rem)] font-bold tracking-tight sm:text-3xl',
                            gross >= 0 ? 'text-success' : 'text-destructive')}>
                            {signedMoney(gross, currency)}
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
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            {overCapital
                                ? <span className="font-medium text-destructive">Passaria do seu capital</span>
                                : ddPct != null && <><strong className={cn(ddPct > HEAVY_DROP_PCT && 'text-warning')}>{ddPct.toLocaleString('pt-BR')}%</strong> do seu capital</>}
                        </p>
                    </div>
                </div>

                {/* The costs, then what would be left: the number the client takes home */}
                <div className="mt-4 border-t border-border pt-2">
                    <p className="pt-1 text-sm font-semibold">Custos e resultado líquido</p>
                    <dl className="divide-y divide-border text-sm">
                        <CostLine label="Resultado das operações" value={gross} currency={currency} />
                        <CostLine label="Assinatura do plano" detail={feeDetail} value={fees == null ? null : -fees} currency={tier.currency} />
                        <CostLine label="Líquido estimado" strong value={net} currency={currency}
                            detail={netPct != null ? `${signedPct(netPct)} sobre ${formatMoney(capital, currency)}${period ? ` em ${period}` : ''}` : 'Depende do preço do plano'} />
                    </dl>
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
                        <span className="text-xs text-muted-foreground">Operações reais fechadas, antes dos custos</span>
                    </div>
                    <ColumnChart data={columns} ariaLabel={`Resultado mensal simulado para ${lots}`} formatValue={v => formatMoney(v, currency)}
                        height={170} positiveColor="hsl(var(--success))" />
                    {anyPartial && <p className="text-xs text-muted-foreground">* Mês incompleto: o período começa ou termina no meio dele.</p>}
                </div>
            )}

            <p className="text-xs text-muted-foreground">
                O líquido não inclui corretagem, emolumentos, impostos e slippage, que dependem da sua corretora
                {hostingPrice ? `, nem a nuvem, se você escolher rodar nela (${hostingPriceLabel(hostingPrice)})` : ''}.
                Resultados passados não garantem resultados futuros.
            </p>

            <StepCta onClick={onContinue}>Continuar com {lots} <ArrowRight /></StepCta>
        </Step>
    );
}

