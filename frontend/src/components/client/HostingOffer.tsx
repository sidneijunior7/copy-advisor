import { type ReactNode } from 'react';
import { Server, Sparkles } from 'lucide-react';
import type { HostingPrice } from '../../api';
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
