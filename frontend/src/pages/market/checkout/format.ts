import type { KeyboardEvent } from 'react';
import type { HostingPrice, SimulationStep } from '../../../api';
import { formatMoney, hostingPriceLabel } from '../../../lib/money';

export type Unit = 'contrato' | 'lote';

// B3 trades contracts; Forex, crypto and the others trade lots
export const unitOf = (markets: string[]): Unit => (markets.length === 0 || markets.includes('B3') ? 'contrato' : 'lote');

export const lotsLabel = (lots: number, unit: Unit = 'contrato') => `${lots.toLocaleString('pt-BR')} ${unit}${lots === 1 ? '' : 's'}`;

// A plan's name already saying how many contracts ("Até 2 contratos", "3 lotes") stands alone; any other name goes
// after the contracts, so "2 contratos (Até 2 contratos)" never shows
export const planTitle = (t: SimulationStep) => {
    const lots = lotsLabel(t.lots, t.unit);
    const name = t.name?.trim();
    // A generated name ("2 contratos", for a portfolio without plans) follows the market's unit
    if (!name || name === lots || /^\d+([.,]\d+)?\s+(contratos?|lotes?)$/i.test(name)) return lots;
    const count = new RegExp(`(^|\\D)${t.lots.toLocaleString('pt-BR')}(\\D|$)`);
    return count.test(name) && /contrato|lote/i.test(name) ? name : `${lots} (${name})`;
};

// The simulator's period in words: 180 days read as 6 months
export const periodWords = (days: number) =>
    days % 30 === 0 ? `${days / 30} ${days / 30 === 1 ? 'mês' : 'meses'}` : `${days} dias`;

export const tierPriceText = (t: SimulationStep, period: (days: number) => string) =>
    t.price == null ? 'Sob consulta' : t.price === 0 ? 'Gratuito' : `${formatMoney(t.price, t.currency)} / ${period(t.days)}`;

// "R$ X por contrato" sells the bigger plans only when each step up really costs less per contract; otherwise it
// points at the plan that costs more
export const perContractFalls = (steps: SimulationStep[]) => {
    const priced = steps.filter(s => s.price != null && s.price > 0 && s.lots > 0).sort((a, b) => a.lots - b.lots);
    if (priced.length < 2) return false;
    return priced.every((s, i) => i === 0 || s.price! / s.lots < priced[i - 1].price! / priced[i - 1].lots);
};

// What the cloud costs, said the same way in its step, the order and the summary: charged apart, or included
export const cloudPrice = (price: HostingPrice | null | undefined) => (price ? hostingPriceLabel(price) : 'Incluída');
export const CLOUD_BILLED_APART = 'Cobrada à parte, ao conectar sua conta MT5';

// Whole units typed the Brazilian way: 5.000 or 5000; cents are ignored
export const parseCapital = (text: string) => Number(text.split(',')[0].replace(/\D/g, ''));
export const maskCapital = (text: string) => {
    const n = parseCapital(text);
    return n > 0 ? n.toLocaleString('pt-BR') : '';
};

// Signed money as one text node: the sign never wraps away from the number
export const signedMoney = (value: number, currency: string) =>
    `${value > 0 ? '+' : value < 0 ? '−' : ''} ${formatMoney(Math.abs(value), currency)}`;

export const initials = (name: string) =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join('') || '?';

// Arrow keys move the choice inside a radiogroup, as with native radio buttons
export function radioKeys(e: KeyboardEvent<HTMLElement>) {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
    if (!keys.includes(e.key)) return;
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
    const at = radios.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const next = radios[(at + step + radios.length) % radios.length];
    next.focus();
    next.click();
}
