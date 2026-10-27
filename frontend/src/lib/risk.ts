import type { BadgeProps } from '../components/ui/Badge';

export type Risk = { label: string; variant: BadgeProps['variant']; hint: string };

// A newcomer reads the biggest fall better as a word. Bands on the max drawdown of the period, in %
export const riskOf = (maxDrawdownPct: number | null): Risk | null => {
    if (maxDrawdownPct == null) return null;
    if (maxDrawdownPct <= 10) return { label: 'Conservador', variant: 'success', hint: 'A conta do gestor caiu até 10% do topo no período' };
    if (maxDrawdownPct <= 25) return { label: 'Moderado', variant: 'warning', hint: 'A conta do gestor caiu entre 10% e 25% do topo no período' };
    return { label: 'Arrojado', variant: 'destructive', hint: 'A conta do gestor caiu mais de 25% do topo no período' };
};
