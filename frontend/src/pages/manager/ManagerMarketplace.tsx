import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { Check, EyeOff, ExternalLink, Pencil, Plus, Send, Store, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import api, { type Listing, type Me, type MyListing } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import ListingForm from '../../components/ListingForm';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { priceLabel } from '../../lib/money';
import { apiError } from '../../lib/utils';

const STATUS = {
    draft: { label: 'Rascunho', variant: 'muted' },
    published: { label: 'Publicado', variant: 'success' },
    suspended: { label: 'Suspenso', variant: 'destructive' },
} as const;

function PublicProfile({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
    const { register, handleSubmit, formState: { errors, isSubmitting, isDirty } } = useForm<{ name: string; bio: string }>({
        defaultValues: { name: me.name ?? '', bio: me.bio ?? '' },
    });
    const save = async (data: { name: string; bio: string }) => {
        try {
            const res = await api.put<Me>('/me/profile', { name: data.name.trim(), bio: data.bio.trim() || null });
            onSaved(res.data);
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
                <div className="flex justify-end">
                    <Button size="sm" loading={isSubmitting} disabled={!isDirty}>{!isSubmitting && <Check />} Salvar perfil</Button>
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
            toast.success(publish ? 'Publicado no marketplace' : 'Saiu do marketplace', {
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
                title="Marketplace"
                description="Publique seus portfólios para clientes novos. Eles veem o desempenho real e pedem a assinatura; você aprova em Assinaturas."
                icon={<Store />}
            >
                <Link to="/marketplace" target="_blank"><Button variant="outline" size="sm"><ExternalLink /> Ver o marketplace</Button></Link>
            </PageHeader>

            <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
                <div className="order-last xl:order-2">{me && <PublicProfile me={me} onSaved={setMe} />}</div>
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
                            </Card>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
