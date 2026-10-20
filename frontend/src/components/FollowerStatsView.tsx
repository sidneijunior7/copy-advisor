import { Users } from 'lucide-react';
import type { FollowerStats, PublicFollowerStats } from '../api';
import Card from './Card';
import EmptyState from './EmptyState';
import { Tile } from './PerformanceView';
import TileRow from './TileRow';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/Table';

const pct = (value: number | null | undefined) =>
    value == null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

// Price differences: one decimal for an index's hundreds of points, up to six for a currency pair's fractions
const signed = (value: number) => {
    const size = Math.abs(value);
    const digits = size >= 100 ? 1 : size >= 1 ? 2 : size >= 0.01 ? 4 : 6;
    return `${value > 0 ? '+' : ''}${value.toLocaleString('pt-BR', { maximumFractionDigits: digits })}`;
};

interface FollowerStatsViewProps {
    stats: FollowerStats | PublicFollowerStats;
}

// How the followers copied the portfolio: in points, so a 0.01-lot account and a 10-lot one compare. The marketplace
// gets it only past a minimum of followers (the API leaves the figures out below it)
export default function FollowerStatsView({ stats }: FollowerStatsViewProps) {
    if ('enough' in stats && !stats.enough) {
        return (
            <div className="panel">
                <EmptyState
                    icon={<Users />}
                    title="Ainda sem seguidores suficientes"
                    description={`Os números aparecem com pelo menos ${stats.min_followers} seguidores e ${stats.min_copies} cópias fechadas no período, para que nenhum cliente seja identificado.`}
                />
            </div>
        );
    }
    const s = stats as FollowerStats;
    if (s.copies === 0) {
        return (
            <div className="panel">
                <EmptyState icon={<Users />} title="Nenhuma cópia fechada no período"
                    description="Os números aparecem quando as cópias dos clientes fecham, com o EA Slave 4.04 ou mais novo e o Master 4.01 ou mais novo." />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <TileRow className="md:grid-cols-2 xl:grid-cols-4">
                <Tile label="Captura" value={pct(s.capture)}
                    hint={s.capture == null ? 'o Master não ganhou pontos no período' : 'do resultado do Master, em pontos'} />
                <Tile label="Taxa de cópia" value={pct(s.copy_rate)} hint="das ordens enviadas, quantas abriram" />
                <Tile label="Seguidores" value={String(s.followers)} hint={`${s.copies} cópias fechadas`} />
                <Tile label="Tempo de cópia" value={s.latency_ms == null ? '—' : `${s.latency_ms.toLocaleString('pt-BR')} ms`}
                    hint="do Master à ordem do seguidor (mediana)" />
            </TileRow>
            <Card title="Por ativo" icon={<Users />} flush
                description="Média por operação, em pontos (diferença de preço). Custo positivo é um preço pior que o do Master; negativo, melhor.">
                <div className="mt-4">
                    <Table stack>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Ativo</TableHead>
                                <TableHead className="text-right">Cópias</TableHead>
                                <TableHead className="text-right">Master</TableHead>
                                <TableHead className="text-right">Seguidores</TableHead>
                                <TableHead className="text-right">Custo na entrada</TableHead>
                                <TableHead className="text-right">Custo na saída</TableHead>
                                <TableHead className="text-right">Captura</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {s.symbols.map(r => (
                                <TableRow key={r.symbol}>
                                    <TableCell className="font-medium">{r.symbol}</TableCell>
                                    <TableCell label="Cópias" className="text-right tabular-nums">{r.copies}</TableCell>
                                    <TableCell label="Master" className="text-right font-mono tabular-nums">{signed(r.master_points)}</TableCell>
                                    <TableCell label="Seguidores" className="text-right font-mono tabular-nums">{signed(r.follower_points)}</TableCell>
                                    <TableCell label="Custo na entrada" className="text-right font-mono tabular-nums">{signed(r.entry_cost)}</TableCell>
                                    <TableCell label="Custo na saída" className="text-right font-mono tabular-nums">{signed(r.exit_cost)}</TableCell>
                                    <TableCell label="Captura" className="text-right tabular-nums">{pct(r.capture)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </Card>
        </div>
    );
}
