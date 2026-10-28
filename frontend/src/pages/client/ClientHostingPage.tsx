import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CreditCard, Server } from 'lucide-react';
import api, { type MyLicenses } from '../../api';
import Card from '../../components/Card';
import { HostingBillingBody } from '../../components/client/HostingBilling';
import { HostingOfferList } from '../../components/client/HostingOffer';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { hostingCandidates } from '../../lib/clientLicense';
import { HOSTING_STATES } from '../../lib/labels';
import { openBillingPortal } from '../../lib/stripe';
import { formatDateTime } from '../../lib/utils';

const POLL_MS = 15_000;

// Every account the client hosts with us, one card each: how the terminal is doing and how its hosting is paid.
// The server, the password, pausing and removing stay on the license. Below, the offer for the other accounts
export default function ClientHostingPage() {
    const [data, setData] = useState<MyLicenses | null>(null);
    const [failed, setFailed] = useState(false);
    const [reload, setReload] = useState(0); // Bumped to load again now, after a change
    const refresh = () => setReload(n => n + 1);

    useEffect(() => {
        const load = () => api.get<MyLicenses>('/me/licenses')
            .then(res => { setData(res.data); setFailed(false); })
            .catch(e => { console.error(e); setFailed(true); });
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => window.clearInterval(timer);
    }, [reload]);

    const hosted = (data?.licenses ?? []).filter(l => l.hosting);
    const candidates = hostingCandidates(data);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Hospedagem"
                description="As contas que rodam num servidor nosso, ligado o tempo todo. Cada conta hospedada é uma assinatura própria."
                icon={<Server />}
            >
                {hosted.some(l => l.hosting!.billing.status) && (
                    <Button variant="outline" onClick={openBillingPortal}><CreditCard /> Cartão e faturas</Button>
                )}
            </PageHeader>

            {data === null ? (
                <p className="text-sm text-muted-foreground">
                    {failed ? 'Não foi possível carregar a hospedagem.' : 'Carregando...'}
                </p>
            ) : hosted.length === 0 ? (
                candidates.length === 0 && (
                    <div className="panel">
                        <EmptyState
                            icon={<Server />}
                            title="Nenhuma conta hospedada"
                            description={!data.hosting_available
                                ? 'A hospedagem ainda não está disponível.'
                                : !data.hosting_room
                                    ? 'A nuvem está sem vagas no momento. Use o EA no seu computador por enquanto e volte mais tarde.'
                                    : 'Conecte a conta MT5 de uma licença válida para poder hospedá-la.'}
                        />
                    </div>
                )
            ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {hosted.map(l => {
                        const h = l.hosting!;
                        const { label, variant } = HOSTING_STATES[h.state] ?? { label: h.state, variant: 'muted' as const };
                        return (
                            <Card
                                key={l.id}
                                title={`Conta ${l.mt5_login ?? '—'}`}
                                description={`${l.portfolio.name ?? `Portfólio #${l.portfolio.id}`} · ${h.server}`}
                                icon={<Server />}
                                action={
                                    <Link to={`/client/licenses/${l.id}`} className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline">
                                        Gerenciar <ChevronRight className="size-3.5" />
                                    </Link>
                                }
                            >
                                <div className="space-y-4 text-sm">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant={variant}>{label}</Badge>
                                        {h.status_at && <span className="text-xs text-muted-foreground">desde {formatDateTime(h.status_at)}</span>}
                                    </div>
                                    {h.detail && <p className="text-muted-foreground">{h.detail}</p>}
                                    <div className="border-t border-border pt-4">
                                        {h.billing.exempt
                                            ? <p className="text-muted-foreground">Hospedagem incluída, sem cobrança.</p>
                                            : <HostingBillingBody licenseId={l.id} billing={h.billing} price={data.hosting_price} onChanged={refresh} />}
                                    </div>
                                </div>
                            </Card>
                        );
                    })}
                </div>
            )}

            {data?.hosting_price && <HostingOfferList price={data.hosting_price} licenses={candidates} />}
        </div>
    );
}
