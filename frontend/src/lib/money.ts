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

// What a listing costs, per period of validity
export const priceLabel = (l: { price: number | null; currency: string; default_days: number }) =>
    l.price == null ? 'Preço sob consulta' : l.price === 0 ? 'Gratuito' : `${formatMoney(l.price, l.currency)} / ${l.default_days} dias`;
