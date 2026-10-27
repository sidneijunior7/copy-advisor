import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server, Sparkles } from 'lucide-react';
import type { ClientLicense, HostingPrice } from '../../api';
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
export default function HostingOffer({ price, stage = 'offer', onYes, onLater, actions, footer, stopped = false, children, className }: {
    price: HostingPrice;
    stage?: 'offer' | 'form' | 'later';
    onYes?: () => void;
    onLater?: () => void;
    actions?: ReactNode;
    footer?: ReactNode; // Under the actions, before the fine print
    stopped?: boolean; // The EA on the client's computer is not connected: the offer speaks to that
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
                        {stopped
                            ? <>Seu computador está desligado? Por <span className="text-primary">{amount}</span> por {per}, a cópia não para mais.</>
                            : <>Por mais <span className="text-primary">{amount}</span> por {per}, você deixa tudo no automático. Quer?</>}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        {stopped
                            ? 'Agora o EA do seu computador não está conectado, e as operações do gestor não chegam à sua conta. Na nuvem, o MetaTrader fica ligado o tempo todo.'
                            : 'O MetaTrader roda num servidor nosso, ligado o tempo todo. Pode desligar o computador: a cópia continua.'}
                    </p>
                </div>
                {stage === 'form' ? children : actions ?? (
                    <div className="flex flex-wrap gap-2">
                        <Button size="lg" className="w-full sm:w-auto" onClick={onYes}><Server /> Sim, quero</Button>
                        {onLater && <Button variant="ghost" className="w-full sm:w-auto" onClick={onLater}>Agora não</Button>}
                    </div>
                )}
                {footer}
                <HostingFinePrint price={price} />
            </div>
        </section>
    );
}

// "Not now" on the dashboard: the offer folds into one line for a week, on every page that lists accounts
const LATER_KEY = 'hosting-offer-later';
const LATER_DAYS = 7;
const laterActive = () => Number(localStorage.getItem(LATER_KEY) ?? 0) > Date.now();

// The offer for several accounts at once: a yes per account, which opens its license with the form ready
export function HostingOfferList({ price, licenses, dismissible = false, className }: {
    price: HostingPrice; licenses: ClientLicense[]; dismissible?: boolean; className?: string;
}) {
    const navigate = useNavigate();
    const [later, setLater] = useState(laterActive);
    if (licenses.length === 0) return null;
    const open = (l: ClientLicense) => navigate(`/client/licenses/${l.id}?hospedar=1`);
    return (
        <HostingOffer
            price={price}
            className={className}
            stage={later ? 'later' : 'offer'}
            onYes={() => {
                if (licenses.length === 1) { open(licenses[0]); return; }
                localStorage.removeItem(LATER_KEY);
                setLater(false);
            }}
            actions={
                <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
                    {licenses.map(l => (
                        <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                            <span>
                                <span className="font-medium">Conta {l.mt5_login}</span>
                                <span className="text-muted-foreground"> · {l.portfolio.name ?? `Portfólio #${l.portfolio.id}`}</span>
                            </span>
                            <Button size="sm" className="w-full sm:w-auto" onClick={() => open(l)}>
                                <Server /> Sim, hospedar esta conta
                            </Button>
                        </li>
                    ))}
                </ul>
            }
            footer={dismissible && <Button variant="ghost" size="sm" onClick={() => {
                localStorage.setItem(LATER_KEY, String(Date.now() + LATER_DAYS * 86_400_000));
                setLater(true);
            }}>Agora não</Button>}
        />
    );
}
