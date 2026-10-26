import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CreditCard, Server, Store } from 'lucide-react';
import api, { type ClientLicense, type MyLicenses } from '../../api';
import BillingCard from '../../components/client/BillingCard';
import HostingBillingCard from '../../components/client/HostingBilling';
import MySubscriptions, { EmailReminder } from '../../components/client/MySubscriptions';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Button } from '../../components/ui/Button';
import { hostingPriceLabel } from '../../lib/money';
import { openBillingPortal } from '../../lib/stripe';

const licenseName = (l: ClientLicense) => l.portfolio.name ?? `Portfólio #${l.portfolio.id}`;

const licenseLink = (l: ClientLicense, label = 'Licença') => (
    <Link to={`/client/licenses/${l.id}`} className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline">
        {label} <ChevronRight className="size-3.5" />
    </Link>
);

// Every license paid in Stripe in one place: the plan, upgrading or downgrading it, cancelling or resuming the
// renewal; then the hosting of each account, a subscription of its own, and the accounts that could have it.
// Below, the marketplace requests still waiting on a payment or on the manager
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

    const licenses = data?.licenses ?? [];
    const paid = licenses.filter(l => l.billing);
    const hosted = licenses.filter(l => l.hosting && !l.hosting.billing.exempt);
    // The combo: a valid license with its account, copying from the client's own computer
    const offer = data?.hosting_available && data.hosting_price
        ? licenses.filter(l => !l.hosting && l.valid && l.mt5_login != null)
        : [];

    return (
        <div className="space-y-6">
            <PageHeader
                title="Minhas assinaturas"
                description="Troque de plano, cancele ou retome a renovação. Cartão e faturas ficam na página de pagamentos da Stripe."
                icon={<CreditCard />}
            >
                {(paid.length > 0 || hosted.some(l => l.hosting!.billing.status)) && (
                    <Button variant="outline" onClick={openBillingPortal}><CreditCard /> Cartão e faturas</Button>
                )}
            </PageHeader>

            <EmailReminder />

            {data === null ? (
                <p className="text-sm text-muted-foreground">
                    {failed ? 'Não foi possível carregar as assinaturas.' : 'Carregando...'}
                </p>
            ) : paid.length === 0 && hosted.length === 0 ? (
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
                            title={licenseName(l)}
                            description={[l.manager && `por ${l.manager}`, l.mt5_login != null && `conta ${l.mt5_login}`].filter(Boolean).join(' · ') || undefined}
                            action={licenseLink(l)}
                        />
                    ))}
                    {hosted.map(l => (
                        <HostingBillingCard
                            key={`hosting-${l.id}`}
                            licenseId={l.id}
                            billing={l.hosting!.billing}
                            price={data.hosting_price}
                            onChanged={refresh}
                            title={`Hospedagem · conta ${l.mt5_login ?? '—'}`}
                            description={`${licenseName(l)} · ${l.hosting!.server}`}
                            action={licenseLink(l)}
                        />
                    ))}
                </div>
            )}

            {offer.length > 0 && (
                <Card
                    title="Complete o combo com a hospedagem"
                    description={`Seu MetaTrader num servidor nosso, ligado o tempo todo, sem depender do seu computador. ${hostingPriceLabel(data!.hosting_price!)} por conta, à parte da assinatura do portfólio.`}
                    icon={<Server />}
                >
                    <ul className="divide-y divide-border text-sm">
                        {offer.map(l => (
                            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                                <span>{licenseName(l)} · conta {l.mt5_login}</span>
                                {licenseLink(l, 'Hospedar esta conta')}
                            </li>
                        ))}
                    </ul>
                </Card>
            )}

            <MySubscriptions />
        </div>
    );
}
