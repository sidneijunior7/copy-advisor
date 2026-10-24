import { type ReactNode, useState } from 'react';
import { CreditCard, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import api, { type Billing, type Subscription } from '../../api';
import Card from '../Card';
import PlanPicker from '../PlanPicker';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatMoney, periodLabel } from '../../lib/money';
import { openBillingPortal } from '../../lib/stripe';
import { apiError, formatDate } from '../../lib/utils';

// A license paid in Stripe, managed from here: the plan, cancelling or resuming the renewal. The card and the
// invoices are on Stripe's own page
export default function BillingCard({ billing, onChanged, title = 'Assinatura', description, action }: {
    billing: Billing; onChanged: () => void; title?: string; description?: string; action?: ReactNode;
}) {
    const [planId, setPlanId] = useState<number | null>(billing.plan?.id ?? null);
    const [confirming, setConfirming] = useState(false); // The cancellation waits on a second click
    const [busy, setBusy] = useState(false);
    const until = billing.period_end ? formatDate(billing.period_end) : null;
    const chosen = billing.plans.find(p => p.id === planId);
    const changing = chosen != null && chosen.id !== billing.plan?.id;

    const call = async (path: string, body: object, done: string, fallback: string) => {
        setBusy(true);
        try {
            await api.post<Subscription>(`/me/subscriptions/${billing.subscription_id}/${path}`, body);
            toast.success(done);
            setConfirming(false);
            onChanged();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, fallback));
            onChanged(); // A declined charge still says how things stand
        } finally {
            setBusy(false);
        }
    };

    const status = billing.status === 'past_due'
        ? { variant: 'destructive' as const, label: 'Cobrança falhou', text: 'A última cobrança não passou. Atualize o cartão em Pagamentos: a Stripe tenta de novo nos próximos dias.' }
        : billing.cancel_at_period_end
            ? { variant: 'warning' as const, label: 'Cancelada', text: `Não renova mais. A licença vale até ${until ?? 'o fim do período pago'}.` }
            : billing.status === 'trialing'
                ? { variant: 'success' as const, label: 'Ativa', text: `A primeira cobrança é em ${until ?? 'breve'}, quando termina a validade atual.` }
                : { variant: 'success' as const, label: 'Ativa', text: `Renova sozinha em ${until ?? 'breve'}, no cartão.` };

    return (
        <Card title={title} description={description} action={action} icon={<CreditCard />}>
            <div className="space-y-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <p className="font-medium">{billing.plan?.name ?? 'Plano'}</p>
                        {billing.plan && (
                            <p className="text-xs text-muted-foreground">
                                {formatMoney(billing.plan.price, billing.plan.currency)} / {periodLabel(billing.plan.days)} · limite de {billing.plan.max_lots.toLocaleString('pt-BR')} lotes
                            </p>
                        )}
                    </div>
                    <Badge variant={status.variant}>{status.label}</Badge>
                </div>
                <p className="text-muted-foreground">{status.text}</p>

                {billing.renewing && !billing.cancel_at_period_end && billing.plans.length > 1 && (
                    <div className="space-y-2 border-t border-border pt-4">
                        <PlanPicker plans={billing.plans} value={planId} onChange={setPlanId} name={`plano-${billing.subscription_id}`} />
                        {changing && (
                            <div className="space-y-2">
                                <p className="text-xs text-muted-foreground">
                                    A diferença proporcional até {until ?? 'a próxima cobrança'} é {chosen.price > (billing.plan?.price ?? 0) ? 'cobrada agora no cartão' : 'creditada nas próximas cobranças'}.
                                    O limite de lotes muda assim que a Stripe confirmar.
                                </p>
                                <Button size="sm" loading={busy} disabled={billing.status === 'past_due'}
                                    onClick={() => call('plan', { plan_id: chosen.id }, `Plano trocado para ${chosen.name}`, 'Não foi possível trocar de plano.')}>
                                    Trocar para {chosen.name}
                                </Button>
                            </div>
                        )}
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <Button size="sm" variant="outline" onClick={openBillingPortal}><CreditCard /> Cartão e faturas</Button>
                    {billing.renewing && billing.cancel_at_period_end && (
                        <Button size="sm" variant="outline" loading={busy}
                            onClick={() => call('renewal', { renew: true }, 'A assinatura volta a renovar', 'Não foi possível retomar a assinatura.')}>
                            {!busy && <RotateCcw />} Retomar a renovação
                        </Button>
                    )}
                    {billing.renewing && !billing.cancel_at_period_end && !confirming && (
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}><X /> Cancelar a assinatura</Button>
                    )}
                </div>
                {confirming && (
                    <div role="alert" className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                        <p>Cancelar a renovação? Nada mais é cobrado, e a licença continua copiando até {until ?? 'o fim do período pago'}.</p>
                        <div className="flex gap-2">
                            <Button size="sm" variant="destructive" loading={busy}
                                onClick={() => call('renewal', { renew: false }, 'Assinatura cancelada', 'Não foi possível cancelar a assinatura.')}>
                                Cancelar a renovação
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Voltar</Button>
                        </div>
                    </div>
                )}
            </div>
        </Card>
    );
}
