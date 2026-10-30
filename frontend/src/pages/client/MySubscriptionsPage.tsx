import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CreditCard, Store } from 'lucide-react';
import api, { type ClientLicense, type MyLicenses } from '../../api';
import BillingCard from '../../components/client/BillingCard';
import HostingBillingCard from '../../components/client/HostingBilling';
import { HostingOfferList } from '../../components/client/HostingOffer';
import MySubscriptions, { EmailReminder } from '../../components/client/MySubscriptions';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Button } from '../../components/ui/Button';
import { hostingCandidates } from '../../lib/clientLicense';
import { openBillingPortal } from '../../lib/stripe';
import SlideRow from '../../components/SlideRow';

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

    return (
        <div className="space-y-6">
            <PageHeader
                title="Pagamentos"
                description="O que você assina: o portfólio de cada gestor e a hospedagem de cada conta. Troque de plano, cancele ou retome quando quiser."
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
                <SlideRow wide className="md:grid-cols-1 md:gap-4 lg:grid-cols-2">
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
                </SlideRow>
            )}

            {data?.hosting_price && <HostingOfferList price={data.hosting_price} licenses={hostingCandidates(data)} />}

            <MySubscriptions />
        </div>
    );
}
