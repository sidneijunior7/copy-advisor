import type { KeyboardEvent } from 'react';
import type { HostingPrice, SimulationStep } from '../../../api';
import { formatMoney, hostingPriceLabel } from '../../../lib/money';

export const lotsLabel = (lots: number) => `${lots.toLocaleString('pt-BR')} ${lots === 1 ? 'contrato' : 'contratos'}`;

// The simulator's period in words: 180 days read as 6 months
export const periodWords = (days: number) =>
    days % 30 === 0 ? `${days / 30} ${days / 30 === 1 ? 'mês' : 'meses'}` : `${days} dias`;

export const tierPriceText = (t: SimulationStep, period: (days: number) => string) =>
    t.price == null ? 'Sob consulta' : t.price === 0 ? 'Gratuito' : `${formatMoney(t.price, t.currency)} / ${period(t.days)}`;

// What the cloud costs, said the same way in its step and in the summary: charged apart, or included
export const cloudPrice = (price: HostingPrice | null | undefined) => (price ? hostingPriceLabel(price) : 'Incluída');
export const CLOUD_BILLED_APART = 'Cobrada à parte, quando você conectar sua conta MT5';

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
