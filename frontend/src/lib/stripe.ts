import { toast } from 'sonner';
import api from '../api';
import { apiError } from './utils';

// Stripe's own pages: the Checkout of a pending request, and the card and invoices
export async function openCheckout(subscriptionId: number) {
    try {
        const res = await api.post<{ url: string }>(`/me/subscriptions/${subscriptionId}/checkout`);
        window.location.assign(res.data.url);
    } catch (e) {
        console.error(e);
        toast.error(apiError(e, 'Não foi possível abrir o pagamento.'));
    }
}

export async function openBillingPortal() {
    try {
        const res = await api.post<{ url: string }>('/me/billing/portal');
        window.location.assign(res.data.url);
    } catch (e) {
        console.error(e);
        toast.error(apiError(e, 'Não foi possível abrir a página de pagamentos.'));
    }
}
