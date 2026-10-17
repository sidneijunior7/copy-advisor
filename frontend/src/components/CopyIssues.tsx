
import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import api, { type CopyIssue } from '../api';
import Card from './Card';
import { Badge } from './ui/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/Table';
import { formatDateTime } from '../lib/utils';

const POLL_MS = 60_000;
const DAYS = 7;
const LOT_LIMIT = 10034; // TRADE_RETCODE_LIMIT_VOLUME: what the license's lot limit held back

// MT5 TRADE_RETCODE_* a Slave reports when a copy did not go through
const REASONS: Record<number, string> = {
    [LOT_LIMIT]: 'Limite de lotes da licença',
    10019: 'Margem insuficiente',
    10018: 'Mercado fechado',
    10017: 'Negociação desabilitada no ativo',
    10027: 'AutoTrading desligado no terminal',
    10031: 'Sem conexão com a corretora',
    10014: 'Volume inválido para o ativo',
    10016: 'SL/TP inválidos',
    10030: 'Tipo de preenchimento recusado',
    10021: 'Sem cotação',
    10024: 'Ordens demais em pouco tempo',
    10040: 'Limite de posições da conta',
    10006: 'Recusada pela corretora',
    10004: 'Requote',
};

const ACTIONS: Record<string, string> = {
    OPEN: 'Abertura',
    ADD: 'Aumento',
    PARTIAL: 'Parcial',
    CLOSE: 'Fechamento',
    REVERSE: 'Reversão',
    MODIFY: 'SL/TP',
};

const formatVolume = (value: number) =>
    Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 8 });

export default function CopyIssues() {
    const [issues, setIssues] = useState<CopyIssue[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const refresh = async () => {
            try {
                const res = await api.get<CopyIssue[]>('/me/copy-issues', { params: { days: DAYS } });
                setIssues(res.data);
                setFailed(false);
            } catch (e) {
                console.error(e);
                setFailed(true);
            }
        };
        refresh();
        const timer = window.setInterval(refresh, POLL_MS);
        return () => window.clearInterval(timer);
    }, []);

    return (
        <Card
            title="Cópias com problema"
            description={`Últimos ${DAYS} dias: ordens recusadas pela corretora, falta de margem e o volume que o limite de lotes deixou de fora. Cada terminal informa cada falha uma vez.`}
            icon={<TriangleAlert />}
            flush
        >
            {issues === null ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">
                    {failed ? 'Não foi possível consultar. Tentando de novo a cada minuto.' : 'Carregando...'}
                </p>
            ) : issues.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">Nenhuma cópia com problema nos últimos {DAYS} dias.</p>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Quando</TableHead>
                            <TableHead>Conta</TableHead>
                            <TableHead>Portfólio</TableHead>
                            <TableHead title="Conta do Master e identificador da posição">Posição do Master</TableHead>
                            <TableHead>Operação</TableHead>
                            <TableHead className="text-right">Volume</TableHead>
                            <TableHead>Motivo</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {issues.map((issue, i) => (
                            <TableRow key={`${issue.at}:${issue.login}:${issue.uid}:${i}`}>
                                <TableCell className="tabular-nums">{formatDateTime(issue.at)}</TableCell>
                                <TableCell className="font-mono font-semibold">
                                    {issue.login}
                                    {issue.license_id == null && (
                                        <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">(sem licença)</span>
                                    )}
                                </TableCell>
                                <TableCell>{issue.portfolio_name}</TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground">{issue.uid}</TableCell>
                                <TableCell>{ACTIONS[issue.action] ?? issue.action}</TableCell>
                                <TableCell className="text-right font-mono tabular-nums">
                                    {issue.volume == null ? '—' : formatVolume(issue.volume)}
                                    {issue.retcode === LOT_LIMIT && (
                                        <span className="ml-1 font-sans text-xs text-muted-foreground">de fora</span>
                                    )}
                                </TableCell>
                                <TableCell>
                                    <Badge variant={issue.retcode === LOT_LIMIT ? 'warning' : 'destructive'} title={`Código ${issue.retcode}`}>
                                        {REASONS[issue.retcode] ?? `Recusada (código ${issue.retcode})`}
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
