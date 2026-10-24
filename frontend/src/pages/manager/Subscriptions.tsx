import { Fragment, useEffect, useState } from 'react';
import { Check, Inbox, X } from 'lucide-react';
import { toast } from 'sonner';
import api, { type Subscription } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import { SUBSCRIPTION_STATUS } from '../../lib/labels';
import { apiError, cn, formatDateTime } from '../../lib/utils';

type Decision = { id: number; kind: 'approve' | 'reject'; note: string; max_lots: string; days: string };

// Requests from the marketplace: approving creates (or extends) the client's license, already linked to it
export default function Subscriptions() {
    const [rows, setRows] = useState<Subscription[] | null>(null);
    const [filter, setFilter] = useState<'pending' | 'all'>('pending');
    const [decision, setDecision] = useState<Decision | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api.get<Subscription[]>('/me/subscriptions')
            .then(res => setRows(res.data))
            .catch(e => { console.error(e); setRows([]); });
    }, []);

    const decide = async () => {
        if (!decision) return;
        setBusy(true);
        try {
            const res = await api.post<Subscription>(`/subscriptions/${decision.id}/${decision.kind}`, {
                note: decision.note.trim() || null,
                ...(decision.kind === 'approve' && {
                    max_lots: decision.max_lots ? parseFloat(decision.max_lots) : null,
                    days: decision.days ? parseInt(decision.days) : null,
                }),
            });
            setRows(current => current && current.map(r => (r.id === res.data.id ? res.data : r)));
            toast.success(decision.kind === 'approve' ? 'Assinatura aprovada' : 'Pedido recusado', {
                description: decision.kind === 'approve' ? 'A licença já aparece em Minhas licenças, na conta do cliente.' : undefined,
            });
            setDecision(null);
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível responder o pedido.'));
        } finally {
            setBusy(false);
        }
    };

    const shown = (rows ?? []).filter(r => filter === 'all' || r.status === 'pending');
    const pendingCount = (rows ?? []).filter(r => r.status === 'pending').length;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Assinaturas"
                description="Pedidos do marketplace. Aprove quando o pagamento entrar: a licença é criada (ou renovada) já na conta do cliente."
                icon={<Inbox />}
            />
            <Card
                title={filter === 'pending' ? `${pendingCount} ${pendingCount === 1 ? 'pedido esperando' : 'pedidos esperando'}` : 'Todos os pedidos'}
                icon={<Inbox />}
                action={
                    <div className="flex gap-1">
                        <Button size="sm" variant={filter === 'pending' ? 'secondary' : 'ghost'} aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>Pendentes</Button>
                        <Button size="sm" variant={filter === 'all' ? 'secondary' : 'ghost'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Todos</Button>
                    </div>
                }
                flush
            >
                {rows === null ? (
                    <p className="px-5 pb-5 text-sm text-muted-foreground">Carregando...</p>
                ) : shown.length === 0 ? (
                    <EmptyState icon={<Inbox />} title={filter === 'pending' ? 'Nenhum pedido esperando' : 'Nenhum pedido ainda'}
                        description="Os pedidos chegam quando clientes assinam seus portfólios no marketplace." />
                ) : (
                    <Table stack>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Quando</TableHead>
                                <TableHead>Cliente</TableHead>
                                <TableHead>Portfólio</TableHead>
                                <TableHead>Conta MT5</TableHead>
                                <TableHead>Situação</TableHead>
                                <TableHead className="text-right">Ações</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {shown.map(s => {
                                const status = SUBSCRIPTION_STATUS[s.status];
                                const open = decision?.id === s.id ? decision : null;
                                return (
                                    <Fragment key={s.id}>
                                        <TableRow className={cn(open && 'border-b-0')}>
                                            <TableCell label="Quando" className="tabular-nums">{formatDateTime(s.created_at)}</TableCell>
                                            <TableCell label="Cliente">
                                                <p className="font-medium">{s.client?.name ?? s.client?.email}</p>
                                                <p className="text-xs text-muted-foreground">{s.client?.email}</p>
                                            </TableCell>
                                            <TableCell label="Portfólio">
                                                {s.listing.title}
                                                {s.kind === 'renewal' && <span className="ml-1 text-xs text-muted-foreground">(renovação)</span>}
                                                {s.paid_online && <span className="ml-1 text-xs text-muted-foreground">(pago pela Stripe)</span>}
                                                {s.note && <p className="text-xs text-muted-foreground">"{s.note}"</p>}
                                            </TableCell>
                                            <TableCell label="Conta MT5" className="font-mono">{s.mt5_login ?? <span className="font-sans text-muted-foreground">Depois do pagamento</span>}</TableCell>
                                            <TableCell label="Situação">
                                                <Badge variant={status.variant}>{status.label}</Badge>
                                                {s.decision_note && <p className="mt-1 text-xs text-muted-foreground">{s.decision_note}</p>}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {s.status === 'pending' && !open && (
                                                    <div className="flex justify-end gap-1 max-md:justify-start">
                                                        <Button size="sm" onClick={() => setDecision({ id: s.id, kind: 'approve', note: '', max_lots: '', days: String(s.listing.default_days) })}>
                                                            <Check /> Aprovar
                                                        </Button>
                                                        <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                            onClick={() => setDecision({ id: s.id, kind: 'reject', note: '', max_lots: '', days: '' })}>
                                                            <X /> Recusar
                                                        </Button>
                                                    </div>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                        {open && (
                                            <TableRow className="hover:bg-transparent max-md:pt-0">
                                                <TableCell colSpan={6} className="whitespace-normal pt-0">
                                                    <form onSubmit={e => { e.preventDefault(); decide(); }}
                                                        className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/30 p-3 md:flex-row md:items-end">
                                                        {open.kind === 'approve' && (
                                                            <>
                                                                <label className="text-sm">Dias de validade
                                                                    <Input type="number" min="1" value={open.days} className="mt-1 h-9 w-28 font-mono"
                                                                        onChange={e => setDecision({ ...open, days: e.target.value })} />
                                                                </label>
                                                                <label className="text-sm">Limite de lotes
                                                                    <Input type="number" step="0.01" min="0.01" value={open.max_lots} placeholder="Padrão do anúncio"
                                                                        className="mt-1 h-9 w-40 font-mono" onChange={e => setDecision({ ...open, max_lots: e.target.value })} />
                                                                </label>
                                                            </>
                                                        )}
                                                        <label className="flex-1 text-sm">{open.kind === 'approve' ? 'Mensagem ao cliente (opcional)' : 'Motivo (o cliente recebe)'}
                                                            <Input value={open.note} maxLength={500} className="mt-1 h-9"
                                                                onChange={e => setDecision({ ...open, note: e.target.value })} />
                                                        </label>
                                                        <div className="flex gap-1">
                                                            <Button size="sm" loading={busy} variant={open.kind === 'approve' ? 'default' : 'destructive'}>
                                                                {open.kind === 'approve' ? 'Aprovar e criar licença' : 'Recusar pedido'}
                                                            </Button>
                                                            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDecision(null)}>Cancelar</Button>
                                                        </div>
                                                    </form>
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
