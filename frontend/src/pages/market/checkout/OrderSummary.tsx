import type { ReactNode } from 'react';
import { ChevronDown, Cloud, Lock, Monitor, ShoppingBag, Ticket, Users } from 'lucide-react';
import type { PublicListing, SimulationStep } from '../../../api';
import { formatMoney, hostingPriceLabel } from '../../../lib/money';
import { cn } from '../../../lib/utils';
import { cloudPrice, initials, planTitle, tierPriceText } from './format';

export type OrderProps = {
    listing: PublicListing;
    tier: SimulationStep;
    promo: boolean;
    code: string;
    wantsHosting: boolean | null;
    periodLabel: (days: number) => string;
    copiers: number | null;
};

function Line({ icon, label, value, detail, muted }: { icon?: ReactNode; label: ReactNode; value: ReactNode; detail?: ReactNode; muted?: boolean }) {
    return (
        <div className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
                <p className={cn('flex items-center gap-1.5', muted ? 'text-muted-foreground' : 'font-medium')}>{icon}{label}</p>
                {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
            </div>
            <p className={cn('shrink-0 text-right', muted ? 'text-muted-foreground' : 'font-semibold')}>{value}</p>
        </div>
    );
}

// What the client is buying, on every step: the portfolio and who runs it, the plan, where it runs and what is
// paid today. It updates as the choices change, so no screen asks something without saying what for
function OrderBody({ listing, tier, promo, code, wantsHosting, periodLabel, copiers }: OrderProps) {
    const offered = listing.hosting_allowed && listing.hosting_room === true;
    const cloud = offered && wantsHosting === true;
    const priced = tier.price != null;
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary" aria-hidden>
                    {initials(listing.manager.name)}
                </span>
                <div className="min-w-0">
                    <p className="truncate font-semibold">{listing.title}</p>
                    <p className="truncate text-xs text-muted-foreground">por {listing.manager.name}</p>
                </div>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
                {promo ? (
                    <Line icon={<Ticket className="size-3.5 text-primary" />} label="Acesso grátis" value="R$ 0,00"
                        detail={<>Código <span className="font-mono">{code.toUpperCase()}</span>. Os dias começam ao conectar a conta MT5.</>} />
                ) : (
                    <>
                        <Line label={planTitle(tier)} value={tierPriceText(tier, periodLabel)}
                            detail={`Capital sugerido: ${formatMoney(tier.recommended_capital, tier.currency)}`} />
                        {offered && wantsHosting == null && <Line muted label="Onde roda" value="a escolher" />}
                        {offered && wantsHosting != null && (
                            <Line icon={cloud ? <Cloud className="size-3.5 text-primary" /> : <Monitor className="size-3.5 text-muted-foreground" />}
                                label={cloud ? 'Nuvem da Trademetric' : 'No meu computador'}
                                value={cloud ? cloudPrice(listing.hosting_price) : 'Grátis'}
                                detail={cloud && listing.hosting_price ? 'À parte, ao conectar a conta' : undefined} />
                        )}
                        {listing.hosting_allowed && !offered && (
                            <Line icon={<Monitor className="size-3.5 text-muted-foreground" />} label="No meu computador" value="Grátis"
                                detail="A nuvem está sem vagas agora" />
                        )}
                    </>
                )}
            </div>

            {!promo && (
                <dl className="space-y-1.5 border-t border-border pt-4 text-sm">
                    {!priced ? (
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Preço</dt><dd>Sob consulta</dd></div>
                    ) : listing.pay_online ? (
                        <>
                            <div className="flex justify-between gap-3 text-base font-bold"><dt>Total hoje</dt><dd>{formatMoney(tier.price ?? 0, tier.currency)}</dd></div>
                            <div className="flex justify-between gap-3 text-muted-foreground"><dt>Depois, a cada {periodLabel(tier.days)}</dt><dd>{formatMoney(tier.price ?? 0, tier.currency)}</dd></div>
                        </>
                    ) : (
                        <div className="flex justify-between gap-3 font-bold"><dt>Pago ao gestor</dt><dd>{tierPriceText(tier, periodLabel)}</dd></div>
                    )}
                    {cloud && listing.hosting_price && (
                        <div className="flex justify-between gap-3 text-muted-foreground"><dt>Nuvem, à parte</dt><dd>{hostingPriceLabel(listing.hosting_price)}</dd></div>
                    )}
                </dl>
            )}

            <ul className="space-y-1.5 border-t border-border pt-4 text-xs text-muted-foreground">
                {promo ? <li className="flex items-center gap-1.5"><Lock className="size-3.5" /> Sem cartão de crédito</li>
                    : listing.pay_online && <li className="flex items-center gap-1.5"><Lock className="size-3.5" /> Pagamento seguro pela Stripe. Cancele quando quiser, sem multa.</li>}
                {copiers ? <li className="flex items-center gap-1.5"><Users className="size-3.5" /> {copiers.toLocaleString('pt-BR')} {copiers === 1 ? 'conta copiou' : 'contas copiaram'} nos últimos 90 dias</li> : null}
            </ul>
        </div>
    );
}

// A wide screen: a column beside the steps, fixed while the page scrolls
export function OrderSummary(props: OrderProps) {
    return (
        <aside className="panel p-5" aria-label="Seu pedido">
            <p className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ShoppingBag className="size-3.5" /> Seu pedido
            </p>
            <OrderBody {...props} />
        </aside>
    );
}

// A phone: one line under the progress with the plan and its price, opening into the same order
export function OrderBar(props: OrderProps & { className?: string }) {
    const { tier, promo, periodLabel, className } = props;
    return (
        <details className={cn('group panel overflow-hidden', className)}>
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 items-center gap-2">
                    <ShoppingBag className="size-4 shrink-0 text-primary" />
                    <span className="truncate">
                        <span className="sr-only">Seu pedido: </span>
                        <span className="font-medium">{promo ? 'Acesso grátis' : planTitle(tier)}</span>
                    </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 font-semibold">
                    {promo ? 'R$ 0,00' : tierPriceText(tier, periodLabel)}
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
                </span>
            </summary>
            <div className="border-t border-border p-4"><OrderBody {...props} /></div>
        </details>
    );
}
