import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, MailWarning, ShoppingBag, X } from 'lucide-react';
import { toast } from 'sonner';
import api, { type Me, type Subscription } from '../../api';
import Card from '../Card';
import ResendLinkButton from '../ResendLinkButton';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { SUBSCRIPTION_STATUS } from '../../lib/labels';
import { priceLabel } from '../../lib/money';
import { apiError, formatDate } from '../../lib/utils';

// The email confirmation reminder: subscribing needs it once the server sends email
export function EmailReminder() {
    const [me, setMe] = useState<Me | null>(null);
    useEffect(() => {
        api.get<Me>('/me').then(res => setMe(res.data)).catch(e => console.error(e));
    }, []);
    if (!me || me.email_verified || !me.email_enabled) return null;
    return (
        <div role="status" className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-2"><MailWarning className="mt-0.5 size-4 shrink-0 text-warning" />
                Confirme seu email ({me.email}) para assinar portfólios: o link está na sua caixa de entrada.</p>
            <ResendLinkButton />
        </div>
    );
}

// What the client asked for in the marketplace and where each request stands
export default function MySubscriptions() {
    const [rows, setRows] = useState<Subscription[] | null>(null);

    useEffect(() => {
        api.get<Subscription[]>('/me/subscriptions').then(res => setRows(res.data)).catch(e => { console.error(e); setRows([]); });
    }, []);

    const cancel = async (s: Subscription) => {
        try {
            const res = await api.post<Subscription>(`/me/subscriptions/${s.id}/cancel`);
            setRows(current => current && current.map(r => (r.id === s.id ? res.data : r)));
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível cancelar o pedido.'));
        }
    };

    if (!rows || rows.length === 0) return null;
    return (
        <Card title="Minhas assinaturas" description="Pedidos no marketplace. Quando o gestor aprova, a licença aparece aqui embaixo." icon={<ShoppingBag />}>
            <ul className="divide-y divide-border">
                {rows.slice(0, 10).map(s => {
                    const status = SUBSCRIPTION_STATUS[s.status];
                    return (
                        <li key={s.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                                <p className="font-medium">
                                    <Link to={`/marketplace/${s.listing.slug}`} className="hover:underline">{s.listing.title}</Link>
                                    {s.kind === 'renewal' && <span className="ml-1 text-xs text-muted-foreground">(renovação)</span>}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    Conta {s.mt5_login} · pedido em {formatDate(s.created_at)} · {priceLabel(s.listing)}
                                </p>
                                {s.decision_note && <p className="text-xs text-muted-foreground">Gestor: {s.decision_note}</p>}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                <Badge variant={status.variant}>{status.label}</Badge>
                                {s.status === 'pending' && s.listing.checkout_url && (
                                    <a href={s.listing.checkout_url} target="_blank" rel="noopener noreferrer">
                                        <Button size="sm"><ExternalLink /> Pagar</Button>
                                    </a>
                                )}
                                {s.status === 'pending' && (
                                    <Button size="sm" variant="ghost" onClick={() => cancel(s)} aria-label={`Cancelar o pedido de ${s.listing.title}`}>
                                        <X /> Cancelar
                                    </Button>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </Card>
    );
}
