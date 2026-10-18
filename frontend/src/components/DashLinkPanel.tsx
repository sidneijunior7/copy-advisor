import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Check, Link2, Pencil, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import api, { type DashLink, type DashLinkState } from '../api';
import { Button } from './ui/Button';
import { Field, Input } from './ui/Field';
import { apiError, formatDateTime } from '../lib/utils';

type LinkForm = { token: string; history: boolean };

// The portfolio's link to a Trademetric Dash portfolio: the Master's closed trades go to the Dash's live tracking,
// so the creator runs one EA for both
export default function DashLinkPanel({ portfolioId, portfolioName }: { portfolioId: number; portfolioName: string }) {
    const [state, setState] = useState<DashLinkState | null>(null);
    const [editing, setEditing] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<LinkForm>({
        defaultValues: { token: '', history: false },
    });

    useEffect(() => {
        api.get<DashLinkState>(`/portfolios/${portfolioId}/dash`)
            .then(res => setState(res.data))
            .catch(e => console.error(e));
    }, [portfolioId]);

    const save = async (data: LinkForm) => {
        try {
            const res = await api.put<DashLink>(`/portfolios/${portfolioId}/dash`, {
                token: data.token.trim(),
                history_days: data.history ? 90 : 0,
            });
            setState(current => ({ available: current?.available ?? true, link: res.data }));
            setEditing(false);
            reset();
            toast.success(`${portfolioName}: vinculado ao Dash`, {
                description: 'As operações que o Master fechar chegam ao Dash em até um minuto.',
            });
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível vincular ao Dash.'));
        }
    };

    const remove = async () => {
        try {
            await api.delete(`/portfolios/${portfolioId}/dash`);
            setState(current => ({ available: current?.available ?? true, link: null }));
            setConfirmRemove(false);
            toast.success(`${portfolioName}: vínculo com o Dash removido`);
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível remover o vínculo.'));
        }
    };

    if (state === null) return null;
    const link = state.link;

    if (editing) {
        return (
            <form onSubmit={handleSubmit(save)} className="mt-4 space-y-4 border-t border-border pt-4" noValidate>
                <p className="text-sm font-medium">Enviar as operações deste portfólio ao Trademetric Dash</p>
                <Field label="Token de API do portfólio no Dash" htmlFor={`dash-${portfolioId}`} error={errors.token?.message}
                    hint="No Dash, abra o portfólio e gere um token de API. Ele aparece uma vez só: copie e cole aqui.">
                    <Input
                        {...register('token', {
                            required: 'Cole o token',
                            pattern: { value: /^\s*tc_[0-9a-f]{48}\s*$/, message: 'O token do Dash começa com tc_' },
                        })}
                        id={`dash-${portfolioId}`}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="tc_..."
                        className="font-mono"
                    />
                </Field>
                <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" {...register('history')} />
                    <span>
                        Enviar também os últimos 90 dias
                        <span className="block text-xs text-muted-foreground">
                            Só se o EA de acompanhamento do Dash não rodava nesta conta: senão, essas operações aparecem duas vezes no Dash.
                        </span>
                    </span>
                </label>
                <p className="text-xs text-muted-foreground">
                    Depois de vincular, tire o EA de acompanhamento do Dash desta conta: o Master passa a fazer os dois papéis.
                </p>
                <div className="flex justify-end gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); reset(); }}>Cancelar</Button>
                    <Button size="sm" loading={isSubmitting}>{!isSubmitting && <Check />} Vincular</Button>
                </div>
            </form>
        );
    }

    return (
        <div className="mt-3 flex items-start justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
            <div className="flex items-start gap-1.5">
                <Link2 className="mt-0.5 size-3.5 shrink-0" />
                {!state.available ? (
                    <span>O vínculo com o Trademetric Dash não está disponível neste servidor.</span>
                ) : link === null ? (
                    <span>Trademetric Dash: não vinculado. As operações do Master deste portfólio podem aparecer no acompanhamento ao vivo do Dash.</span>
                ) : (
                    <span className="space-y-0.5">
                        <span className="block">
                            Vinculado ao Trademetric Dash (token …{link.token_hint}).{' '}
                            {link.sent_count > 0
                                ? `${link.sent_count} ${link.sent_count === 1 ? 'operação enviada' : 'operações enviadas'}${link.last_sent_at ? `, a última em ${formatDateTime(link.last_sent_at)}` : ''}.`
                                : 'Nenhuma operação enviada ainda.'}
                        </span>
                        {link.last_error && (
                            <span role="status" className={link.status === 'error' ? 'block text-destructive' : 'block text-warning'}>
                                {link.last_error}
                            </span>
                        )}
                    </span>
                )}
            </div>
            {state.available && (
                <div className="flex shrink-0 items-center gap-1">
                    {link !== null && (confirmRemove ? (
                        <>
                            <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={remove}>Desvincular</Button>
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirmRemove(false)}>Cancelar</Button>
                        </>
                    ) : (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirmRemove(true)}>
                            <Unlink /> Desvincular
                        </Button>
                    ))}
                    {!confirmRemove && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(true)}>
                            {link === null ? <><Link2 /> Vincular</> : <><Pencil /> Trocar token</>}
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}
