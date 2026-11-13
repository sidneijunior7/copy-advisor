import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Cloud, CreditCard, MailCheck, Monitor, Ticket, Users } from 'lucide-react';
import type { PublicListing, SimulationStep, Subscription } from '../../../api';
import ResendLinkButton from '../../../components/ResendLinkButton';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Field';
import { formatMoney, hostingPriceLabel } from '../../../lib/money';
import { cn } from '../../../lib/utils';
import { CLOUD_BILLED_APART, cloudPrice, planTitle, tierPriceText } from './format';
import { StepCta, StepHeader } from './parts';

const RISK_TEXT = 'Entendo que operar envolve risco de perda, que resultados passados não garantem resultados futuros '
    + 'e que a cópia replica as operações do gestor na minha conta.';

// A choice and its price. On a phone the text takes the whole width and the price goes under it: side by side the
// text was squeezed into a column one word wide
function Row({ label, value, detail, aside, onEdit }: { label: string; value: ReactNode; detail?: ReactNode; aside?: ReactNode; onEdit?: () => void }) {
    return (
        <div className="flex flex-col gap-1.5 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{label}</p>
                <div className="font-semibold">{value}</div>
                {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
                {aside && <span className="text-sm font-semibold">{aside}</span>}
                {onEdit && <Button size="sm" variant="ghost" onClick={onEdit}>Alterar</Button>}
            </div>
        </div>
    );
}

// The confirmation the button needs. On a phone it rides in the fixed bar, right over the button it unlocks
function RiskAck({ checked, onChange, compact }: { checked: boolean; onChange: (v: boolean) => void; compact: boolean }) {
    return (
        <label className={cn('flex cursor-pointer items-start gap-3',
            compact ? 'text-xs leading-snug' : 'rounded-xl border border-border bg-card p-4 text-sm')}>
            <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
                className={cn('shrink-0 accent-[hsl(var(--primary))]', compact ? 'mt-0 size-5' : 'mt-0.5 size-5')} />
            <span>{RISK_TEXT}</span>
        </label>
    );
}

// Who else copies: only once the marketplace shows the followers' figures (enough of them)
function Copiers({ count }: { count: number | null }) {
    if (!count) return null;
    return (
        <span className="inline-flex items-center gap-1.5">
            <Users className="size-3.5" /> {count.toLocaleString('pt-BR')} {count === 1 ? 'conta copiou' : 'contas copiaram'} nos últimos 90 dias
        </span>
    );
}

export type SummaryProps = {
    listing: PublicListing;
    tier: SimulationStep;
    periodLabel: (days: number) => string;
    wantsHosting: boolean | null;
    copiers: number | null;
    risk: boolean;
    onRisk: (v: boolean) => void;
    busy: boolean;
    done: Subscription | null;
    onEdit: (step: 'contracts' | 'hosting') => void;
    onSubscribe: () => void;
    onRedeem: (code: string) => void;
};

export function PaySummary(p: SummaryProps) {
    const { listing, tier, periodLabel, wantsHosting } = p;
    const [codeOpen, setCodeOpen] = useState(false);
    const [code, setCode] = useState('');
    const offered = listing.hosting_allowed && listing.hosting_room === true;
    const cloud = offered && wantsHosting === true;
    const consult = tier.price == null;
    const ctaText = listing.pay_online ? 'Ir para o pagamento seguro'
        : listing.checkout_url ? 'Continuar para o pagamento do gestor' : 'Enviar pedido ao gestor';

    if (p.done) {
        return (
            <section className="panel space-y-4 p-5 text-center sm:p-8">
                <CheckCircle2 className="mx-auto size-12 text-success" />
                <h1 className="text-2xl font-bold">Pedido de assinatura enviado!</h1>
                <p className="mx-auto max-w-md text-sm text-muted-foreground">
                    {p.done.listing.checkout_url
                        ? 'Conclua o pagamento na página que abriu em outra aba. Assim que o gestor confirmar, a cópia aparece em Minhas cópias.'
                        : 'O gestor vai responder com as instruções de pagamento e liberar a sua cópia.'}
                </p>
                {p.done.listing.checkout_url && (
                    <a href={p.done.listing.checkout_url} target="_blank" rel="noopener noreferrer" className="block">
                        <Button size="lg" className="w-full">Abrir a página de pagamento</Button>
                    </a>
                )}
                <Link to="/client/licenses" className="block text-sm font-medium text-primary underline-offset-4 hover:underline">Ir para Minhas cópias</Link>
            </section>
        );
    }

    return (
        <section className="panel space-y-6 p-5 sm:p-8">
            <StepHeader title="Revise e confirme">
                Você vai copiar <strong className="text-foreground">{listing.title}</strong>.
            </StepHeader>

            <div className="divide-y divide-border rounded-2xl border border-border bg-secondary/20">
                <Row label="Plano" value={planTitle(tier)}
                    detail={`Capital sugerido: ${formatMoney(tier.recommended_capital, tier.currency)}`}
                    aside={tierPriceText(tier, periodLabel)} onEdit={() => p.onEdit('contracts')} />
                {offered && wantsHosting != null && (
                    <Row label="Onde a cópia roda"
                        value={<span className="flex items-center gap-1.5">{cloud ? <><Cloud className="size-4 text-primary" /> Na nuvem da Trademetric</> : <><Monitor className="size-4 text-muted-foreground" /> No meu computador ou VPS</>}</span>}
                        detail={cloud ? (listing.hosting_price ? CLOUD_BILLED_APART : 'Sem custo a mais') : 'Você instala o replicador depois de assinar'}
                        aside={cloud ? cloudPrice(listing.hosting_price) : 'Grátis'} onEdit={() => p.onEdit('hosting')} />
                )}
                {listing.hosting_allowed && !offered && (
                    <Row label="Onde a cópia roda" value="No meu computador ou VPS"
                        detail="A nuvem está sem vagas agora: você instala no seu computador e pode migrar quando abrir vaga." />
                )}
            </div>

            {/* The totals are in the order beside the steps on a wide screen; here only where that column is not */}
            <dl className="space-y-2 rounded-2xl border border-border p-4 text-sm lg:hidden">
                {consult ? (
                    <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Preço</dt><dd className="text-right">Sob consulta: o gestor responde com o valor</dd></div>
                ) : listing.pay_online ? (
                    <>
                        <div className="flex justify-between gap-3 text-base font-bold"><dt>Total hoje</dt><dd>{formatMoney(tier.price ?? 0, tier.currency)}</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Depois, a cada {periodLabel(tier.days)}</dt><dd>{formatMoney(tier.price ?? 0, tier.currency)}</dd></div>
                    </>
                ) : (
                    <div className="flex justify-between gap-3 text-base font-bold">
                        <dt>{listing.checkout_url ? 'Na página de pagamento do gestor' : 'Combinado com o gestor'}</dt>
                        <dd>{tierPriceText(tier, periodLabel)}</dd>
                    </div>
                )}
                {cloud && listing.hosting_price && (
                    <div className="flex justify-between gap-3 border-t border-border pt-2">
                        <dt className="text-muted-foreground">Nuvem, à parte</dt><dd>{hostingPriceLabel(listing.hosting_price)}</dd>
                    </div>
                )}
            </dl>
            {consult && <p className="hidden text-sm text-muted-foreground lg:block">Preço sob consulta: o gestor responde com o valor.</p>}

            {listing.pay_online && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CreditCard className="size-4 shrink-0" /> Pagamento com cartão de crédito, na página segura da Stripe.
                </p>
            )}

            <StepCta loading={p.busy} disabled={!p.risk} onClick={p.onSubscribe}
                above={compact => <RiskAck checked={p.risk} onChange={p.onRisk} compact={compact} />}
                note={<div className="space-y-1">
                    {listing.pay_online && <p>Renovação automática: cancele quando quiser em Minha conta → Assinaturas, sem multa.</p>}
                    {!listing.pay_online && listing.checkout_url && <p>O pagamento abre na página do gestor, em outra aba.</p>}
                    {!p.risk && <p className="hidden sm:block">Marque a confirmação acima para continuar.</p>}
                    <p className="lg:hidden"><Copiers count={p.copiers} /></p>
                </div>}>
                {ctaText} {!p.busy && <ArrowRight />}
            </StepCta>

            {listing.has_promo && (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
                    {codeOpen ? (
                        <form onSubmit={e => { e.preventDefault(); if (code.trim()) p.onRedeem(code.trim()); }} className="space-y-2" noValidate>
                            <label htmlFor="checkout-promo" className="flex items-center gap-2 text-sm font-semibold"><Ticket className="size-4 text-primary" /> Código de lançamento</label>
                            <div className="flex gap-2">
                                <Input id="checkout-promo" value={code} onChange={e => setCode(e.target.value)} placeholder="Digite seu código" className="font-mono uppercase" autoComplete="off" />
                                <Button type="submit" variant="outline" loading={p.busy} disabled={!code.trim() || !p.risk}>Usar</Button>
                            </div>
                            {!p.risk && <p className="text-xs text-muted-foreground">Marque a confirmação de risco para usar o código.</p>}
                        </form>
                    ) : (
                        <button type="button" onClick={() => setCodeOpen(true)} className="flex min-h-11 w-full items-center justify-center gap-2 text-sm font-medium text-primary hover:underline">
                            <Ticket className="size-4" /> Tenho um código de lançamento
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}

// The launch code's way: no plan to pick, no card. Its free days start when the MT5 account is connected
export function PromoSummary({ listing, code, onCode, email, unverified, risk, onRisk, busy, onRedeem, onPreferPay }: {
    listing: PublicListing; code: string; onCode: (v: string) => void; email: string | null; unverified: boolean;
    risk: boolean; onRisk: (v: boolean) => void; busy: boolean; onRedeem: () => void; onPreferPay: () => void;
}) {
    return (
        <section className="panel space-y-6 p-5 sm:p-8">
            <StepHeader title={`Ative seu acesso grátis a ${listing.title}`}>
                Sem cartão. Os dias grátis começam quando você conectar sua conta MT5.
            </StepHeader>

            <div className="mx-auto max-w-md space-y-2">
                <label htmlFor="promo-code" className="text-sm font-medium">Código de lançamento</label>
                <Input id="promo-code" value={code} onChange={e => onCode(e.target.value)} className="h-12 font-mono text-base uppercase" autoComplete="off" />
            </div>

            {unverified && (
                <div role="status" className="mx-auto max-w-md space-y-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
                    <p className="flex items-start gap-2"><MailCheck className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span>Enviamos um link para <strong>{email}</strong>. Confirme o email e volte aqui: o botão se libera sozinho.</span></p>
                    <ResendLinkButton />
                </div>
            )}

            <StepCta loading={busy} disabled={!risk || unverified || !code.trim()} onClick={onRedeem}
                above={compact => <RiskAck checked={risk} onChange={onRisk} compact={compact} />}
                note={<button type="button" onClick={onPreferPay} className="min-h-9 font-medium text-primary underline-offset-4 hover:underline">Prefiro assinar agora</button>}>
                Ativar meu acesso grátis {!busy && <ArrowRight />}
            </StepCta>
        </section>
    );
}
