import { useForm } from 'react-hook-form';
import { Check, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLicense, type ClientSettings } from '../../api';
import Card from '../Card';
import { Button } from '../ui/Button';
import { Field, Input, Select } from '../ui/Field';
import { SIZING_LABELS, SLTP_LABELS } from '../../lib/labels';
import { apiError } from '../../lib/utils';

type SettingsForm = {
    sizing_mode: ClientSettings['sizing_mode'];
    lots_factor: string;
    reference_capital: string;
    sltp_mode: ClientSettings['sltp_mode'];
    symbol_map: string;
    suffix_map: string;
};

interface ClientSettingsFormProps {
    license: ClientLicense;
    onSaved: () => void;
}

// How the copies enter the client's account, inside the limits of the portfolio
export default function ClientSettingsForm({ license, onSaved }: ClientSettingsFormProps) {
    const { limits, settings } = license;
    const fits = <T,>(value: T | null, allowed: T[]) => (value != null && allowed.includes(value) ? value : allowed[0]);
    const { register, handleSubmit, watch, formState: { errors, isSubmitting, isDirty } } = useForm<SettingsForm>({
        defaultValues: {
            sizing_mode: fits(settings.sizing_mode, limits.sizing_modes),
            lots_factor: String(Math.min(Math.max(settings.lots_factor ?? 1, limits.factor_min), limits.factor_max)),
            reference_capital: settings.reference_capital != null ? String(settings.reference_capital) : '10000',
            sltp_mode: fits(settings.sltp_mode, limits.sltp_modes),
            symbol_map: settings.symbol_map ?? '',
            suffix_map: settings.suffix_map ?? '',
        },
    });
    const sizing = watch('sizing_mode');

    const save = async (data: SettingsForm) => {
        try {
            await api.put(`/me/licenses/${license.id}/settings`, {
                sizing_mode: data.sizing_mode,
                lots_factor: parseFloat(data.lots_factor),
                reference_capital: data.sizing_mode === 'factor' ? null : parseFloat(data.reference_capital),
                sltp_mode: data.sltp_mode,
                symbol_map: data.symbol_map.trim() || null,
                suffix_map: data.suffix_map.trim() || null,
            });
            toast.success('Ajustes salvos', {
                description: license.hosting ? 'O terminal reinicia com eles em instantes.' : undefined,
            });
            onSaved();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível salvar os ajustes.'));
        }
    };

    return (
        <Card
            title="Ajustes da cópia"
            description={`Dentro dos limites do portfólio: fator de ${limits.factor_min.toLocaleString('pt-BR')} a ${limits.factor_max.toLocaleString('pt-BR')}. O limite de ${license.max_lots.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} lotes da licença vale para a soma das cópias abertas.`}
            icon={<SlidersHorizontal />}
        >
            <form onSubmit={handleSubmit(save)} className="space-y-5" noValidate>
                <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                    <Field label="Tamanho das posições" htmlFor="sizing">
                        <Select {...register('sizing_mode')} id="sizing">
                            {limits.sizing_modes.map(m => <option key={m} value={m}>{SIZING_LABELS[m]}</option>)}
                        </Select>
                    </Field>
                    <Field
                        label="Fator"
                        htmlFor="factor"
                        error={errors.lots_factor?.message}
                        hint={sizing === 'factor' ? 'Lote do Master × fator. Ex.: 0,5 copia metade.' : 'Multiplica a proporção do seu capital.'}
                    >
                        <Input
                            {...register('lots_factor', {
                                validate: v => {
                                    const n = parseFloat(v);
                                    return (n >= limits.factor_min && n <= limits.factor_max)
                                        || `Entre ${limits.factor_min.toLocaleString('pt-BR')} e ${limits.factor_max.toLocaleString('pt-BR')}`;
                                },
                            })}
                            id="factor"
                            type="number"
                            step="0.01"
                            min={limits.factor_min}
                            max={limits.factor_max}
                            className="font-mono"
                        />
                    </Field>
                    {sizing !== 'factor' && (
                        <Field
                            label="Capital de referência"
                            htmlFor="capital"
                            error={errors.reference_capital?.message}
                            hint="Capital, na moeda da conta, que copia o lote do Master por inteiro. Ex.: 10000 com saldo de 5000 copia metade."
                        >
                            <Input
                                {...register('reference_capital', { validate: v => parseFloat(v) > 0 || 'Deve ser maior que zero' })}
                                id="capital"
                                type="number"
                                step="1"
                                min="1"
                                className="font-mono"
                            />
                        </Field>
                    )}
                    <Field label="SL/TP" htmlFor="sltp" hint="Se a sua corretora cota diferente da do Master, use a distância da entrada.">
                        <Select {...register('sltp_mode')} id="sltp">
                            {limits.sltp_modes.map(m => <option key={m} value={m}>{SLTP_LABELS[m]}</option>)}
                        </Select>
                    </Field>
                </div>

                <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">Nomes de ativos diferentes na sua corretora</summary>
                    <div className="mt-3 grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                        <Field label="Mapa de símbolos" htmlFor="symbols" hint="Ex.: EURUSD=EURUSDm;XAUUSD=GOLD">
                            <Input {...register('symbol_map')} id="symbols" className="font-mono" />
                        </Field>
                        <Field label="Mapa de sufixos" htmlFor="suffix" hint="Ex.: .a=m (EURUSD.a vira EURUSDm)">
                            <Input {...register('suffix_map')} id="suffix" className="font-mono" />
                        </Field>
                    </div>
                </details>

                {!license.hosting && (
                    <p className="text-xs text-muted-foreground">
                        Com o EA no seu computador, configure as mesmas opções nas entradas do EA no MetaTrader.
                    </p>
                )}

                <div className="flex justify-end">
                    <Button size="sm" loading={isSubmitting} disabled={!isDirty}>
                        {!isSubmitting && <Check />} Salvar ajustes
                    </Button>
                </div>
            </form>
        </Card>
    );
}
