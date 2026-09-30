import { ArrowDownRight, ArrowUpRight, Radio } from 'lucide-react';
import type { Trade } from '../hooks/useWebSocket';
import { formatTime } from '../lib/utils';
import EmptyState from './EmptyState';
import { Badge } from './ui/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/Table';

// MT5 reports "no stop" as 0
const level = (value: string | number) => (Number(value) > 0 ? value : '—');

interface PositionsTableProps {
    trades: Trade[];
    emptyTitle?: string;
    emptyDescription?: string;
}

export default function PositionsTable({
    trades,
    emptyTitle = 'Nenhuma posição aberta',
    emptyDescription = 'As posições das contas Master aparecem aqui assim que forem abertas.',
}: PositionsTableProps) {
    if (trades.length === 0) {
        return <EmptyState icon={<Radio />} title={emptyTitle} description={emptyDescription} />;
    }

    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>Estratégia</TableHead>
                    <TableHead>Ativo</TableHead>
                    <TableHead>Lado</TableHead>
                    <TableHead className="text-right">Lotes</TableHead>
                    <TableHead className="text-right">Preço</TableHead>
                    <TableHead className="text-right">SL</TableHead>
                    <TableHead className="text-right">TP</TableHead>
                    <TableHead className="text-right">Ticket</TableHead>
                    <TableHead className="text-right">Atualizado</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {trades.map(t => {
                    const isBuy = t.type === '0';
                    return (
                        <TableRow key={t.key ?? t.ticket}>
                            <TableCell className="font-medium">
                                {t.strategy_name || <span className="text-muted-foreground">Magic {t.magic ?? '—'}</span>}
                            </TableCell>
                            <TableCell className="font-mono font-semibold">{t.symbol}</TableCell>
                            <TableCell>
                                <Badge variant={isBuy ? 'success' : 'destructive'}>
                                    {isBuy ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                                    {isBuy ? 'Compra' : 'Venda'}
                                </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{t.volume}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{t.price}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{level(t.sl)}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{level(t.tp)}</TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">{t.ticket}</TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                                {t.timestamp ? formatTime(t.timestamp * 1000) : '—'}
                            </TableCell>
                        </TableRow>
                    );
                })}
            </TableBody>
        </Table>
    );
}
