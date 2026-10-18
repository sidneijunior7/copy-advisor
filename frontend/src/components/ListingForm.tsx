import { useForm } from 'react-hook-form';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import api, { MARKETS, type Listing } from '../api';
import { Button } from './ui/Button';
import { Field, Input, Select, Textarea } from './ui/Field';
import { apiError } from '../lib/utils';

type ListingFormData = {
    title: string;
    slug: string;
    summary: string;
    description: string;
    markets: Listing['markets'];
    price: string;
    currency: Listing['currency'];
    checkout_url: string;
    default_days: string;
    default_max_lots: string;
    min_capital: string;
    hosting_allowed: boolean;
};

interface ListingFormProps {
    portfolioId: number;
    portfolioName: string;
    listing: Listing | null;
    onSaved: (listing: Listing) => void;
    onCancel: () => void;
}

// What the marketplace shows about a portfolio. Saving a published listing changes it at once
export default function ListingForm({ portfolioId, portfolioName, listing, onSaved, onCancel }: ListingFormProps) {
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ListingFormData>({
        defaultValues: {
            title: listing?.title ?? portfolioName,
            slug: listing?.slug ?? '',
            summary: listing?.summary ?? '',
            description: listing?.description ?? '',
            markets: listing?.markets ?? [],
            price: listing?.price != null ? String(listing.price) : '',
            currency: listing?.currency ?? 'BRL',
            checkout_url: listing?.checkout_url ?? '',
            default_days: String(listing?.default_days ?? 30),
            default_max_lots: String(listing?.default_max_lots ?? 1),
            min_capital: listing?.min_capital != null ? String(listing.min_capital) : '',
            hosting_allowed: listing?.hosting_allowed ?? true,
        },
    });

    const save = async (data: ListingFormData) => {
        try {
            const res = await api.put<Listing>(`/portfolios/${portfolioId}/listing`, {
                title: data.title.trim(),
                slug: data.slug.trim() || null,
                summary: data.summary.trim() || null,
                description: data.description.trim() || null,
                markets: data.markets,
                price: data.price === '' ? null : parseFloat(data.price),
                currency: data.currency,
                checkout_url: data.checkout_url.trim() || null,
                default_days: parseInt(data.default_days),
                default_max_lots: parseFloat(data.default_max_lots),
                min_capital: data.min_capital === '' ? null : parseFloat(data.min_capital),
                hosting_allowed: data.hosting_allowed,
            });
            onSaved(res.data);
            toast.success('Anúncio salvo', { description: res.data.status === 'published' ? 'Já aparece assim no marketplace.' : 'Publique quando estiver pronto.' });
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível salvar o anúncio. Confira os campos.'));
        }
    };

    return (
        <form onSubmit={handleSubmit(save)} className="space-y-5 border-t border-border pt-5" noValidate>
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                <Field label="Título" htmlFor={`title-${portfolioId}`} error={errors.title?.message}>
                    <Input {...register('title', { required: 'Informe o título', minLength: { value: 3, message: 'Pelo menos 3 caracteres' }, maxLength: { value: 80, message: 'Até 80 caracteres' } })}
                        id={`title-${portfolioId}`} />
                </Field>
                <Field label="Endereço" htmlFor={`slug-${portfolioId}`} error={errors.slug?.message}
                    hint={`/marketplace/${listing?.slug ?? 'gerado-do-titulo'}. Em branco, vem do título.`}>
                    <Input {...register('slug', { pattern: { value: /^([a-z0-9]+(-[a-z0-9]+)*)?$/, message: 'Minúsculas, números e hífens' } })}
                        id={`slug-${portfolioId}`} className="font-mono" placeholder="tendencia-indice" />
                </Field>
            </div>
            <Field label="Resumo" htmlFor={`summary-${portfolioId}`} error={errors.summary?.message} hint="Uma frase, no cartão do catálogo.">
                <Input {...register('summary', { maxLength: { value: 200, message: 'Até 200 caracteres' } })} id={`summary-${portfolioId}`} />
            </Field>
            <Field label="Descrição" htmlFor={`description-${portfolioId}`} error={errors.description?.message}
                hint="Como a estratégia opera, horários, risco por operação. Aparece como escrita.">
                <Textarea {...register('description', { maxLength: { value: 5000, message: 'Até 5.000 caracteres' } })} id={`description-${portfolioId}`} rows={6} />
            </Field>
            <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Mercados</legend>
                <div className="flex flex-wrap gap-4">
                    {MARKETS.map(m => (
                        <label key={m} className="flex items-center gap-2 text-sm">
                            <input type="checkbox" value={m} {...register('markets')} /> {m}
                        </label>
                    ))}
                </div>
            </fieldset>
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-3">
                <Field label="Preço" htmlFor={`price-${portfolioId}`} error={errors.price?.message} hint="Em branco: sob consulta. 0: gratuito.">
                    <Input {...register('price', { validate: v => v === '' || parseFloat(v) >= 0 || 'Não pode ser negativo' })}
                        id={`price-${portfolioId}`} type="number" step="0.01" min="0" className="font-mono" />
                </Field>
                <Field label="Moeda" htmlFor={`currency-${portfolioId}`}>
                    <Select {...register('currency')} id={`currency-${portfolioId}`}>
                        <option value="BRL">Real (BRL)</option>
                        <option value="USD">Dólar (USD)</option>
                    </Select>
                </Field>
                <Field label="Validade por pagamento (dias)" htmlFor={`days-${portfolioId}`} error={errors.default_days?.message}>
                    <Input {...register('default_days', { validate: v => (parseInt(v) >= 1 && parseInt(v) <= 3650) || 'De 1 a 3650' })}
                        id={`days-${portfolioId}`} type="number" min="1" className="font-mono" />
                </Field>
            </div>
            <Field label="Link de pagamento" htmlFor={`checkout-${portfolioId}`} error={errors.checkout_url?.message}
                hint="Hotmart, Kiwify ou outro checkout. O cliente paga ali, e você aprova o pedido em Assinaturas.">
                <Input {...register('checkout_url', { pattern: { value: /^(https:\/\/\S+)?$/, message: 'Use um link https://' } })}
                    id={`checkout-${portfolioId}`} placeholder="https://" />
            </Field>
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-3">
                <Field label="Limite de lotes padrão" htmlFor={`lots-${portfolioId}`} error={errors.default_max_lots?.message}
                    hint="Da licença criada na aprovação. Ajustável ao aprovar.">
                    <Input {...register('default_max_lots', { validate: v => parseFloat(v) > 0 || 'Maior que zero' })}
                        id={`lots-${portfolioId}`} type="number" step="0.01" min="0.01" className="font-mono" />
                </Field>
                <Field label="Capital recomendado" htmlFor={`capital-${portfolioId}`} hint="Opcional.">
                    <Input {...register('min_capital')} id={`capital-${portfolioId}`} type="number" step="1" min="0" className="font-mono" />
                </Field>
                <label className="flex items-center gap-2 pt-7 text-sm">
                    <input type="checkbox" {...register('hosting_allowed')} /> Aceita conta hospedada
                </label>
            </div>
            <div className="flex justify-end gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancelar</Button>
                <Button size="sm" loading={isSubmitting}>{!isSubmitting && <Check />} Salvar anúncio</Button>
            </div>
        </form>
    );
}
