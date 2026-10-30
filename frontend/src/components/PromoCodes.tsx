import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Check, Link2, Plus, Power, Ticket, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import api, { type PromoCode } from '../api';
import InlineConfirm from './InlineConfirm';
import { Badge, type BadgeProps } from './ui/Badge';
import { Button } from './ui/Button';
import { Field, Input } from './ui/Field';
import { apiError, endOfDay, formatDate, isPast, toDayInput } from '../lib/utils';

type PromoForm = { code: string; label: string; free_days: string; max_uses: string; valid_until: string };

// What the API keeps: letters and digits, case, spaces and dashes aside
const CODE = /^[A-Za-z0-9\s-]*$/;

const statusOf = (p: PromoCode): { label: string; variant: BadgeProps['variant'] } => {
    if (!p.active) return { label: 'Desativado', variant: 'muted' };
    if (p.valid_until && isPast(p.valid_until)) return { label: 'Vencido', variant: 'muted' };
    if (p.max_uses != null && p.uses >= p.max_uses) return { label: 'Esgotado', variant: 'warning' };
    return { label: 'Ativo', variant: 'success' };
};

// The campaign's link: the portfolio's page with the code already typed
const campaignLink = (slug: string, code: string) => `${window.location.origin}/marketplace/${slug}?codigo=${code}`;

function NewCode({ base, onCreated, onCancel }: { base: string; onCreated: (p: PromoCode) => void; onCancel: () => void }) {
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<PromoForm>({
        defaultValues: { code: '', label: '', free_days: '30', max_uses: '', valid_until: '' },
    });
    const create = async (data: PromoForm) => {
        try {
            const res = await api.post<PromoCode>(base, {
                code: data.code.trim() || null,
                label: data.label.trim() || null,
                free_days: parseInt(data.free_days),
                max_uses: data.max_uses ? parseInt(data.max_uses) : null,
                valid_until: data.valid_until ? endOfDay(data.valid_until) : null,
            });
            onCreated(res.data);
            toast.success(`Código ${res.data.code} criado`, { description: 'Copie o link da campanha e divulgue.' });
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível criar o código.'));
        }
    };
    return (
        <form onSubmit={handleSubmit(create)} className="space-y-4 rounded-lg border border-border bg-secondary/30 p-4" noValidate>
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
                <Field label="Código (opcional)" htmlFor="promo-code" error={errors.code?.message} hint="Letras sem acento e números. Em branco, geramos um.">
                    <Input
                        {...register('code', {
                            validate: v => !v.trim() || (CODE.test(v) && v.replace(/[\s-]/g, '').length >= 4 && v.replace(/[\s-]/g, '').length <= 20)
                                || 'De 4 a 20 letras sem acento ou números',
                        })}
                        id="promo-code"
                        placeholder="LANCAMENTO"
                        className="font-mono uppercase"
                        autoComplete="off"
                    />
                </Field>
                <Field label="Nome da campanha (opcional)" htmlFor="promo-label" error={errors.label?.message} hint="Só você vê. Ex.: Lançamento de novembro.">
                    <Input {...register('label', { maxLength: { value: 80, message: 'Até 80 caracteres' } })} id="promo-label" />
                </Field>
            </div>
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
                <Field label="Dias grátis" htmlFor="promo-days" error={errors.free_days?.message} hint="Contam a partir da conexão da conta MT5.">
                    <Input
                        {...register('free_days', { validate: v => (parseInt(v) >= 1 && parseInt(v) <= 365) || 'De 1 a 365' })}
                        id="promo-days"
                        type="number"
                        min="1"
                        max="365"
                        className="font-mono"
                    />
                </Field>
                <Field label="Limite de usos (opcional)" htmlFor="promo-max" error={errors.max_uses?.message} hint="Em branco, sem limite.">
                    <Input
                        {...register('max_uses', { validate: v => !v || parseInt(v) >= 1 || 'Pelo menos 1' })}
                        id="promo-max"
                        type="number"
                        min="1"
                        className="font-mono"
                    />
                </Field>
                <Field label="Válido até (opcional)" htmlFor="promo-until" error={errors.valid_until?.message} hint="Último dia para usar o código.">
                    <Input
                        {...register('valid_until', { validate: v => !v || v >= toDayInput(new Date()) || 'Escolha hoje ou depois' })}
                        id="promo-until"
                        type="date"
                        min={toDayInput(new Date())}
                    />
                </Field>
            </div>
            <div className="flex justify-end gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancelar</Button>
                <Button size="sm" loading={isSubmitting}>{!isSubmitting && <Check />} Criar código</Button>
            </div>
        </form>
    );
}

// A listing's launch codes: the portfolio free for some days to whoever has one, once per client
export default function PromoCodes({ portfolioId, slug, published }: { portfolioId: number; slug: string; published: boolean }) {
    const base = `/portfolios/${portfolioId}/listing/promos`;
    const [items, setItems] = useState<PromoCode[] | null>(null);
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState<number | null>(null);
    const [deleting, setDeleting] = useState<number | null>(null);

    useEffect(() => {
        api.get<PromoCode[]>(base).then(res => setItems(res.data)).catch(e => { console.error(e); setItems([]); });
    }, [base]);

    const toggle = async (p: PromoCode) => {
        setBusy(p.id);
        try {
            const res = await api.put<PromoCode>(`${base}/${p.id}`, {
                label: p.label, free_days: p.free_days, max_uses: p.max_uses, valid_until: p.valid_until, active: !p.active,
            });
            setItems(current => current && current.map(i => (i.id === p.id ? res.data : i)));
            toast.success(res.data.active ? `Código ${p.code} ativado` : `Código ${p.code} desativado`,
                { description: res.data.active ? undefined : 'Quem já usou continua com os dias grátis.' });
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível mudar o código.'));
        } finally {
            setBusy(null);
        }
    };

    const remove = async (p: PromoCode) => {
        setBusy(p.id);
        try {
            await api.delete(`${base}/${p.id}`);
            setItems(current => current && current.filter(i => i.id !== p.id));
            setDeleting(null);
            toast.success(`Código ${p.code} excluído`);
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível excluir o código.'));
        } finally {
            setBusy(null);
        }
    };

    const copyLink = async (p: PromoCode) => {
        try {
            await navigator.clipboard.writeText(campaignLink(slug, p.code));
            toast.success('Link da campanha copiado', { description: 'Quem abrir já encontra o código preenchido.' });
        } catch {
            toast.error('Não foi possível copiar. Selecione o link e copie manualmente.');
        }
    };

    return (
        <section className="mt-4 space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h4 className="flex items-center gap-2 font-semibold"><Ticket className="size-4 text-primary" /> Códigos de lançamento</h4>
                    <p className="text-xs text-muted-foreground">
                        Quem tem o código copia este portfólio de graça, sem cartão, uma vez por cliente e por conta MT5.
                        Os dias começam quando a pessoa conecta a conta; antes do fim, ela recebe um email para assinar.
                    </p>
                </div>
                {!creating && <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus /> Novo código</Button>}
            </div>
            {!published && <p className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning">Os códigos funcionam quando o anúncio estiver publicado.</p>}
            {creating && (
                <NewCode base={base} onCancel={() => setCreating(false)}
                    onCreated={p => { setItems(current => [p, ...(current ?? [])]); setCreating(false); }} />
            )}
            {items === null ? (
                <p className="text-sm text-muted-foreground">Carregando...</p>
            ) : items.length === 0 ? (
                !creating && <p className="text-sm text-muted-foreground">Nenhum código ainda.</p>
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {items.map(p => {
                        const status = statusOf(p);
                        return (
                            <li key={p.id} className="space-y-2 p-3">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div className="min-w-0 space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-mono text-base font-semibold tracking-wider">{p.code}</span>
                                            <Badge variant={status.variant}>{status.label}</Badge>
                                            <Badge variant="primary">{p.free_days} dias grátis</Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {p.label && <>{p.label} · </>}
                                            {p.max_uses != null ? `${p.uses} de ${p.max_uses} usos` : `${p.uses} ${p.uses === 1 ? 'uso' : 'usos'}`}
                                            {p.valid_until && <> · até {formatDate(p.valid_until)}</>}
                                        </p>
                                        {p.uses > 0 && (
                                            <p className="text-xs text-muted-foreground">
                                                {p.started} {p.started === 1 ? 'conectou' : 'conectaram'} a conta · {p.subscribed} {p.subscribed === 1 ? 'assinou' : 'assinaram'}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {published && p.usable && (
                                            <Button size="sm" variant="ghost" onClick={() => copyLink(p)}><Link2 /> Copiar link</Button>
                                        )}
                                        <Button size="sm" variant="ghost" loading={busy === p.id && deleting !== p.id} onClick={() => toggle(p)}>
                                            {busy !== p.id && <Power />} {p.active ? 'Desativar' : 'Ativar'}
                                        </Button>
                                        {p.uses === 0 && deleting !== p.id && (
                                            <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                onClick={() => setDeleting(p.id)} aria-label={`Excluir o código ${p.code}`}>
                                                <Trash2 />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                                {deleting === p.id && (
                                    <InlineConfirm confirmLabel="Excluir" icon={<Trash2 />} loading={busy === p.id}
                                        onConfirm={() => remove(p)} onCancel={() => setDeleting(null)}>
                                        Excluir o código {p.code}? Ninguém usou ainda.
                                    </InlineConfirm>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
