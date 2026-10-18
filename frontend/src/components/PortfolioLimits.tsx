import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Check, Pencil, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLimits, type Portfolio } from '../api';
import { Button } from './ui/Button';
import { Field, Input } from './ui/Field';
import { SIZING_LABELS, SLTP_LABELS } from '../lib/labels';
import { apiError } from '../lib/utils';

type LimitsForm = {
    factor_min: string;
    factor_max: string;
    sizing_modes: ClientLimits['sizing_modes'];
    sltp_modes: ClientLimits['sltp_modes'];
};

const number = (value: number) => value.toLocaleString('pt-BR');

// What the portfolio's clients may set on their own licenses; the lot limit of each license still caps it all
export default function PortfolioLimits({ portfolio, onSaved }: { portfolio: Portfolio; onSaved: (limits: ClientLimits) => void }) {
    const [editing, setEditing] = useState(false);
    const limits = portfolio.client_limits;
    const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<LimitsForm>({
        defaultValues: {
            factor_min: String(limits.factor_min),
            factor_max: String(limits.factor_max),
            sizing_modes: limits.sizing_modes,
            sltp_modes: limits.sltp_modes,
        },
    });

    const save = async (data: LimitsForm) => {
        try {
            const res = await api.put<ClientLimits>(`/portfolios/${portfolio.id}/limits`, {
                factor_min: parseFloat(data.factor_min),
                factor_max: parseFloat(data.factor_max),
                sizing_modes: data.sizing_modes,
                sltp_modes: data.sltp_modes,
            });
            onSaved(res.data);
            setEditing(false);
            toast.success(`${portfolio.name}: limites dos clientes salvos`, {
                description: 'Ajustes já salvos continuam valendo até o cliente mudá-los.',
            });
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível salvar os limites.'));
        }
    };

    if (!editing) {
        return (
            <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
                <p className="flex items-start gap-1.5">
                    <SlidersHorizontal className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                        Clientes ajustam o fator de {number(limits.factor_min)} a {number(limits.factor_max)};
                        tamanho: {limits.sizing_modes.map(m => SIZING_LABELS[m].toLowerCase()).join(', ')};
                        SL/TP: {limits.sltp_modes.map(m => SLTP_LABELS[m].toLowerCase()).join(', ')}.
                    </span>
                </p>
                <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => setEditing(true)}>
                    <Pencil /> Editar
                </Button>
            </div>
        );
    }

    const min = parseFloat(watch('factor_min'));
    return (
        <form onSubmit={handleSubmit(save)} className="mt-4 space-y-4 border-t border-border pt-4" noValidate>
            <p className="text-sm font-medium">O que os clientes deste portfólio podem ajustar</p>
            <div className="grid grid-cols-2 items-start gap-4">
                <Field label="Fator mínimo" htmlFor={`min-${portfolio.id}`} error={errors.factor_min?.message}>
                    <Input {...register('factor_min', { validate: v => parseFloat(v) > 0 || 'Maior que zero' })}
                        id={`min-${portfolio.id}`} type="number" step="0.01" min="0.01" className="font-mono" />
                </Field>
                <Field label="Fator máximo" htmlFor={`max-${portfolio.id}`} error={errors.factor_max?.message}
                    hint="Acima de 1, o cliente copia mais que o lote do Master.">
                    <Input {...register('factor_max', { validate: v => parseFloat(v) >= (min || 0) || 'Não pode ser menor que o mínimo' })}
                        id={`max-${portfolio.id}`} type="number" step="0.01" min="0.01" className="font-mono" />
                </Field>
            </div>
            <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Modos de tamanho</legend>
                {(Object.keys(SIZING_LABELS) as ClientLimits['sizing_modes']).map(m => (
                    <label key={m} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" value={m} {...register('sizing_modes', { validate: v => v.length > 0 || 'Escolha ao menos um' })} />
                        {SIZING_LABELS[m]}
                    </label>
                ))}
                {errors.sizing_modes && <p className="text-sm text-destructive">{errors.sizing_modes.message}</p>}
            </fieldset>
            <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Modos de SL/TP</legend>
                {(Object.keys(SLTP_LABELS) as ClientLimits['sltp_modes']).map(m => (
                    <label key={m} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" value={m} {...register('sltp_modes', { validate: v => v.length > 0 || 'Escolha ao menos um' })} />
                        {SLTP_LABELS[m]}
                    </label>
                ))}
                {errors.sltp_modes && <p className="text-sm text-destructive">{errors.sltp_modes.message}</p>}
            </fieldset>
            <div className="flex justify-end gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
                <Button size="sm" loading={isSubmitting}>{!isSubmitting && <Check />} Salvar limites</Button>
            </div>
        </form>
    );
}
