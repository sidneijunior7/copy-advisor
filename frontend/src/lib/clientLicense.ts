import type { ClientLicense } from '../api';
import type { BadgeProps } from '../components/ui/Badge';
import { HOSTING_STATES } from './labels';

export type CopyState = { label: string; variant: BadgeProps['variant']; detail: string | null };

// One answer to "is my account copying?", from the license, the terminal we host and the hub
export const copyState = (l: ClientLicense): CopyState => {
    if (!l.is_active) {
        return { label: 'Revogada', variant: 'muted', detail: 'Não abre posições novas; as abertas seguem o Master até fechar.' };
    }
    if (!l.valid) {
        return { label: 'Vencida', variant: 'warning', detail: 'Renove para voltar a copiar. As posições abertas seguem o Master até fechar.' };
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
