
import { useEffect, useState } from 'react';
import { Plug, RadioTower, ServerOff, Unplug, Users } from 'lucide-react';
import api, { type Connections as HubConnections } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import { formatAgo, formatDateTime, formatTime } from '../../lib/utils';

const POLL_MS = 10_000;

export default function Connections() {
    const [data, setData] = useState<HubConnections | null>(null);
    // When the snapshot arrived, in ms: "connected for" is measured against it
    const [fetchedAt, setFetchedAt] = useState<number | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(true);

    const refresh = async () => {
        try {
            const res = await api.get<HubConnections>('/me/connections');
            setData(res.data);
            setFetchedAt(Date.now());
            setFailed(false);
        } catch (e) {
            console.error(e);
            setFailed(true);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        const timer = window.setInterval(refresh, POLL_MS);
        return () => window.clearInterval(timer);
    }, []);

    const masters = [...(data?.masters ?? [])].sort((a, b) => a.login - b.login);
    const slaves = [...(data?.slaves ?? [])].sort((a, b) =>
        a.portfolio_name.localeCompare(b.portfolio_name, 'pt-BR') || a.login - b.login);
    const manageOnly = slaves.filter(s => !s.active).length;
    const connectedFor = (connectedAt: number) => formatAgo((fetchedAt ?? 0) / 1000 - connectedAt);

    const hubStatus = failed
        ? { variant: 'destructive' as const, label: 'Falha ao consultar' }
        : data && !data.available
            ? { variant: 'destructive' as const, label: 'Hub indisponível' }
            : data ? { variant: 'success' as const, label: 'Hub disponível' } : null;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Conexões"
                description="Terminais conectados ao hub via WSS agora. EAs v3 usam ZMQ e não aparecem aqui."
                icon={<Plug />}
            >
                {fetchedAt && (
                    <span className="text-xs text-muted-foreground">Atualiza a cada 10 s · última às {formatTime(fetchedAt)}</span>
                )}
                {hubStatus && (
                    <Badge variant={hubStatus.variant} className="rounded-lg px-3 py-1.5 font-medium" role="status">
                        <span className="h-2 w-2 rounded-full bg-current" />
                        {hubStatus.label}
                    </Badge>
                )}
            </PageHeader>

            {loading ? (
                <p className="text-sm text-muted-foreground">Carregando...</p>
            ) : !data ? (
                <div className="panel">
                    <EmptyState
                        icon={<ServerOff />}
                        title="Não foi possível consultar as conexões"
                        description="Tentando de novo a cada 10 s."
                    />
                </div>
            ) : !data.available ? (
                <div className="panel">
                    <EmptyState
                        icon={<ServerOff />}
                        title="Hub indisponível"
                        description="O hub de sinais está fora do ar ou inacessível. Tentando de novo a cada 10 s."
                    />
                </div>
            ) : masters.length === 0 && slaves.length === 0 ? (
                <div className="panel">
                    <EmptyState
                        icon={<Unplug />}
                        title="Nenhum terminal conectado via WSS"
                        description="EAs v3 usam ZMQ e não aparecem aqui."
                    />
                </div>
            ) : (
                <>
                    <Card
                        title="Masters"
                        description={`${masters.length} ${masters.length === 1 ? 'conectado' : 'conectados'}`}
                        icon={<RadioTower />}
                        flush
                    >
                        {masters.length === 0 ? (
                            <p className="px-5 pb-5 text-sm text-muted-foreground">Nenhum Master conectado via WSS.</p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Chave</TableHead>
                                        <TableHead>Conta</TableHead>
                                        <TableHead>Versão do EA</TableHead>
                                        <TableHead>Conectado desde</TableHead>
                                        <TableHead>Última mensagem</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {masters.map(m => (
                                        <TableRow key={`${m.key_id}:${m.login}`}>
                                            <TableCell className="font-medium">{m.key_label ?? `Chave #${m.key_id}`}</TableCell>
                                            <TableCell className="font-mono font-semibold">{m.login}</TableCell>
                                            <TableCell className="font-mono text-xs text-muted-foreground">{m.ea_version || '—'}</TableCell>
                                            <TableCell>
                                                {formatDateTime(m.connected_at * 1000)}{' '}
                                                <span className="text-muted-foreground">({connectedFor(m.connected_at)})</span>
                                            </TableCell>
                                            <TableCell className="tabular-nums">{formatAgo(m.last_msg_age_s)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </Card>

                    <Card
                        title="Slaves"
                        description={`${slaves.length} ${slaves.length === 1 ? 'conectado' : 'conectados'}${manageOnly ? `, ${manageOnly} em só gestão` : ''}`}
                        icon={<Users />}
                        flush
                    >
                        {slaves.length === 0 ? (
                            <p className="px-5 pb-5 text-sm text-muted-foreground">Nenhum Slave conectado via WSS.</p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Portfólio</TableHead>
                                        <TableHead>Conta</TableHead>
                                        <TableHead>Versão do EA</TableHead>
                                        <TableHead>Modo</TableHead>
                                        <TableHead title="Mensagens do portfólio que o terminal ainda não confirmou">Atraso</TableHead>
                                        <TableHead>Último ACK</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {slaves.map(s => (
                                        <TableRow key={s.license_id}>
                                            <TableCell className="font-medium">{s.portfolio_name}</TableCell>
                                            <TableCell className="font-mono font-semibold">{s.login}</TableCell>
                                            <TableCell className="font-mono text-xs text-muted-foreground">{s.ea_version || '—'}</TableCell>
                                            <TableCell>
                                                {s.active ? (
                                                    <Badge variant="success">Ativo</Badge>
                                                ) : (
                                                    <Badge
                                                        variant="warning"
                                                        title="Licença revogada ou expirada: não abre posições novas e continua gerindo as abertas."
                                                    >
                                                        Só gestão
                                                    </Badge>
                                                )}
                                            </TableCell>
                                            <TableCell className="tabular-nums">
                                                {s.lag == null ? (
                                                    <span className="text-muted-foreground">—</span>
                                                ) : s.lag === 0 ? (
                                                    <span className="text-success">Em dia</span>
                                                ) : (
                                                    <span className="font-medium text-warning">
                                                        {s.lag} {s.lag === 1 ? 'mensagem' : 'mensagens'}
                                                    </span>
                                                )}
                                            </TableCell>
                                            <TableCell className="tabular-nums">
                                                {s.last_ack_age_s == null
                                                    ? <span className="text-muted-foreground">Nenhum ainda</span>
                                                    : formatAgo(s.last_ack_age_s)}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </Card>
                </>
            )}
        </div>
    );
}
