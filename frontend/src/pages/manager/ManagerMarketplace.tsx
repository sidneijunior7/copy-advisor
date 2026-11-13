import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, EyeOff, ExternalLink, FileText, Instagram, Pencil, Plus, Send, Store, Ticket, UserRound, Youtube } from 'lucide-react';
import { toast } from 'sonner';
import api, { type Listing, type Me, type MyListing } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import ListingForm from '../../components/ListingForm';
import PageHeader from '../../components/PageHeader';
import PromoCodes from '../../components/PromoCodes';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { formatDocument } from '../../lib/cpf';
import { priceLabel } from '../../lib/money';
import { apiError } from '../../lib/utils';

const STATUS = {
    draft: { label: 'Rascunho', variant: 'muted' },
    published: { label: 'Publicado', variant: 'success' },
    suspended: { label: 'Suspenso', variant: 'destructive' },
} as const;

type ProfileForm = { name: string; bio: string; youtube_url: string; instagram_url: string };

// The same rules as the API: each link only to its own network
const YOUTUBE_URL = /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\/[^\s<>"']+$/;
const INSTAGRAM_URL = /^https:\/\/(www\.)?instagram\.com\/[^\s<>"']+$/;

function PublicProfile({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
    const { register, handleSubmit, reset, formState: { errors, isSubmitting, isDirty } } = useForm<ProfileForm>({
        defaultValues: { name: me.name ?? '', bio: me.bio ?? '', youtube_url: me.youtube_url ?? '', instagram_url: me.instagram_url ?? '' },
    });
    const save = async (data: ProfileForm) => {
        try {
            const res = await api.put<Me>('/me/profile', {
                name: data.name.trim(),
                bio: data.bio.trim() || null,
                youtube_url: data.youtube_url.trim() || null,
                instagram_url: data.instagram_url.trim() || null,
            });
            onSaved(res.data);
            reset({ name: res.data.name ?? '', bio: res.data.bio ?? '', youtube_url: res.data.youtube_url ?? '', instagram_url: res.data.instagram_url ?? '' });
            toast.success('Perfil público salvo');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível salvar o perfil.'));
        }
    };
    return (
        <Card title="Seu perfil público" description="Aparece em todos os seus anúncios." icon={<UserRound />}>
            <form onSubmit={handleSubmit(save)} className="space-y-4" noValidate>
                <Field label="Nome" htmlFor="profile-name" error={errors.name?.message} hint="Seu nome ou o da sua empresa.">
                    <Input {...register('name', { required: 'Informe o nome', maxLength: { value: 100, message: 'Até 100 caracteres' } })} id="profile-name" />
                </Field>
                <Field label="Sobre você" htmlFor="profile-bio" error={errors.bio?.message} hint="Experiência, credenciais, como você opera.">
                    <Textarea {...register('bio', { maxLength: { value: 2000, message: 'Até 2.000 caracteres' } })} id="profile-bio" rows={4} />
                </Field>
                <Field label="YouTube (opcional)" htmlFor="profile-youtube" error={errors.youtube_url?.message}>
                    <Input
                        {...register('youtube_url', { validate: v => !v.trim() || YOUTUBE_URL.test(v.trim()) || 'Um endereço https do youtube.com ou youtu.be' })}
                        id="profile-youtube"
                        type="url"
                        icon={<Youtube />}
                        placeholder="https://www.youtube.com/@seucanal"
                    />
                </Field>
                <Field label="Instagram (opcional)" htmlFor="profile-instagram" error={errors.instagram_url?.message}
                    hint="Aparecem como ícones em Sobre o autor.">
                    <Input
                        {...register('instagram_url', { validate: v => !v.trim() || INSTAGRAM_URL.test(v.trim()) || 'Um endereço https do instagram.com' })}
                        id="profile-instagram"
                        type="url"
                        icon={<Instagram />}
                        placeholder="https://www.instagram.com/seuperfil"
                    />
                </Field>
                <div className="flex justify-end">
                    <Button size="sm" loading={isSubmitting} disabled={!isDirty}>{!isSubmitting && <Check />} Salvar perfil</Button>
                </div>
            </form>
        </Card>
    );
}

type SellerForm = { name: string; document: string; address: string; email: string; credential: string };

const sellerDefaults = (me: Me): SellerForm => ({
    name: me.seller?.name ?? '', document: me.seller?.document ? formatDocument(me.seller.document) : '',
    address: me.seller?.address ?? '', email: me.seller?.email ?? '', credential: me.seller?.credential ?? '',
});

// Who sells the trader's portfolios: the buyer sees it next to the price and in the checkout, as e-commerce law asks
// (Decreto 7.962/2013). Without it a portfolio cannot be published
function SellerDetails({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
    const { register, handleSubmit, reset, setValue, formState: { errors, isSubmitting, isDirty } } = useForm<SellerForm>({ defaultValues: sellerDefaults(me) });
    const save = async (data: SellerForm) => {
        try {
            const res = await api.put<Me>('/me/seller', {
                name: data.name.trim(), document: data.document, address: data.address.trim(), email: data.email.trim(),
                credential: data.credential.trim() || null,
            });
            onSaved(res.data);
            reset(sellerDefaults(res.data));
            toast.success('Dados do vendedor salvos');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível salvar os dados do vendedor.'));
        }
    };
    const documentField = register('document', {
        required: 'Informe o CPF ou o CNPJ',
        validate: v => [11, 14].includes(v.replace(/\D/g, '').length) || 'CPF com 11 dígitos ou CNPJ com 14',
    });
    return (
        <Card title="Dados do vendedor" icon={<FileText />}
            description="Quem vende os seus portfólios. Aparece na página do portfólio e no checkout.">
            <form onSubmit={handleSubmit(save)} className="space-y-4" noValidate>
                <Field label="Nome completo ou razão social" htmlFor="seller-name" error={errors.name?.message}>
                    <Input {...register('name', { required: 'Informe o nome', minLength: { value: 3, message: 'Nome completo' }, maxLength: { value: 120, message: 'Até 120 caracteres' } })} id="seller-name" />
                </Field>
                <Field label="CPF ou CNPJ" htmlFor="seller-document" error={errors.document?.message}>
                    <Input {...documentField} id="seller-document" inputMode="numeric" className="font-mono"
                        onChange={e => { setValue('document', formatDocument(e.target.value), { shouldDirty: true }); }} />
                </Field>
                <Field label="Endereço" htmlFor="seller-address" error={errors.address?.message} hint="Rua, número, complemento, cidade e estado.">
                    <Input {...register('address', { required: 'Informe o endereço', minLength: { value: 10, message: 'Endereço completo' }, maxLength: { value: 200, message: 'Até 200 caracteres' } })} id="seller-address" />
                </Field>
                <Field label="E-mail de contato" htmlFor="seller-email" error={errors.email?.message} hint="Para os clientes falarem com você.">
                    <Input {...register('email', { required: 'Informe o e-mail', pattern: { value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, message: 'E-mail inválido' } })} id="seller-email" type="email" />
                </Field>
                <Field label="Credenciamento de analista (opcional)" htmlFor="seller-credential" error={errors.credential?.message}
                    hint="Ex.: CNPI 1234. Aparece como informado por você.">
                    <Input {...register('credential', { maxLength: { value: 60, message: 'Até 60 caracteres' } })} id="seller-credential" />
                </Field>
                <div className="flex justify-end">
                    <Button size="sm" loading={isSubmitting} disabled={!isDirty}>{!isSubmitting && <Check />} Salvar dados</Button>
                </div>
            </form>
        </Card>
    );
}

// The manager's listings: one per portfolio, edited here and published when ready
export default function ManagerMarketplace() {
    const [me, setMe] = useState<Me | null>(null);
    const [items, setItems] = useState<MyListing[] | null>(null);
    const [editing, setEditing] = useState<number | null>(null);
    const [codesOf, setCodesOf] = useState<number | null>(null); // The portfolio whose launch codes are open
    const [busy, setBusy] = useState<number | null>(null);

    useEffect(() => {
        api.get<Me>('/me').then(res => setMe(res.data)).catch(e => console.error(e));
        api.get<MyListing[]>('/me/listings').then(res => setItems(res.data)).catch(e => { console.error(e); setItems([]); });
    }, []);

    const replace = (portfolioId: number, listing: Listing) =>
        setItems(current => current && current.map(i => (i.portfolio.id === portfolioId ? { ...i, listing } : i)));

    const toggle = async (item: MyListing, publish: boolean) => {
        setBusy(item.portfolio.id);
        try {
            const res = await api.post<Listing>(`/portfolios/${item.portfolio.id}/listing/${publish ? 'publish' : 'unpublish'}`);
            replace(item.portfolio.id, res.data);
            toast.success(publish ? 'Publicado na vitrine' : 'Saiu da vitrine', {
                description: publish ? undefined : 'As licenças já vendidas continuam valendo.',
            });
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível mudar a publicação.'));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Vitrine"
                description="Publique seus portfólios para clientes novos. Você vende a assinatura; a Trademetric fornece a plataforma."
                icon={<Store />}
            >
                <Link to="/marketplace" target="_blank"><Button variant="outline" size="sm"><ExternalLink /> Ver a página pública</Button></Link>
            </PageHeader>

            {me && !me.seller?.complete && (
                <p role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                    <span>Preencha os <strong>dados do vendedor</strong> ao lado. Sem eles, o cliente não vê quem vende, e os portfólios não podem ser publicados.</span>
                </p>
            )}

            <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
                <div className="order-last space-y-6 xl:order-2">
                    {me && <SellerDetails me={me} onSaved={setMe} />}
                    {me && <PublicProfile me={me} onSaved={setMe} />}
                </div>
                <div className="space-y-4 xl:col-span-2">
                    {items === null ? (
                        <p className="text-sm text-muted-foreground">Carregando...</p>
                    ) : items.length === 0 ? (
                        <div className="panel">
                            <EmptyState icon={<Store />} title="Nenhum portfólio" description="Crie um portfólio com estratégias em Portfólios antes de anunciá-lo." />
                        </div>
                    ) : items.map(item => {
                        const l = item.listing;
                        const status = l ? STATUS[l.status] : null;
                        return (
                            <Card key={item.portfolio.id}>
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-lg font-semibold">{l?.title ?? item.portfolio.name}</h3>
                                            {status ? <Badge variant={status.variant}>{status.label}</Badge> : <Badge>Sem anúncio</Badge>}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            Portfólio {item.portfolio.name} · {item.portfolio.strategies} {item.portfolio.strategies === 1 ? 'estratégia' : 'estratégias'}
                                            {l && ` · ${priceLabel(l)}`}
                                        </p>
                                        {l?.status === 'suspended' && l.suspended_reason && (
                                            <p className="mt-1 text-sm text-destructive">Suspenso pela administração: {l.suspended_reason}</p>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {editing !== item.portfolio.id && (
                                            <Button size="sm" variant="outline" onClick={() => setEditing(item.portfolio.id)}>
                                                {l ? <><Pencil /> Editar</> : <><Plus /> Criar anúncio</>}
                                            </Button>
                                        )}
                                        {l && (
                                            <Button size="sm" variant={codesOf === item.portfolio.id ? 'secondary' : 'ghost'}
                                                onClick={() => setCodesOf(codesOf === item.portfolio.id ? null : item.portfolio.id)}
                                                aria-expanded={codesOf === item.portfolio.id}>
                                                <Ticket /> Códigos
                                            </Button>
                                        )}
                                        {l?.status === 'draft' && (
                                            <Button size="sm" loading={busy === item.portfolio.id} onClick={() => toggle(item, true)}>
                                                {busy !== item.portfolio.id && <Send />} Publicar
                                            </Button>
                                        )}
                                        {l?.status === 'published' && (
                                            <>
                                                <Link to={`/marketplace/${l.slug}`} target="_blank"><Button size="sm" variant="ghost"><ExternalLink /> Ver</Button></Link>
                                                <Button size="sm" variant="ghost" loading={busy === item.portfolio.id} onClick={() => toggle(item, false)}>
                                                    {busy !== item.portfolio.id && <EyeOff />} Tirar do ar
                                                </Button>
                                            </>
                                        )}
                                    </div>
                                </div>
                                {editing === item.portfolio.id && (
                                    <ListingForm
                                        portfolioId={item.portfolio.id}
                                        portfolioName={item.portfolio.name}
                                        listing={l}
                                        onSaved={saved => { replace(item.portfolio.id, saved); setEditing(null); }}
                                        onCancel={() => setEditing(null)}
                                    />
                                )}
                                {l && codesOf === item.portfolio.id && (
                                    <PromoCodes portfolioId={item.portfolio.id} slug={l.slug} published={l.status === 'published'} />
                                )}
                            </Card>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
