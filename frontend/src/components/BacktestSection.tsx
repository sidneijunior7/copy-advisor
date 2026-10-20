import { FlaskConical } from 'lucide-react';
import type { BacktestView } from '../api';
import Card from './Card';
import ConeChart from './charts/ConeChart';
import { Tile } from './PerformanceView';
import TileRow from './TileRow';
import { Badge } from './ui/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/Table';
import { formatMoney, signedPct } from '../lib/money';
import { formatDate, parseUtc } from '../lib/utils';

// "2023–2025", or "2025" when the backtest fits in one year
const years = (from: string | null, to: string | null) => {
    if (!from) return '—';
    const a = parseUtc(from).getFullYear(), b = to ? parseUtc(to).getFullYear() : a;
    return a === b ? String(a) : `${a}–${b}`;
};

// What the percentages are over: the portfolio's Monte Carlo on the Dash, or the balance declared there
const capitalHint = (s: { initial_balance: number | null; capital_basis: 'monte_carlo' | 'declared' | null; currency: string | null }) =>
    s.initial_balance == null
        ? 'sem o capital declarado'
        : `sobre ${formatMoney(s.initial_balance, s.currency)}${s.capital_basis === 'monte_carlo' ? ' (DD máx. +3σ)' : ''}`;

const pct = (value: number | null) => (value == null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);

// Why there is no cone, in the words the page shows
const CONE_MISSING: Record<string, string> = {
    capital: 'O backtest não tem o capital inicial declarado no Dash. Sem ele, não dá para comparar em % da conta.',
    accounts: 'O portfólio opera em mais de uma conta Master. A comparação em % da conta precisa de uma só.',
    balance: 'Ainda sem o saldo da conta Master. Ele vem do EA Master 4.01 ou mais novo.',
    currency: 'O capital do backtest está numa moeda e a conta Master em outra. A comparação precisa das duas na mesma moeda.',
    'no-trades': 'Sem operações fechadas no período, na homologação ou na cópia, para comparar com o backtest.',
    'few-trades': 'A comparação aparece a partir de 5 operações fechadas no período, contando a homologação.',
};

const VERDICT: Record<string, string> = {
    inside: 'O resultado ao vivo está dentro do que o backtest previa: entre os 5% piores e os 5% melhores cenários.',
    below: 'O resultado ao vivo está abaixo do que o backtest previa: pior que 95% dos cenários.',
    above: 'O resultado ao vivo está acima do que o backtest previa: melhor que 95% dos cenários.',
};

// The backtest the manager declared on the Trademetric Dash, labelled as such, and the live result drawn in its
// Monte Carlo cone, both in percent of the account
export default function BacktestSection({ view }: { view: BacktestView }) {
    if (!view.available) return null;
    const b = view.backtest;
    const period = b.from && b.to ? `${formatDate(parseUtc(b.from))} a ${formatDate(parseUtc(b.to))}` : undefined;
    const inc = view.incubation;
    const incPeriod = inc?.from && inc.to ? `${formatDate(parseUtc(inc.from))} a ${formatDate(parseUtc(inc.to))}` : undefined;
    const cone = view.cone;
    const rows = cone ? cone.bands.filter((_, i) => i % Math.max(1, Math.ceil(cone.bands.length / 15)) === 0 || i === cone.bands.length - 1) : [];

    return (
        <div className="space-y-6">
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="warning">Backtest declarado</Badge>
                Simulação enviada pelo gestor ao Trademetric Dash, não é resultado real.
                {b.strategies.length > 0 && <span>Estratégias: {b.strategies.join(', ')}.</span>}
            </p>
            <TileRow className="md:grid-cols-3 xl:grid-cols-6">
                <Tile label="Retorno" value={pct(b.return_pct)}
                    hint={capitalHint(b)} />
                <Tile label="Maior queda" value={b.max_drawdown_pct == null ? '—' : pct(-b.max_drawdown_pct)} hint="do saldo" />
                <Tile label="Acerto" value={pct(b.win_rate)} />
                <Tile label="Fator de lucro" value={b.profit_factor == null ? '—' : b.profit_factor.toLocaleString('pt-BR')} hint="ganhos ÷ perdas" />
                <Tile label="Operações" value={b.trades.toLocaleString('pt-BR')} hint={b.truncated ? 'as primeiras 20 mil' : undefined} />
                <Tile label="Período" value={years(b.from, b.to)} hint={period} />
            </TileRow>
            {inc && (
                <div className="space-y-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <Badge variant={inc.verified === inc.trades ? 'success' : 'primary'}>Homologação no Dash</Badge>
                        {inc.verified === inc.trades
                            ? 'Acompanhamento ao vivo da conta do gestor no Trademetric Dash, verificado pela OnTick.'
                            : inc.verified > 0
                                ? `Acompanhamento ao vivo da conta do gestor no Trademetric Dash: ${inc.verified} de ${inc.trades} operações verificadas pela OnTick, as outras informadas pelo EA do gestor.`
                                : 'Acompanhamento ao vivo da conta do gestor no Trademetric Dash, informado pelo EA do gestor.'}
                        {' '}{inc.official === inc.trades
                            ? 'Fazem parte do histórico: vieram antes da primeira cópia.'
                            : `As ${inc.official} de antes da primeira cópia fazem parte do histórico; depois dela, vale o que os clientes receberam.`}
                    </p>
                    <TileRow className="md:grid-cols-3 xl:grid-cols-6">
                        <Tile label="Retorno" value={pct(inc.return_pct)}
                            hint={capitalHint(inc)} />
                        <Tile label="Maior queda" value={inc.max_drawdown_pct == null ? '—' : pct(-inc.max_drawdown_pct)} hint="do saldo" />
                        <Tile label="Acerto" value={pct(inc.win_rate)} />
                        <Tile label="Fator de lucro" value={inc.profit_factor == null ? '—' : inc.profit_factor.toLocaleString('pt-BR')} hint="ganhos ÷ perdas" />
                        <Tile label="Operações" value={inc.trades.toLocaleString('pt-BR')} />
                        <Tile label="Período" value={incPeriod ?? '—'} />
                    </TileRow>
                </div>
            )}
            <Card title="Ao vivo dentro do backtest" icon={<FlaskConical />}
                description="Mil caminhos sorteados das operações do backtest, com tantas operações quanto o histórico tem no período (homologação e cópia), em % da conta. A faixa mostra onde caíram 50% e 90% deles.">
                <div className="mt-4 space-y-4">
                    {cone ? (
                        <>
                            <p className="text-sm font-medium">{VERDICT[cone.verdict]}</p>
                            <ConeChart bands={cone.bands}
                                ariaLabel={`Resultado ao vivo de ${signedPct(cone.bands[cone.bands.length - 1].live)} em ${cone.trades} operações, contra o cone do backtest`} />
                            <details className="text-sm">
                                <summary className="cursor-pointer font-medium">Ver os números</summary>
                                <Table stack className="mt-3">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Operações</TableHead>
                                            <TableHead className="text-right">Ao vivo</TableHead>
                                            <TableHead className="text-right">Mediana</TableHead>
                                            <TableHead className="text-right">50% dos cenários</TableHead>
                                            <TableHead className="text-right">90% dos cenários</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {rows.map(r => (
                                            <TableRow key={r.k}>
                                                <TableCell label="Operações" className="tabular-nums">{r.k}</TableCell>
                                                <TableCell label="Ao vivo" className="text-right tabular-nums">{signedPct(r.live)}</TableCell>
                                                <TableCell label="Mediana" className="text-right tabular-nums">{signedPct(r.p50)}</TableCell>
                                                <TableCell label="50% dos cenários" className="text-right tabular-nums">{signedPct(r.p25)} a {signedPct(r.p75)}</TableCell>
                                                <TableCell label="90% dos cenários" className="text-right tabular-nums">{signedPct(r.p5)} a {signedPct(r.p95)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </details>
                        </>
                    ) : (
                        <p className="text-sm text-muted-foreground">{CONE_MISSING[view.cone_missing ?? 'few-trades']}</p>
                    )}
                </div>
            </Card>
        </div>
    );
}
