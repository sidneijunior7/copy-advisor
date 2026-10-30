import { LineChart as LineIcon, TrendingUp } from 'lucide-react';
import type { CopiesPerformance, PerformanceStats, PortfolioPerformance } from '../api';
import Card from './Card';
import EmptyState from './EmptyState';
import SlideRow from './SlideRow';
import ColumnChart from './charts/ColumnChart';
import LineChart from './charts/LineChart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/Table';
import { formatMoney } from '../lib/money';
import { cn, formatDate, parseUtc } from '../lib/utils';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// "2026-10" as "out/26"
const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]}/${month.slice(2, 4)}`;

// What the return is over, after the amount
const CAPITAL_SOURCE: Record<string, string> = { 'dash-mc': 'DD máx. +3σ do Dash', dash: 'capital do Dash', account: 'saldo da conta' };
const NO_CAPITAL: Record<string, string> = {
    accounts: 'operações de mais de uma conta Master',
    'currency-mismatch': 'capital do Dash em outra moeda',
};

const pct = (value: number | null) => (value == null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);

export function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'up' | 'down' }) {
    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={cn('mt-1 text-xl font-semibold', tone === 'up' && 'text-success', tone === 'down' && 'text-destructive')}>{value}</p>
            {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

interface PerformanceViewProps {
    stats: PerformanceStats | PortfolioPerformance | CopiesPerformance;
    emptyTitle: string;
    emptyDescription: string;
}

// Headline numbers, the cumulative result, the result per month and the same numbers as a table
export default function PerformanceView({ stats, emptyTitle, emptyDescription }: PerformanceViewProps) {
    const money = (v: number) => formatMoney(v, stats.currency);
    const equity = 'equity' in stats ? stats.equity.filter(e => e.balance != null && e.equity != null) : [];
    const strategies = 'strategies' in stats ? stats.strategies : [];
    const source = 'capital_source' in stats ? stats.capital_source : null;
    const returnHint = stats.start_balance != null
        ? `sobre ${money(stats.start_balance)}${source && CAPITAL_SOURCE[source] ? ` (${CAPITAL_SOURCE[source]})` : ''}`
        : (source && NO_CAPITAL[source]) || 'sem o saldo inicial';
    const before = 'before_mirror' in stats ? stats.before_mirror : null;
    const homologation = 'homologation' in stats ? stats.homologation : null;
    const homologationNote = homologation && homologation.trades > 0 && (
        <p className="text-xs text-muted-foreground">
            Inclui {homologation.trades} {homologation.trades === 1 ? 'operação' : 'operações'} da homologação no
            Trademetric Dash, com resultado de {money(homologation.net)}: o acompanhamento ao vivo da conta do gestor
            {homologation.copy_start ? ` antes da primeira cópia (${formatDate(parseUtc(homologation.copy_start))})` : ', antes de qualquer cópia'}
            {homologation.verified === homologation.trades
                ? ', verificado pela OnTick.'
                : homologation.verified > 0
                    ? `, ${homologation.verified} verificadas pela OnTick e as outras informadas pelo EA do gestor.`
                    : ', informado pelo EA do gestor.'}
            {homologation.before_composed > 0 && homologation.composed_at
                && ` ${homologation.before_composed === homologation.trades ? 'Todas são' : `${homologation.before_composed} são`} de antes de o portfólio ser montado no Dash (${formatDate(parseUtc(homologation.composed_at))}): o acompanhamento ao vivo das estratégias que o compõem.`}
            {' '}Não têm custo de cópia: use o lucro por lote para descontar corretagem e slippage.
        </p>
    );
    const perLot = 'per_lot' in stats ? stats : null;
    const beforeNote = before && before.trades > 0 && (
        <p className="text-xs text-muted-foreground">
            Fora destes números: {before.trades} {before.trades === 1 ? 'operação' : 'operações'} de antes do Master
            se conectar ao Mirror{before.until ? ` (até ${formatDate(parseUtc(before.until))})` : ''}, com resultado
            de {money(before.net)}. Nenhum cliente as recebeu, então não fazem parte do histórico.
        </p>
    );

    if (stats.trades === 0 && equity.length === 0) {
        return (
            <div className="space-y-3">
                <div className="panel">
                    <EmptyState icon={<TrendingUp />} title={emptyTitle} description={emptyDescription} />
                </div>
                {beforeNote}
            </div>
        );
    }

    const curve = stats.curve.map(p => ({ t: parseUtc(p.t).getTime(), v: p.v }));
    const day = (t: number) => formatDate(t);

    return (
        <div className="space-y-6">
            {homologationNote}
            {beforeNote}
            <SlideRow className={cn('md:grid-cols-3', perLot ? 'xl:grid-cols-7' : 'xl:grid-cols-6')}>
                <Tile label="Resultado" value={money(stats.net)} tone={stats.net > 0 ? 'up' : stats.net < 0 ? 'down' : undefined} />
                <Tile label="Retorno" value={pct(stats.return_pct)}
                    hint={returnHint} />
                <Tile label="Acerto" value={pct(stats.win_rate)} hint={`${stats.wins} de ${stats.trades} operações`} />
                {perLot && (
                    <Tile label="Lucro por lote" value={perLot.per_lot == null ? '—' : money(perLot.per_lot)}
                        tone={perLot.per_lot != null && perLot.per_lot > 0 ? 'up' : perLot.per_lot != null && perLot.per_lot < 0 ? 'down' : undefined}
                        hint={`média em ${perLot.lots.toLocaleString('pt-BR')} ${perLot.lots === 1 ? 'lote' : 'lotes'}`} />
                )}
                <Tile label="Fator de lucro" value={stats.profit_factor == null ? '—' : stats.profit_factor.toLocaleString('pt-BR')}
                    hint="ganhos ÷ perdas" />
                <Tile label="Maior queda" value={money(-stats.max_drawdown)} hint={stats.max_drawdown_pct != null ? pct(-stats.max_drawdown_pct) : 'do resultado acumulado'} />
                <Tile label="Operações" value={String(stats.trades)}
                    hint={stats.best != null && stats.worst != null ? `melhor ${money(stats.best)}, pior ${money(stats.worst)}` : undefined} />
            </SlideRow>

            {(curve.length > 0 || equity.length > 1) && (
                // On phones the charts slide sideways; from md up they stack, the first two side by side from xl
                <SlideRow wide className="md:grid-cols-1 md:gap-6 xl:grid-cols-2">
                    {curve.length > 0 && (
                        <Card title="Resultado acumulado" description="Soma das operações fechadas, na ordem em que fecharam." icon={<LineIcon />}>
                            <LineChart
                                series={[{ key: 'net', label: 'Resultado acumulado', color: 'var(--viz-series-1)', points: curve }]}
                                ariaLabel={`Resultado acumulado: ${money(stats.net)} em ${stats.trades} operações`}
                                formatValue={money}
                                formatTime={day}
                                zeroLine
                                area
                            />
                        </Card>
                    )}
                    {curve.length > 0 && (
                        <Card title="Resultado por mês" description="Azul: meses positivos. Vermelho: negativos." icon={<TrendingUp />}>
                            <ColumnChart
                                data={stats.months.map(m => ({ label: monthLabel(m.month), value: m.net }))}
                                ariaLabel="Resultado por mês"
                                formatValue={money}
                            />
                        </Card>
                    )}
                    {equity.length > 1 && (
                        <Card title="Saldo e patrimônio da conta" description="O último valor de cada hora, como o EA informou." icon={<LineIcon />}
                            className="xl:col-span-2">
                            <LineChart
                                series={[
                                    { key: 'balance', label: 'Saldo', color: 'var(--viz-series-1)', points: equity.map(e => ({ t: parseUtc(e.t).getTime(), v: e.balance! })) },
                                    { key: 'equity', label: 'Patrimônio', color: 'var(--viz-series-2)', points: equity.map(e => ({ t: parseUtc(e.t).getTime(), v: e.equity! })) },
                                ]}
                                ariaLabel="Saldo e patrimônio da conta ao longo do período"
                                formatValue={money}
                                formatTime={day}
                            />
                        </Card>
                    )}
                </SlideRow>
            )}

            <details className="panel p-5 text-sm">
                <summary className="cursor-pointer font-medium">Ver os números</summary>
                <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Mês</TableHead>
                                <TableHead className="text-right">Resultado</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {stats.months.map(m => (
                                <TableRow key={m.month}>
                                    <TableCell>{monthLabel(m.month)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{money(m.net)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
                        <dt className="text-muted-foreground">Ganhos</dt><dd className="text-right tabular-nums">{money(stats.gross_profit)}</dd>
                        <dt className="text-muted-foreground">Perdas</dt><dd className="text-right tabular-nums">{money(-stats.gross_loss)}</dd>
                        <dt className="text-muted-foreground">Ganho médio</dt><dd className="text-right tabular-nums">{stats.avg_win == null ? '—' : money(stats.avg_win)}</dd>
                        <dt className="text-muted-foreground">Perda média</dt><dd className="text-right tabular-nums">{stats.avg_loss == null ? '—' : money(stats.avg_loss)}</dd>
                        {strategies.map(s => (
                            <div key={s.id ?? 'homologation'} className="contents">
                                <dt className="text-muted-foreground">{s.id == null ? 'Homologação, outras estratégias' : s.name ?? `Estratégia ${s.id}`} ({s.trades})</dt>
                                <dd className="text-right tabular-nums">{money(s.net)}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            </details>
        </div>
    );
}
