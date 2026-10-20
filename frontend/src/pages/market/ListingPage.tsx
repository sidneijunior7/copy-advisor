import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, CheckCircle2, ExternalLink, MailCheck, Store } from 'lucide-react';
import { toast } from 'sonner';
import api, { type BacktestView, type Me, type PortfolioPerformance, type PublicFollowerStats, type PublicListing, type Subscription } from '../../api';
import AboutAuthor, { AuthorLinks } from '../../components/AboutAuthor';
import BacktestSection from '../../components/BacktestSection';
import EmptyState from '../../components/EmptyState';
import FollowerStatsView from '../../components/FollowerStatsView';
import PerformanceView from '../../components/PerformanceView';
import ResendLinkButton from '../../components/ResendLinkButton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, IconSelect, Input, Select } from '../../components/ui/Field';
import { useAuth } from '../../context/AuthContext';
import { PERIODS } from '../../lib/labels';
import { formatMoney, priceLabel } from '../../lib/money';
import { apiError, cn } from '../../lib/utils';

type SubscribeForm = { mt5_login: string; note: string };

function SubscribeBox({ listing }: { listing: PublicListing }) {
    const { user } = useAuth();
    const [me, setMe] = useState<Me | null>(null);
    const [done, setDone] = useState<Subscription | null>(null);
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<SubscribeForm>();
    const next = encodeURIComponent(`/marketplace/${listing.slug}`);

    useEffect(() => {
        if (user) api.get<Me>('/me').then(res => setMe(res.data)).catch(e => console.error(e));
    }, [user]);

    const subscribe = async (data: SubscribeForm) => {
        try {
            const res = await api.post<Subscription>(`/api/marketplace/${listing.slug}/subscribe`, {
                mt5_login: Number(data.mt5_login),
                note: data.note.trim() || null,
            });
            setDone(res.data);
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível enviar o pedido.'));
        }
    };

    if (!user) {
        return (
            <div className="space-y-2">
                <Link to={`/cadastro?next=${next}`} className="block"><Button className="w-full">Criar conta para assinar</Button></Link>
                <Link to={`/login?next=${next}`} className="block"><Button variant="ghost" className="w-full">Já tenho conta</Button></Link>
            </div>
        );
    }
    if (user.role !== 'CLIENT') {
        return <p className="text-sm text-muted-foreground">Entre com uma conta de cliente para assinar.</p>;
    }
    if (me?.email_enabled && !me.email_verified) {
        return (
            <div className="space-y-3 text-sm">
                <p className="flex items-start gap-2"><MailCheck className="mt-0.5 size-4 shrink-0 text-warning" /> Confirme seu email para assinar: o link está na sua caixa de entrada.</p>
                <ResendLinkButton />
            </div>
        );
    }
    if (done) {
        return (
            <div className="space-y-3 text-sm">
                <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                    Pedido enviado para a conta {done.mt5_login}. O gestor libera a licença depois do pagamento.</p>
                {done.listing.checkout_url && (
                    <a href={done.listing.checkout_url} target="_blank" rel="noopener noreferrer" className="block">
                        <Button className="w-full"><ExternalLink /> Pagar</Button>
                    </a>
                )}
                <Link to="/client" className="block text-center font-medium text-primary underline-offset-4 hover:underline">Acompanhar em Minhas licenças</Link>
            </div>
        );
    }
    return (
        <form onSubmit={handleSubmit(subscribe)} className="space-y-4" noValidate>
            <Field label="Sua conta MT5" htmlFor="mt5-login" error={errors.mt5_login?.message} hint="O número da conta que vai copiar.">
                <Input
                    {...register('mt5_login', { required: 'Informe a conta', pattern: { value: /^\d{1,12}$/, message: 'Só números' } })}
                    id="mt5-login"
                    inputMode="numeric"
                    className="font-mono"
                />
            </Field>
            <Field label="Mensagem (opcional)" htmlFor="note">
                <Input {...register('note', { maxLength: { value: 500, message: 'Até 500 caracteres' } })} id="note" placeholder="Ex.: comprovante enviado por email" />
            </Field>
            <Button className="w-full" loading={isSubmitting}>Pedir assinatura</Button>
            <p className="text-xs text-muted-foreground">Depois do pedido, você paga pelo link do gestor e ele libera a licença.</p>
        </form>
    );
}

export default function ListingPage() {
    const { slug } = useParams();
    const [listing, setListing] = useState<PublicListing | null>(null);
    const [missing, setMissing] = useState(false);
    const [days, setDays] = useState(90);
    const [stats, setStats] = useState<PortfolioPerformance | null>(null);
    const [followers, setFollowers] = useState<PublicFollowerStats | null>(null);
    const [backtestView, setBacktestView] = useState<BacktestView | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        api.get<PublicListing>(`/api/marketplace/${slug}`)
            .then(res => setListing(res.data))
            .catch(e => { console.error(e); setMissing(true); });
    }, [slug]);

    const changeDays = (value: number) => {
        setLoading(true);
        setDays(value);
    };

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            api.get<PortfolioPerformance>(`/api/marketplace/${slug}/performance`, { params: { days } })
                .then(res => { if (!cancelled) setStats(res.data); }),
            api.get<PublicFollowerStats>(`/api/marketplace/${slug}/followers`, { params: { days } })
                .then(res => { if (!cancelled) setFollowers(res.data); }),
            api.get<BacktestView>(`/api/marketplace/${slug}/backtest`, { params: { days } })
                .then(res => { if (!cancelled) setBacktestView(res.data); }),
        ])
            .catch(e => console.error(e))
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [slug, days]);

    if (missing) {
        return (
            <div className="panel">
                <EmptyState icon={<Store />} title="Portfólio não encontrado" description="Ele pode ter saído do marketplace." />
            </div>
        );
    }
    if (!listing) return <p className="text-sm text-muted-foreground">Carregando...</p>;

    return (
        <div className="space-y-8">
            <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> Marketplace
            </Link>
            <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-3">
                <div className="space-y-4 lg:col-span-2">
                    <div className="flex flex-wrap gap-1">{listing.markets.map(m => <Badge key={m} variant="primary">{m}</Badge>)}</div>
                    <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{listing.title}</h1>
                    <div className="flex items-center justify-between gap-3 md:hidden">
                        <p className="min-w-0 truncate text-sm text-muted-foreground">por <span className="font-medium text-foreground">{listing.manager.name}</span></p>
                        <AboutAuthor manager={listing.manager} />
                    </div>
                    {listing.summary && <p className="text-lg text-muted-foreground">{listing.summary}</p>}
                    {listing.description && <p className="whitespace-pre-line text-sm leading-relaxed">{listing.description}</p>}
                    {listing.strategies.length > 0 && (
                        <p className="text-sm text-muted-foreground">Estratégias: {listing.strategies.join(', ')}</p>
                    )}
                    <div className="hidden space-y-3 rounded-lg border border-border bg-card p-4 md:block">
                        <div>
                            <p className="text-xs uppercase tracking-wider text-muted-foreground">Gestor</p>
                            <p className="mt-1 font-semibold">{listing.manager.name}</p>
                            {listing.manager.bio && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{listing.manager.bio}</p>}
                        </div>
                        <AuthorLinks manager={listing.manager} />
                    </div>
                </div>
                <aside className="panel space-y-4 p-5 lg:sticky lg:top-24">
                    <p className="text-2xl font-bold">{priceLabel(listing)}</p>
                    <dl className="space-y-1 text-sm">
                        {listing.min_capital != null && (
                            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Capital recomendado</dt>
                                <dd>{formatMoney(listing.min_capital, listing.currency)}</dd></div>
                        )}
                        <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Hospedagem</dt>
                            <dd>{listing.hosting_allowed ? 'Disponível' : 'EA no seu computador'}</dd></div>
                    </dl>
                    <SubscribeBox listing={listing} />
                </aside>
            </div>

            <section className="space-y-4">
                <div className="flex items-start justify-between gap-3 sm:items-center">
                    <div>
                        <h2 className="text-xl font-semibold">Desempenho real</h2>
                        <p className="text-sm text-muted-foreground">As operações fechadas na conta do gestor, no tamanho dele. Resultados passados não garantem resultados futuros.</p>
                        <p className="mt-1 text-xs font-medium sm:hidden">{PERIODS.find(p => p.days === days)?.label}</p>
                    </div>
                    <IconSelect icon={<CalendarDays />} label="Período" value={days} onChange={e => changeDays(Number(e.target.value))} className="sm:hidden">
                        {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
                    </IconSelect>
                    <div className="hidden shrink-0 sm:block">
                        <Select value={days} onChange={e => changeDays(Number(e.target.value))} className="h-9 w-48" aria-label="Período">
                            {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
                        </Select>
                    </div>
                </div>
                {stats && (
                    <div className={cn('transition-opacity', loading && 'opacity-60')}>
                        <PerformanceView stats={stats} emptyTitle="Sem operações fechadas no período"
                            emptyDescription="Escolha um período maior, ou volte quando o gestor fechar as primeiras operações." />
                    </div>
                )}
            </section>

            {backtestView?.available && (
                <section className="space-y-4">
                    <div>
                        <h2 className="text-xl font-semibold">Backtest e resultado ao vivo</h2>
                        <p className="text-sm text-muted-foreground">O que o gestor testou antes de operar, e se a conta real está se comportando como o teste previa.</p>
                    </div>
                    <div className={cn('transition-opacity', loading && 'opacity-60')}>
                        <BacktestSection view={backtestView} />
                    </div>
                </section>
            )}

            <section className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">Como os seguidores copiaram</h2>
                    <p className="text-sm text-muted-foreground">O que as contas dos clientes conseguiram nas mesmas operações, no mesmo período.
                        Corretora, horário e tamanho mudam o preço de cada cópia.</p>
                </div>
                {followers && (
                    <div className={cn('transition-opacity', loading && 'opacity-60')}>
                        <FollowerStatsView stats={followers} />
                    </div>
                )}
            </section>
        </div>
    );
}
