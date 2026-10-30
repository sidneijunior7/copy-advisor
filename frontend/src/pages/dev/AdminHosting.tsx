import { Fragment, useEffect, useState } from 'react';
import { BadgeCheck, CreditCard, Server } from 'lucide-react';
import { toast } from 'sonner';
import api, { type AdminHostedTerminal, type AdminHosting as Data } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import KPICard from '../../components/KPICard';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import { HOSTING_STATES } from '../../lib/labels';
import { formatMoney, hostingPriceLabel } from '../../lib/money';
import { apiError, cn, formatDate, formatDateTime } from '../../lib/utils';
import SlideRow from '../../components/SlideRow';

const POLL_MS = 15_000;

const FILTERS = [
    { id: 'all', label: 'Todos' },
    { id: 'paying', label: 'Pagantes' },
    { id: 'exempt', label: 'Isentos' },
    { id: 'unpaid', label: 'Sem pagamento' },
] as const;
type Filter = typeof FILTERS[number]['id'];

const paying = (t: AdminHostedTerminal) => !t.billing.exempt && t.billing.renewing;

// How a terminal's hosting is paid, in one badge
function BillingBadge({ t }: { t: AdminHostedTerminal }) {
    const b = t.billing;
    if (b.exempt) return <Badge variant="muted">Isento</Badge>;
    if (b.status === 'past_due') return <Badge variant="destructive">Cobrança falhou</Badge>;
    if (b.renewing && b.cancel_at_period_end) return <Badge variant="warning">Cancelada</Badge>;
    if (b.renewing) return <Badge variant="success">Pagando</Badge>;
    return <Badge variant="warning">{b.status ? 'Encerrada' : 'Nunca pagou'}</Badge>;
}

// Hosting across the platform: the pods, every hosted terminal and how it is paid. Exempting a terminal lets it run
// without paying; charging one that has no paid subscription stops it at the pod's next sync
export default function AdminHosting() {
    const [data, setData] = useState<Data | null>(null);
    const [failed, setFailed] = useState(false);
    const [filter, setFilter] = useState<Filter>('all');
    const [charging, setCharging] = useState<number | null>(null); // The terminal whose exemption waits on a confirmation
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const load = () => api.get<Data>('/admin/hosting')
            .then(res => { setData(res.data); setFailed(false); })
            .catch(e => { console.error(e); setFailed(true); });
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => window.clearInterval(timer);
    }, []);

    const setExempt = async (t: AdminHostedTerminal, exempt: boolean) => {
        setBusy(true);
        try {
            const res = await api.put<AdminHostedTerminal>(`/admin/hosting/${t.id}/exempt`, { exempt });
            setData(d => d && { ...d, terminals: d.terminals.map(r => (r.id === t.id ? res.data : r)) });
            setCharging(null);
            toast.success(exempt ? 'Terminal isento' : 'Terminal passa a ser cobrado');
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível alterar a cobrança.'));
        } finally {
            setBusy(false);
        }
    };

    const terminals = data?.terminals ?? [];
    const shown = terminals.filter(t => filter === 'all' || (filter === 'paying' && paying(t))
        || (filter === 'exempt' && t.billing.exempt) || (filter === 'unpaid' && !t.billing.paid));
    const payingCount = terminals.filter(paying).length;
    const running = terminals.filter(t => t.state === 'running').length;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Hospedagem"
                description={data?.price
                    ? `Terminais hospedados de todos os clientes. Preço: ${hostingPriceLabel(data.price)} por conta.`
                    : 'Terminais hospedados de todos os clientes.'}
                icon={<Server />}
            />

            {data && !data.charged && (
                <p className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
                    A hospedagem não está sendo cobrada: falta o <code>STRIPE_HOSTING_PRICE_ID</code> (ou a Stripe) na API.
                </p>
            )}

            <SlideRow className="md:grid-cols-2 md:gap-4 lg:grid-cols-4">
                <KPICard label="Terminais" value={terminals.length.toLocaleString('pt-BR')} icon={<Server />} />
                <KPICard label="Copiando agora" value={running.toLocaleString('pt-BR')} icon={<BadgeCheck />} />
                <KPICard label="Pagantes" value={payingCount.toLocaleString('pt-BR')} icon={<CreditCard />} />
                <KPICard
                    label="Receita recorrente"
                    value={data?.price ? formatMoney(payingCount * data.price.price, data.price.currency) : '—'}
                    icon={<CreditCard />}
                />
            </SlideRow>

            <Card title="Pods" description="Os servidores que rodam os terminais." icon={<Server />} flush>
                {data === null ? (
                    <p className="p-5 text-sm text-muted-foreground">{failed ? 'Não foi possível carregar.' : 'Carregando...'}</p>
                ) : data.pods.length === 0 ? (
                    <EmptyState icon={<Server />} title="Nenhum pod ativo" />
                ) : (
                    <Table stack>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Pod</TableHead>
                                <TableHead>Situação</TableHead>
                                <TableHead>Rodando / capacidade</TableHead>
                                <TableHead>Memória</TableHead>
                                <TableHead>Último contato</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {data.pods.map(p => (
                                <TableRow key={p.id}>
                                    <TableCell>
                                        <span className="font-medium">{p.name}</span>
                                        {p.agent && <p className="text-xs text-muted-foreground">agente {p.agent} · {p.servers} servidores</p>}
                                    </TableCell>
                                    <TableCell label="Situação">
                                        <Badge variant={p.online ? 'success' : 'destructive'}>{p.online ? 'No ar' : 'Fora do ar'}</Badge>
                                    </TableCell>
                                    <TableCell label="Rodando / capacidade">
                                        {p.running} / {p.capacity}
                                        {p.assigned > p.running && <span className="text-xs text-muted-foreground"> ({p.assigned - p.running} parados)</span>}
                                    </TableCell>
                                    <TableCell label="Memória">{p.memory_mb != null ? `${p.memory_mb.toLocaleString('pt-BR')} MB` : '—'}</TableCell>
                                    <TableCell label="Último contato">{p.last_seen_at ? formatDateTime(p.last_seen_at) : '—'}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </Card>

            <Card
                title="Terminais"
                icon={<Server />}
                flush
                action={
                    <div className="flex flex-wrap gap-1">
                        {FILTERS.map(f => (
                            <Button key={f.id} size="sm" variant={filter === f.id ? 'default' : 'ghost'} onClick={() => setFilter(f.id)}>
                                {f.label}
                            </Button>
                        ))}
                    </div>
                }
            >
                {data === null ? (
                    <p className="p-5 text-sm text-muted-foreground">{failed ? 'Não foi possível carregar.' : 'Carregando...'}</p>
                ) : shown.length === 0 ? (
                    <EmptyState icon={<Server />} title="Nenhum terminal aqui" />
                ) : (
                    <Table stack>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Conta</TableHead>
                                <TableHead>Cliente</TableHead>
                                <TableHead>Terminal</TableHead>
                                <TableHead>Cobrança</TableHead>
                                <TableHead className="text-right">Ações</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {shown.map(t => {
                                const { label, variant } = HOSTING_STATES[t.state] ?? { label: t.state, variant: 'muted' as const };
                                return (
                                    <Fragment key={t.id}>
                                        <TableRow className={cn(charging === t.id && 'border-b-0')}>
                                            <TableCell>
                                                <span className="font-medium">{t.mt5_login ?? '—'}</span>
                                                <p className="font-mono text-xs text-muted-foreground">{t.server}</p>
                                            </TableCell>
                                            <TableCell label="Cliente" className="text-sm">
                                                {t.client ? (t.client.name || t.client.email) : <span className="text-muted-foreground">Sem cliente</span>}
                                                <p className="text-xs text-muted-foreground">
                                                    {[t.portfolio, t.manager && `por ${t.manager}`].filter(Boolean).join(' · ')}
                                                </p>
                                            </TableCell>
                                            <TableCell label="Terminal">
                                                <Badge variant={variant}>{label}</Badge>
                                                <p className="mt-1 text-xs text-muted-foreground">{t.pod ?? 'sem pod'}</p>
                                            </TableCell>
                                            <TableCell label="Cobrança">
                                                <BillingBadge t={t} />
                                                {!t.billing.exempt && t.billing.period_end && (
                                                    <p className="mt-1 text-xs text-muted-foreground">pago até {formatDate(t.billing.period_end)}</p>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-right max-md:-ml-3">
                                                {t.billing.exempt ? (
                                                    charging !== t.id && (
                                                        <Button size="sm" variant="ghost" onClick={() => setCharging(t.id)}><CreditCard /> Cobrar</Button>
                                                    )
                                                ) : (
                                                    <Button size="sm" variant="ghost" loading={busy} onClick={() => setExempt(t, true)}>
                                                        {!busy && <BadgeCheck />} Isentar
                                                    </Button>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                        {charging === t.id && (
                                            <TableRow className="hover:bg-transparent max-md:pt-0">
                                                <TableCell colSpan={5} className="whitespace-normal pt-0">
                                                    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 sm:flex-row sm:items-center sm:justify-between">
                                                        <p className="text-sm">
                                                            Passar a cobrar este terminal? {t.billing.renewing
                                                                ? 'Ele já tem uma assinatura paga e continua rodando.'
                                                                : 'Sem uma assinatura paga, ele desliga em instantes, até o cliente pagar a hospedagem.'}
                                                        </p>
                                                        <div className="flex shrink-0 gap-1">
                                                            <Button size="sm" variant="destructive" loading={busy} onClick={() => setExempt(t, false)}>Cobrar</Button>
                                                            <Button size="sm" variant="ghost" onClick={() => setCharging(null)}>Cancelar</Button>
                                                        </div>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
            </Card>
        </div>
    );
}
