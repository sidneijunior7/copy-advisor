import { type ReactNode, useState } from 'react';
import { CreditCard, RotateCcw, Server, X } from 'lucide-react';
import { toast } from 'sonner';
import api, { type HostingBilling as Billing, type HostingPrice } from '../../api';
import Card from '../Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { hostingPriceLabel } from '../../lib/money';
import { openBillingPortal, openHostingCheckout } from '../../lib/stripe';
import { apiError, formatDate } from '../../lib/utils';

// The hosting of a license paid in Stripe, apart from the portfolio's subscription: paying, cancelling or resuming
// the renewal. Nothing to show for an exempt terminal
export function HostingBillingBody({ licenseId, billing, price, onChanged }: {
    licenseId: number; billing: Billing; price: HostingPrice | null; onChanged: () => void;
}) {
    const [confirming, setConfirming] = useState(false); // The cancellation waits on a second click
    const [busy, setBusy] = useState(false);
    if (billing.exempt) return null;
    const until = billing.period_end ? formatDate(billing.period_end) : null;

    const renewal = async (renew: boolean) => {
        setBusy(true);
        try {
            await api.post(`/me/licenses/${licenseId}/hosting/renewal`, { renew });
            toast.success(renew ? 'A hospedagem volta a renovar' : 'Hospedagem cancelada');
            setConfirming(false);
            onChanged();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, renew ? 'Não foi possível retomar a hospedagem.' : 'Não foi possível cancelar a hospedagem.'));
        } finally {
            setBusy(false);
        }
    };

    const pay = async () => {
        setBusy(true);
        await openHostingCheckout(licenseId);
        setBusy(false);
    };

    const status = !billing.renewing
        ? billing.paid
            ? { variant: 'warning' as const, label: 'Cancelada', text: `O terminal roda até ${until ?? 'o fim do período pago'}.` }
            : billing.status
                ? { variant: 'destructive' as const, label: 'Encerrada', text: 'A hospedagem terminou e o terminal foi desligado. Servidor e senha ficam guardados: assine de novo para voltar a copiar.' }
                : { variant: 'warning' as const, label: 'Aguardando pagamento', text: 'O terminal liga assim que o pagamento passar.' }
        : billing.status === 'past_due'
            ? { variant: 'destructive' as const, label: 'Cobrança falhou', text: 'A última cobrança não passou. Atualize o cartão: o terminal desliga 2 dias depois do fim do período pago.' }
            : billing.cancel_at_period_end
                ? { variant: 'warning' as const, label: 'Cancelada', text: `Não renova mais. O terminal roda até ${until ?? 'o fim do período pago'} e depois desliga.` }
                : { variant: 'success' as const, label: 'Ativa', text: `Renova sozinha em ${until ?? 'breve'}, no cartão.` };

    return (
        <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <p className="font-medium">Hospedagem em nuvem</p>
                    {price && <p className="text-xs text-muted-foreground">{hostingPriceLabel(price)}</p>}
                </div>
                <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            <p className="text-muted-foreground">{status.text}</p>
            <div className="flex flex-wrap items-center gap-2">
                {!billing.renewing && (
                    <Button size="sm" loading={busy} onClick={pay}>
                        {!busy && <CreditCard />} {billing.status ? 'Assinar de novo' : 'Pagar a hospedagem'}
                    </Button>
                )}
                {billing.status && <Button size="sm" variant="outline" onClick={openBillingPortal}><CreditCard /> Cartão e faturas</Button>}
                {billing.renewing && billing.cancel_at_period_end && (
                    <Button size="sm" variant="outline" loading={busy} onClick={() => renewal(true)}>
                        {!busy && <RotateCcw />} Retomar a renovação
                    </Button>
                )}
                {billing.renewing && !billing.cancel_at_period_end && !confirming && (
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}><X /> Cancelar a hospedagem</Button>
                )}
            </div>
            {confirming && (
                <div role="alert" className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                    <p>Cancelar a renovação da hospedagem? Nada mais é cobrado, e o terminal continua copiando até {until ?? 'o fim do período pago'}. A assinatura do portfólio não muda.</p>
                    <div className="flex gap-2">
                        <Button size="sm" variant="destructive" loading={busy} onClick={() => renewal(false)}>Cancelar a renovação</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Voltar</Button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function HostingBillingCard({ title, description, action, ...body }: Parameters<typeof HostingBillingBody>[0] & {
    title: string; description?: string; action?: ReactNode;
}) {
    return (
        <Card title={title} description={description} action={action} icon={<Server />}>
            <HostingBillingBody {...body} />
        </Card>
    );
}
