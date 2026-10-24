import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CreditCard, Store } from 'lucide-react';
import api, { type MyLicenses } from '../../api';
import BillingCard from '../../components/client/BillingCard';
import MySubscriptions, { EmailReminder } from '../../components/client/MySubscriptions';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Button } from '../../components/ui/Button';
import { openBillingPortal } from '../../lib/stripe';

// Every license paid in Stripe in one place: the plan, upgrading or downgrading it, cancelling or resuming the
// renewal. Below, the marketplace requests still waiting on a payment or on the manager
export default function MySubscriptionsPage() {
    const [data, setData] = useState<MyLicenses | null>(null);
    const [failed, setFailed] = useState(false);
    const [reload, setReload] = useState(0); // Bumped to load again now, after a change
    const refresh = () => setReload(n => n + 1);

    useEffect(() => {
        api.get<MyLicenses>('/me/licenses')
            .then(res => { setData(res.data); setFailed(false); })
            .catch(e => { console.error(e); setFailed(true); });
    }, [reload]);

    const paid = (data?.licenses ?? []).filter(l => l.billing);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Minhas assinaturas"
                description="Troque de plano, cancele ou retome a renovação. Cartão e faturas ficam na página de pagamentos da Stripe."
                icon={<CreditCard />}
            >
                {paid.length > 0 && <Button variant="outline" onClick={openBillingPortal}><CreditCard /> Cartão e faturas</Button>}
            </PageHeader>

            <EmailReminder />

            {data === null ? (
                <p className="text-sm text-muted-foreground">
                    {failed ? 'Não foi possível carregar as assinaturas.' : 'Carregando...'}
                </p>
            ) : paid.length === 0 ? (
                <div className="panel">
                    <EmptyState
                        icon={<Store />}
                        title="Nenhuma assinatura paga online"
                        description="Quando você assinar um portfólio no Marketplace com cartão, a assinatura aparece aqui."
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {paid.map(l => (
                        <BillingCard
                            key={l.id}
                            billing={l.billing!}
                            onChanged={refresh}
                            title={l.portfolio.name ?? `Portfólio #${l.portfolio.id}`}
                            description={[l.manager && `por ${l.manager}`, l.mt5_login != null && `conta ${l.mt5_login}`].filter(Boolean).join(' · ') || undefined}
                            action={
                                <Link to={`/client/licenses/${l.id}`} className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline">
                                    Licença <ChevronRight className="size-3.5" />
                                </Link>
                            }
                        />
                    ))}
                </div>
            )}

            <MySubscriptions />
        </div>
    );
}
