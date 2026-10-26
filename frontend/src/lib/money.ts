// In the account's currency when it is a known code; a broker's own code (cent accounts) shows after the number
export const formatMoney = (value: number, currency: string | null) => {
    if (currency) {
        try {
            return value.toLocaleString('pt-BR', { style: 'currency', currency, maximumFractionDigits: 2 });
        } catch {
            return `${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
        }
    }
    return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// A period of validity in words: 30 days read as a month
export const periodLabel = (days: number) => (days === 30 ? 'mês' : days === 365 ? 'ano' : `${days} dias`);

// The platform's hosting price, per period
export const hostingPriceLabel = (p: { price: number; currency: string; days: number }) =>
    `${formatMoney(p.price, p.currency)} / ${periodLabel(p.days)}`;

// What a listing costs, per period of validity; with plans, from the cheapest
export const priceLabel = (l: { price: number | null; currency: string; default_days: number; plans?: unknown[] }) =>
    l.price == null ? 'Preço sob consulta' : l.price === 0 ? 'Gratuito'
        : `${(l.plans?.length ?? 0) > 1 ? 'A partir de ' : ''}${formatMoney(l.price, l.currency)} / ${periodLabel(l.default_days)}`;

// A percentage with its sign: +1,25% or -0,4%
export const signedPct = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
