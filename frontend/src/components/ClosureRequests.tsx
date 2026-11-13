import { useEffect, useState } from 'react';
import { UserX } from 'lucide-react';
import { toast } from 'sonner';
import api from '../api';
import Card from './Card';
import InlineConfirm from './InlineConfirm';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { apiError, formatDate, parseUtc } from '../lib/utils';

type ClosureRequest = { id: number; email: string; name: string | null; role: string; requested_at: string; due_at: string; blockers: string[] };

// The accounts whose holders asked to close them, with the deadline the Privacy Policy gives and what must be
// settled first. Shown only while there is one waiting
export default function ClosureRequests() {
    const [rows, setRows] = useState<ClosureRequest[]>([]);
    const [confirming, setConfirming] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        api.get<ClosureRequest[]>('/admin/closure-requests').then(res => setRows(res.data)).catch(e => console.error(e));
    }, [reload]);

    const close = async (id: number) => {
        setBusy(true);
        try {
            await api.post(`/admin/users/${id}/close`);
            toast.success('Conta encerrada', { description: 'O titular foi avisado por email.' });
            setConfirming(null);
            setReload(n => n + 1);
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível encerrar a conta.'));
        } finally {
            setBusy(false);
        }
    };

    if (rows.length === 0) return null;
    return (
        <Card title="Pedidos de encerramento de conta" icon={<UserX />}
            description="Pedidos dos titulares (LGPD). Cancele e reembolse as assinaturas ativas antes de encerrar.">
            <ul className="divide-y divide-border">
                {rows.map(r => (
                    <li key={r.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0 text-sm">
                                <p className="truncate font-medium">{r.name ?? r.email}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {r.email} · pedido em {formatDate(parseUtc(r.requested_at))} · prazo até {formatDate(parseUtc(r.due_at))}
                                </p>
                            </div>
                            {r.blockers.length > 0
                                ? <Badge variant="warning">Pendência</Badge>
                                : confirming !== r.id && <Button size="sm" variant="outline" onClick={() => setConfirming(r.id)}><UserX /> Encerrar conta</Button>}
                        </div>
                        {r.blockers.map(b => <p key={b} className="text-xs text-warning">{b}</p>)}
                        {confirming === r.id && (
                            <InlineConfirm confirmLabel="Encerrar" icon={<UserX />} loading={busy} onConfirm={() => close(r.id)} onCancel={() => setConfirming(null)}>
                                O acesso, a senha e as contas hospedadas de {r.email} são apagados agora. Não dá para desfazer.
                            </InlineConfirm>
                        )}
                    </li>
                ))}
            </ul>
        </Card>
    );
}
