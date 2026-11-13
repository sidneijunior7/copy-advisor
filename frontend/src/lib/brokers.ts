import type { BrokerChoice } from '../api';

// The B3 brokers with MetaTrader 5 the clients use the most. Shown only for a portfolio that trades on the B3: a
// Forex or crypto portfolio runs on other brokers, which the client names in "other"
export const B3_BROKERS: { id: BrokerChoice; name: string }[] = [
    { id: 'XP', name: 'XP Investimentos' },
    { id: 'Clear', name: 'Clear Corretora' },
    { id: 'Rico', name: 'Rico' },
    { id: 'Genial', name: 'Genial Investimentos' },
];

export const brokerLabel = (broker: BrokerChoice | null | undefined, other?: string | null) =>
    broker === 'other' ? `Outra: ${other?.trim() || 'não informada'}`
        : broker === 'none' ? 'Ainda não tem conta'
            : B3_BROKERS.find(b => b.id === broker)?.name ?? broker ?? 'Não informada';
