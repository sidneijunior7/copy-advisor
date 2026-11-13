import { AlertTriangle, ArrowRight, CheckCircle2, Cloud, Wrench } from 'lucide-react';
import type { HostingPrice } from '../../../api';
import { Badge } from '../../../components/ui/Badge';
import { CLOUD_BILLED_APART, cloudPrice, radioKeys } from './format';
import { ChoiceCard, StepCta, StepHeader } from './parts';

const MANUAL_INSTALL_STEPS = [
    'Instalar o MetaTrader 5 no seu computador ou numa VPS Windows',
    'Baixar o replicador da Trademetric e copiar para a pasta de dados do MT5',
    'Liberar o WebRequest e a negociação algorítmica no terminal',
    'Colar a sua chave de licença no replicador',
    'Conferir se a cópia está conectada',
    'Manter o computador ou a VPS ligados durante todo o pregão',
];

// Nothing comes chosen: the client picks how the copy runs, and both options look alike until then
export default function HostingStep({ value, onChange, price, onContinue }: {
    value: boolean | null; onChange: (wants: boolean) => void; price: HostingPrice | null | undefined; onContinue: () => void;
}) {
    return (
        <section className="panel space-y-6 p-5 sm:p-8">
            <StepHeader badge="Como rodar" icon={<Cloud className="size-3" />} title="Onde a sua cópia vai rodar?">
                O MetaTrader 5 precisa ficar aberto para copiar. Escolha se ele roda na nossa nuvem ou no seu computador.
            </StepHeader>

            <div role="radiogroup" aria-label="Onde a cópia vai rodar" onKeyDown={radioKeys} className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <ChoiceCard selected={value === true} onSelect={() => onChange(true)} tabbable={value !== false}>
                    <div className="flex flex-wrap items-center gap-2 pr-7">
                        <Badge variant="primary"><Cloud className="size-3" /> Recomendado</Badge>
                        <Badge variant="muted">{cloudPrice(price)}</Badge>
                    </div>
                    <div>
                        <h2 className="text-lg font-bold">Na nuvem da Trademetric</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Rodamos o MetaTrader 5 e o replicador para você, com o seu computador desligado.
                        </p>
                    </div>
                    <ul className="space-y-2 text-sm">
                        {['Nada para instalar', 'Funciona com o seu computador desligado', 'Depois de assinar, você só informa o acesso da conta MT5'].map(item => (
                            <li key={item} className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> {item}</li>
                        ))}
                    </ul>
                    {price && <p className="text-xs text-muted-foreground">{CLOUD_BILLED_APART}.</p>}
                </ChoiceCard>

                <ChoiceCard selected={value === false} onSelect={() => onChange(false)} tabbable={value === false}>
                    <div className="flex flex-wrap items-center gap-2 pr-7">
                        <Badge variant="muted"><Wrench className="size-3" /> Instalação própria</Badge>
                        <Badge variant="muted">Grátis</Badge>
                    </div>
                    <div>
                        <h2 className="text-lg font-bold">No meu computador ou VPS</h2>
                        <p className="mt-1 text-sm text-muted-foreground">Você instala e mantém o replicador. Os passos:</p>
                    </div>
                    <ol className="space-y-1.5 text-xs text-muted-foreground">
                        {MANUAL_INSTALL_STEPS.map((item, i) => (
                            <li key={item} className="flex items-start gap-2">
                                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-[10px] font-bold text-foreground">{i + 1}</span>
                                {item}
                            </li>
                        ))}
                    </ol>
                </ChoiceCard>
            </div>

            {value === false && (
                <p className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 p-4 text-xs text-foreground sm:text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                    Se o computador desligar, hibernar ou perder a internet com uma operação aberta, a sua conta não recebe a saída do gestor.
                    Dá para mudar para a nuvem depois.
                </p>
            )}

            <StepCta disabled={value === null} onClick={onContinue}
                note={value === null ? 'Escolha uma das opções para continuar.' : undefined}>
                {value === null ? 'Continuar' : value ? 'Continuar com a nuvem' : 'Continuar com a instalação própria'} <ArrowRight />
            </StepCta>
        </section>
    );
}
