import { useEffect, useState } from 'react';
import { ListOrdered } from 'lucide-react';
import api, { type ClientIssue, type CopyRow } from '../../api';
import Card from '../Card';
import EmptyState from '../EmptyState';
import { Badge } from '../ui/Badge';
import { Select } from '../ui/Field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/Table';
import { formatPrice } from '../../lib/clientLicense';
import { ACTIONS, LOT_LIMIT, REASONS } from '../../lib/labels';
import { cn, formatDateTime } from '../../lib/utils';

const STATUS = {
    open: { label: 'Aberta', variant: 'primary' },
    closed: { label: 'Fechada', variant: 'muted' },
    failed: { label: 'Não copiada', variant: 'destructive' },
} as const;

// The copies on the client's account, from what its Slave reported
export function CopiesTable({ licenseId }: { licenseId: number }) {
    const [days, setDays] = useState(30);
    const [rows, setRows] = useState<CopyRow[] | null>(null);
    const [failed, setFailed] = useState(false);

    const changeDays = (value: number) => {
        setRows(null);
        setDays(value);
    };

    useEffect(() => {
        let cancelled = false;
        api.get<CopyRow[]>(`/me/licenses/${licenseId}/copies`, { params: { days } })
            .then(res => { if (!cancelled) { setRows(res.data); setFailed(false); } })
            .catch(e => { console.error(e); if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [licenseId, days]);

    const closed = rows?.filter(r => r.status === 'closed' && r.result != null) ?? [];
    const positive = closed.filter(r => (r.result ?? 0) > 0).length;

    return (
        <Card
            title="Cópias"
            description={rows && closed.length > 0
                ? `${closed.length} fechadas no período, ${positive} com resultado positivo. O resultado é a diferença de preço entre saída e entrada, no sentido da operação.`
                : 'O resultado é a diferença de preço entre saída e entrada, no sentido da operação.'}
            icon={<ListOrdered />}
            action={
                <Select value={days} onChange={e => changeDays(Number(e.target.value))} className="h-9 w-40" aria-label="Período">
                    <option value={7}>Últimos 7 dias</option>
                    <option value={30}>Últimos 30 dias</option>
                    <option value={90}>Últimos 90 dias</option>
                </Select>
            }
            flush
        >
            {rows === null ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">{failed ? 'Não foi possível carregar as cópias.' : 'Carregando...'}</p>
            ) : rows.length === 0 ? (
                <EmptyState icon={<ListOrdered />} title="Nenhuma cópia no período" description="As operações do portfólio aparecem aqui assim que forem copiadas para a sua conta." />
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Abertura</TableHead>
                            <TableHead>Ativo</TableHead>
                            <TableHead className="text-right">Volume</TableHead>
                            <TableHead className="text-right">Entrada</TableHead>
                            <TableHead className="text-right">Saída</TableHead>
                            <TableHead className="text-right">Resultado</TableHead>
                            <TableHead>Situação</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map(r => (
                            <TableRow key={r.uid}>
                                <TableCell className="tabular-nums">{formatDateTime(r.opened_at)}</TableCell>
                                <TableCell>
                                    <span className="font-medium">{r.symbol ?? '—'}</span>
                                    {r.type && (
                                        <span className={cn('ml-2 text-xs font-semibold', r.type === 'buy' ? 'text-success' : 'text-destructive')}>
                                            {r.type === 'buy' ? 'COMPRA' : 'VENDA'}
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="text-right font-mono tabular-nums">{r.volume ? r.volume.toLocaleString('pt-BR') : '—'}</TableCell>
                                <TableCell className="text-right font-mono tabular-nums">{r.open_price != null ? formatPrice(r.open_price) : '—'}</TableCell>
                                <TableCell className="text-right font-mono tabular-nums">{r.close_price != null ? formatPrice(r.close_price) : '—'}</TableCell>
                                <TableCell className={cn('text-right font-mono font-semibold tabular-nums',
                                    r.result == null ? 'text-muted-foreground' : r.result > 0 ? 'text-success' : r.result < 0 ? 'text-destructive' : '')}>
                                    {r.result == null ? '—' : `${r.result > 0 ? '+' : ''}${formatPrice(r.result)}`}
                                </TableCell>
                                <TableCell>
                                    <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                                    {r.failures > 0 && r.status !== 'failed' && (
                                        <span className="ml-1 text-xs text-muted-foreground" title="Veja em Problemas">{r.failures} falha{r.failures > 1 ? 's' : ''}</span>
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </Card>
    );
}

// What the client's Slave could not copy, or copied smaller
export function ClientIssues({ licenseId }: { licenseId: number }) {
    const [rows, setRows] = useState<ClientIssue[] | null>(null);

    useEffect(() => {
        api.get<ClientIssue[]>(`/me/licenses/${licenseId}/issues`, { params: { days: 30 } })
            .then(res => setRows(res.data))
            .catch(e => { console.error(e); setRows([]); });
    }, [licenseId]);

    return (
        <Card title="Problemas" description="Últimos 30 dias: ordens recusadas pela corretora, falta de margem e o que o limite de lotes deixou de fora." flush>
            {rows === null ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">Carregando...</p>
            ) : rows.length === 0 ? (
                <EmptyState icon={<ListOrdered />} title="Nenhum problema no período" />
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Quando</TableHead>
                            <TableHead>Operação</TableHead>
                            <TableHead className="text-right">Volume</TableHead>
                            <TableHead>Motivo</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((r, i) => (
                            <TableRow key={`${r.at}:${r.uid}:${i}`}>
                                <TableCell className="tabular-nums">{formatDateTime(r.at)}</TableCell>
                                <TableCell>{ACTIONS[r.action] ?? r.action}</TableCell>
                                <TableCell className="text-right font-mono tabular-nums">
                                    {r.volume == null || r.action === 'MODIFY' ? '—' : r.volume.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                    {r.retcode === LOT_LIMIT && <span className="ml-1 font-sans text-xs text-muted-foreground">de fora</span>}
                                </TableCell>
                                <TableCell>
                                    <Badge variant={r.retcode === LOT_LIMIT ? 'warning' : 'destructive'} title={`Código ${r.retcode}`}>
                                        {REASONS[r.retcode] ?? `Recusada (código ${r.retcode})`}
                                    </Badge>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </Card>
    );
}
