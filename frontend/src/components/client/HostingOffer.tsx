import { type ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server, Sparkles } from 'lucide-react';
import api, { type ClientLicense, type HostingPrice, type MyLicenses } from '../../api';
import { hostingCandidates } from '../../lib/clientLicense';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatMoney, periodLabel } from '../../lib/money';
import { cn } from '../../lib/utils';

// The fine print: the price is per MT5 account, and each account subscribes on its own
export function HostingFinePrint({ price }: { price: HostingPrice }) {
    return (
        <p className="text-xs text-muted-foreground">
            {formatMoney(price.price, price.currency)} por {periodLabel(price.days)} <strong className="font-semibold text-foreground">por conta MT5</strong>,
            cobrado à parte da assinatura do portfólio. Cada conta hospedada é uma assinatura própria: para hospedar outra
            conta, ative a hospedagem nela também.
        </p>
    );
}

// The upsell of hosting, the "for a little more" offer: the price up front, yes or not now. Saying yes shows the
// credentials form (children); "not now" folds it into one line that can be opened again. With several accounts,
// actions replaces the yes with one per account
export default function HostingOffer({ price, stage = 'offer', onYes, onLater, actions, children, className }: {
    price: HostingPrice;
    stage?: 'offer' | 'form' | 'later';
    onYes?: () => void;
    onLater?: () => void;
    actions?: ReactNode;
    children?: ReactNode;
    className?: string;
}) {
    const amount = formatMoney(price.price, price.currency);
    const per = periodLabel(price.days);

    if (stage === 'later') {
        return (
            <div className={cn('flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm', className)}>
                <span className="flex items-center gap-2">
                    <Server className="size-4 text-primary" />
                    Hospedagem em nuvem por <strong>{amount}</strong> / {per}
                </span>
                <Button size="sm" variant="outline" onClick={onYes}>Quero</Button>
            </div>
        );
    }

    return (
        <section className={cn('relative overflow-hidden rounded-xl border-2 border-primary/40 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-5', className)}>
            <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-primary/10 blur-3xl" />
            <div className="relative space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="primary"><Sparkles className="size-3" /> Hospedagem em nuvem</Badge>
                    <Badge variant="success">{amount} / {per}</Badge>
                </div>
                <div className="space-y-1">
                    <h2 className="text-lg font-semibold leading-snug text-foreground">
                        Por mais <span className="text-primary">{amount}</span> por {per}, você deixa tudo no automático. Quer?
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        O MetaTrader roda num servidor nosso, ligado o tempo todo. Pode desligar o computador: a cópia
                        continua.
                    </p>
                </div>
                {stage === 'form' ? children : actions ?? (
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={onYes}><Server /> Sim, quero</Button>
                        {onLater && <Button variant="ghost" onClick={onLater}>Agora não</Button>}
                    </div>
                )}
                <HostingFinePrint price={price} />
            </div>
        </section>
    );
}

// The offer for several accounts at once: a yes per account, which opens its license with the form ready
export function HostingOfferList({ price, licenses, className }: { price: HostingPrice; licenses: ClientLicense[]; className?: string }) {
    const navigate = useNavigate();
    if (licenses.length === 0) return null;
    return (
        <HostingOffer
            price={price}
            className={className}
            actions={
                <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
                    {licenses.map(l => (
                        <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                            <span>
                                <span className="font-medium">Conta {l.mt5_login}</span>
                                <span className="text-muted-foreground"> · {l.portfolio.name ?? `Portfólio #${l.portfolio.id}`}</span>
                            </span>
                            <Button size="sm" onClick={() => navigate(`/client/licenses/${l.id}?hospedar=1`)}>
                                <Server /> Sim, hospedar esta conta
                            </Button>
                        </li>
                    ))}
                </ul>
            }
        />
    );
}

// The same offer on pages that do not load the licenses themselves: shown while some license has no hosting
export function HostingOfferBanner({ className }: { className?: string }) {
    const [data, setData] = useState<MyLicenses | null>(null);
    useEffect(() => {
        api.get<MyLicenses>('/me/licenses').then(res => setData(res.data)).catch(e => console.error(e));
    }, []);
    if (!data?.hosting_price) return null;
    return <HostingOfferList price={data.hosting_price} licenses={hostingCandidates(data)} className={className} />;
}
