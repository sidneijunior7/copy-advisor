// Words the dashboard shows for codes the API sends
import type { HostingState } from '../api';
import type { BadgeProps } from '../components/ui/Badge';

export const HOSTING_STATES: Record<HostingState, { label: string; variant: BadgeProps['variant'] }> = {
    pending: { label: 'Na fila', variant: 'muted' },
    starting: { label: 'Iniciando', variant: 'primary' },
    running: { label: 'Copiando', variant: 'success' },
    login_failed: { label: 'Login recusado', variant: 'destructive' },
    key_refused: { label: 'Chave recusada', variant: 'destructive' },
    error: { label: 'Erro', variant: 'destructive' },
    restarting: { label: 'Reiniciando', variant: 'warning' },
    stopped: { label: 'Parado', variant: 'muted' },
    disabled: { label: 'Desligado', variant: 'muted' },
    pod_offline: { label: 'Pod fora do ar', variant: 'destructive' },
};

export const LOT_LIMIT = 10034; // TRADE_RETCODE_LIMIT_VOLUME: what the license's lot limit held back

// MT5 TRADE_RETCODE_* a Slave reports when a copy did not go through
export const REASONS: Record<number, string> = {
    [LOT_LIMIT]: 'Limite de lotes da licença',
    10019: 'Margem insuficiente',
    10018: 'Mercado fechado',
    10017: 'Negociação desabilitada no ativo',
    10027: 'AutoTrading desligado no terminal',
    10031: 'Sem conexão com a corretora',
    10014: 'Volume inválido para o ativo',
    10016: 'SL/TP inválidos',
    10030: 'Tipo de preenchimento recusado',
    10021: 'Sem cotação',
    10024: 'Ordens demais em pouco tempo',
    10040: 'Limite de posições da conta',
    10006: 'Recusada pela corretora',
    10004: 'Requote',
};

export const ACTIONS: Record<string, string> = {
    OPEN: 'Abertura',
    ADD: 'Aumento',
    PARTIAL: 'Parcial',
    CLOSE: 'Fechamento',
    REVERSE: 'Reversão',
    MODIFY: 'SL/TP',
};

export const SIZING_LABELS = {
    factor: 'Fator fixo sobre o lote do Master',
    balance: 'Proporcional ao saldo',
    equity: 'Proporcional ao patrimônio',
} as const;

export const SLTP_LABELS = {
    distance: 'Mesma distância da entrada',
    price: 'Mesmo preço do Master',
} as const;

export const PERIODS = [
    { days: 30, label: 'Últimos 30 dias' },
    { days: 90, label: 'Últimos 90 dias' },
    { days: 180, label: 'Últimos 6 meses' },
    { days: 365, label: 'Último ano' },
];
