import type { ClientLicense, MyLicenses } from '../api';
import type { BadgeProps } from '../components/ui/Badge';
import { HOSTING_STATES } from './labels';
import { formatDate, parseUtc } from './utils';

export type CopyState = { label: string; variant: BadgeProps['variant']; detail: string | null };

// One answer to "is my account copying?", from the license, the terminal we host and the hub
export const copyState = (l: ClientLicense): CopyState => {
    if (!l.is_active) {
        return { label: 'Revogada', variant: 'muted', detail: 'Não abre posições novas; as abertas seguem o Master até fechar.' };
    }
    if (l.is_paused) {
        return { label: 'Pausado', variant: 'warning', detail: 'Cópia pausada por você. Não abre posições novas; as abertas seguem o Master até fechar.' };
    }
    if (l.mt5_login == null) {
        return {
            label: 'Conecte sua conta',
            variant: 'warning',
            detail: l.promo
                ? `Seus ${l.promo.free_days} dias grátis começam quando você informar a conta MT5 que vai copiar.`
                : 'Informe a conta MT5 que vai copiar para começar.',
        };
    }
    if (!l.valid) {
        return { label: 'Vencida', variant: 'warning', detail: 'Renove para voltar a copiar. As posições abertas seguem o Master até fechar.' };
    }
    if (needsSetup(l)) {
        return { label: 'Falta ativar', variant: 'warning', detail: 'Escolha como copiar: na nossa nuvem ou no seu computador.' };
    }
    if (l.hosting) {
        const { label, variant } = HOSTING_STATES[l.hosting.state] ?? { label: l.hosting.state, variant: 'muted' };
        return { label, variant, detail: l.hosting.detail };
    }
    if (l.connection) {
        return { label: 'Copiando', variant: 'success', detail: l.connection.ea_version ? `EA ${l.connection.ea_version} conectado` : null };
    }
    return {
        label: 'Desconectado',
        variant: 'warning',
        detail: 'Nenhum EA conectado com esta licença. Abra o MetaTrader com o EA, ou hospede a conta com a gente.',
    };
};

export const formatPrice = (value: number) =>
    Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 5 });

// The licenses the hosting offer is for: valid, with their MT5 account, already copying from the client's own
// computer. One still being set up chooses between the cloud and the computer in the activation instead
export const hostingCandidates = (data: MyLicenses | null): ClientLicense[] =>
    data?.hosting_available && data.hosting_room && data.hosting_price
        ? data.licenses.filter(l => !l.hosting && l.valid && l.mt5_login != null && !needsSetup(l))
        : [];

// Paid but not set up yet: no account, no way of copying chosen, or a hosting never paid. The license page shows
// the activation. Without an account, even past its date: connecting it is the way on (and starts a launch code's
// free days)
export const needsSetup = (l: ClientLicense) =>
    l.is_active && (l.mt5_login == null || (l.valid && ((!l.hosting && !l.has_key && !l.connection)
        || (l.hosting != null && !l.hosting.billing.paid && l.hosting.billing.status == null))));

// Still on a launch code's free days: they started, and the license was not renewed past them
export const onFreeDays = (l: ClientLicense) =>
    l.promo?.ends_at != null && l.expires_at != null && parseUtc(l.expires_at).getTime() <= parseUtc(l.promo.ends_at).getTime() + 60_000;

export const validityLabel = (l: ClientLicense) => {
    if (l.promo && !l.promo.started_at) return `${l.promo.free_days} dias grátis, a partir da conexão da conta`;
    if (!l.expires_at) return 'Sem validade';
    return onFreeDays(l) ? `Grátis até ${formatDate(l.expires_at)}` : formatDate(l.expires_at);
};

export type NextStep = { title: string; detail: string; action: string; tone: 'warning' | 'destructive' };

// What the client has to do for the license to copy, or null when it copies (or is paused on purpose)
export const nextStep = (l: ClientLicense): NextStep | null => {
    if (!l.is_active) return null;
    if (l.mt5_login == null) {
        return { title: 'Conecte sua conta da corretora', detail: 'Falta informar a conta MT5 que vai receber as cópias.', action: 'Conectar', tone: 'warning' };
    }
    if (!l.valid) {
        return { title: 'Assinatura vencida', detail: 'Renove para voltar a copiar.', action: 'Renovar', tone: 'destructive' };
    }
    if (l.is_paused) return null;
    if (l.hosting) {
        if (!l.hosting.billing.paid) {
            return { title: 'Pagamento da hospedagem pendente', detail: 'O terminal liga assim que o pagamento passar.', action: 'Pagar', tone: 'warning' };
        }
        if (['login_failed', 'key_refused', 'error', 'pod_offline'].includes(l.hosting.state)) {
            return { title: 'A cópia na nuvem parou', detail: l.hosting.detail ?? 'Confira o servidor e a senha da conta.', action: 'Resolver', tone: 'destructive' };
        }
        return null;
    }
    if (!l.has_key && !l.connection) {
        return { title: 'Escolha como copiar', detail: 'Na nossa nuvem, sem instalar nada, ou com o EA no seu computador.', action: 'Escolher', tone: 'warning' };
    }
    if (!l.connection) {
        return {
            title: 'O EA do seu computador está desconectado',
            detail: 'Com o MetaTrader fechado, as operações do gestor não chegam à sua conta.',
            action: 'Ver como resolver',
            tone: 'warning',
        };
    }
    return null;
};
