import { useState } from 'react';
import { AlertTriangle, ArrowRight, ChevronDown, Cloud, Wrench } from 'lucide-react';
import type { HostingPrice } from '../../../api';
import { Badge } from '../../../components/ui/Badge';
import { formatMoney, periodLabel } from '../../../lib/money';
import { CLOUD_BILLED_APART, radioKeys } from './format';
import { ChoiceCard, Step, StepCta, StepHeader } from './parts';

const MANUAL_INSTALL_STEPS = [
    'Instalar o MetaTrader 5 no seu computador ou numa VPS Windows',
    'Baixar o replicador da Trademetric e copiar para a pasta de dados do MT5',
    'Liberar o WebRequest e a negociação algorítmica no terminal',
    'Colar a sua chave de licença no replicador',
    'Conferir se a cópia está conectada',
    'Manter o computador ou a VPS ligados durante todo o pregão',
];

// Nothing comes chosen: the client picks how the copy runs. Both cards are short and the same height, so on a
// phone the two fit on the first screen and neither looks like the wrong one
export default function HostingStep({ value, onChange, price, onContinue }: {
    value: boolean | null; onChange: (wants: boolean) => void; price: HostingPrice | null | undefined; onContinue: () => void;
}) {
    const [showSteps, setShowSteps] = useState(false);
    const stepsOpen = showSteps || value === false;
    return (
        <Step>
            <StepHeader title="Onde a sua cópia vai rodar?">
                O MetaTrader 5 precisa ficar aberto para copiar as operações.
            </StepHeader>

            <div role="radiogroup" aria-label="Onde a cópia vai rodar" onKeyDown={radioKeys} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ChoiceCard selected={value === true} onSelect={() => onChange(true)} tabbable={value !== false} className="h-full">
                    <span className="pr-7"><Badge variant="primary"><Cloud className="size-3" /> Recomendado</Badge></span>
                    <span className="block">
                        <span className="block text-lg font-bold">Na nuvem da Trademetric</span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">
                            Rodamos o MetaTrader 5 para você, com o seu computador desligado. Nada para instalar.
                        </span>
                    </span>
                    <span className="mt-auto block pt-1">
                        {price ? (
                            <>
                                <span className="text-xl font-bold">+ {formatMoney(price.price, price.currency)}</span>
                                <span className="text-sm text-muted-foreground"> /{periodLabel(price.days)}</span>
                                <span className="block text-xs text-muted-foreground">{CLOUD_BILLED_APART}</span>
                            </>
                        ) : <span className="text-xl font-bold">Incluída no plano</span>}
                    </span>
                </ChoiceCard>

                <ChoiceCard selected={value === false} onSelect={() => onChange(false)} tabbable={value === false} className="h-full">
                    <span className="pr-7"><Badge variant="muted"><Wrench className="size-3" /> Instalação própria</Badge></span>
                    <span className="block">
                        <span className="block text-lg font-bold">No meu computador ou VPS</span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">
                            Você instala o replicador e deixa o MetaTrader aberto durante o pregão.
                        </span>
                    </span>
                    <span className="mt-auto block pt-1 text-xl font-bold">Grátis</span>
                </ChoiceCard>
            </div>

            <div>
                <button type="button" onClick={() => setShowSteps(v => !v)} aria-expanded={stepsOpen}
                    className="inline-flex min-h-11 items-center gap-2 text-left text-sm font-medium text-muted-foreground hover:text-foreground">
                    O que a instalação própria exige? (6 passos)
                    <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${stepsOpen ? 'rotate-180' : ''}`} />
                </button>
                {stepsOpen && (
                    <ol className="space-y-1.5 pt-1 text-sm text-muted-foreground sm:columns-2 sm:gap-8">
                        {MANUAL_INSTALL_STEPS.map((item, i) => (
                            <li key={item} className="flex items-start gap-2.5">
                                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-[11px] font-bold text-foreground">{i + 1}</span>
                                {item}
                            </li>
                        ))}
                    </ol>
                )}
            </div>

            {value === false && (
                <p className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 p-4 text-xs text-foreground sm:text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                    Se o computador desligar, hibernar ou perder a internet com uma operação aberta, a sua conta não recebe a saída do trader.
                    Dá para mudar para a nuvem depois.
                </p>
            )}

            <StepCta disabled={value === null} onClick={onContinue}
                note={value === null ? 'Escolha uma das opções para continuar.' : undefined}>
                {value === null ? 'Continuar' : value ? 'Continuar com a nuvem' : 'Continuar com a instalação própria'} <ArrowRight />
            </StepCta>
        </Step>
    );
}
