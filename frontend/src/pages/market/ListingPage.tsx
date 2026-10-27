import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CalendarDays, CheckCircle2, ChevronDown, Cloud, ExternalLink, MailCheck, Store } from 'lucide-react';
import { toast } from 'sonner';
import api, { type BacktestView, type Me, type PortfolioPerformance, type PublicFollowerStats, type PublicListing, type Subscription } from '../../api';
import AboutAuthor, { AuthorLinks } from '../../components/AboutAuthor';
import BacktestSection from '../../components/BacktestSection';
import Sparkline from '../../components/charts/Sparkline';
import EmptyState from '../../components/EmptyState';
import FollowerStatsView from '../../components/FollowerStatsView';
import PerformanceView from '../../components/PerformanceView';
import PlanPicker from '../../components/PlanPicker';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { IconSelect, Select } from '../../components/ui/Field';
import { useAuth } from '../../context/AuthContext';
import { PERIODS } from '../../lib/labels';
import { formatMoney, hostingPriceLabel, priceLabel } from '../../lib/money';
import { riskOf } from '../../lib/risk';
import { openCheckout } from '../../lib/stripe';
import { apiError, cn } from '../../lib/utils';

function SubscribeBox({ listing }: { listing: PublicListing }) {
    const { user } = useAuth();
    const [me, setMe] = useState<Me | null>(null);
    const [done, setDone] = useState<Subscription | null>(null);
    const [sending, setSending] = useState(false);
    const [planId, setPlanId] = useState<number | null>(listing.plans[0]?.id ?? null);
    const next = encodeURIComponent(`/marketplace/${listing.slug}`);

    useEffect(() => {
        if (user) api.get<Me>('/me').then(res => setMe(res.data)).catch(e => console.error(e));
    }, [user]);

    // The MT5 account comes after paying, on the license: buying never waits on looking it up
    const subscribe = async () => {
        setSending(true);
        try {
            const res = await api.post<Subscription>(`/api/marketplace/${listing.slug}/subscribe`,
                listing.pay_online ? { plan_id: planId } : {});
            if (res.data.listing.pay_online) {
                await openCheckout(res.data.id); // Stripe's page; paying approves the request by itself
                return;
            }
            setDone(res.data);
            if (res.data.listing.checkout_url) window.open(res.data.listing.checkout_url, '_blank', 'noopener,noreferrer');
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível enviar o pedido.'));
        } finally {
            setSending(false);
        }
    };

    if (!user) {
        return (
            <div className="space-y-2">
                <Link to={`/cadastro?next=${next}`} className="block"><Button size="lg" className="w-full">Copiar esta estratégia <ArrowRight /></Button></Link>
                <Link to={`/login?next=${next}`} className="block"><Button variant="ghost" className="w-full">Já tenho conta</Button></Link>
            </div>
        );
    }
    if (user.role !== 'CLIENT') {
        return <p className="text-sm text-muted-foreground">Entre com uma conta de cliente para assinar.</p>;
    }
    if (done) {
        return (
            <div className="space-y-3 text-sm">
                <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                    Pedido enviado. {done.listing.checkout_url ? 'Pague na página do gestor, aberta numa nova aba' : 'O gestor envia como pagar'}:
                    ele libera a cópia, e você a ativa em Minhas cópias.</p>
                {done.listing.checkout_url && (
                    <a href={done.listing.checkout_url} target="_blank" rel="noopener noreferrer" className="block">
                        <Button className="w-full"><ExternalLink /> Pagar</Button>
                    </a>
                )}
                {me?.email_enabled && !me.email_verified && (
                    <p className="flex items-start gap-2 text-muted-foreground"><MailCheck className="mt-0.5 size-4 shrink-0 text-warning" />
                        Confirme seu email pelo link na caixa de entrada: ele é pedido para conectar a conta.</p>
                )}
                <Link to="/client" className="block text-center font-medium text-primary underline-offset-4 hover:underline">Ir para Minhas cópias</Link>
            </div>
        );
    }
    return (
        <div className="space-y-3">
            {listing.pay_online && <PlanPicker plans={listing.plans} value={planId} onChange={setPlanId} />}
            <Button size="lg" className="w-full" loading={sending} disabled={listing.pay_online && planId == null} onClick={subscribe}>
                Copiar esta estratégia {!sending && <ArrowRight />}
            </Button>
            {listing.pay_online && (
                <p className="text-center text-xs text-muted-foreground">Pagamento seguro no cartão pela Stripe. Renova sozinho; troque de plano ou cancele quando quiser, em Pagamentos.</p>
            )}
        </div>
    );
}

const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

// The numbers that sell, above the fold: the same 90 days as the catalog card
function Headline({ listing }: { listing: PublicListing }) {
    const { return_pct, max_drawdown_pct, trades, curve } = listing.stats;
    const risk = riskOf(max_drawdown_pct);
    return (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            {risk && (
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={risk.variant}>Risco {risk.label.toLowerCase()}</Badge> {risk.hint}.
                </p>
            )}
            <dl className="grid grid-cols-3 gap-3">
                <div>
                    <dt className="text-xs text-muted-foreground">Retorno 90 dias</dt>
                    <dd className={cn('text-2xl font-bold sm:text-3xl', (return_pct ?? 0) > 0 && 'text-success', (return_pct ?? 0) < 0 && 'text-destructive')}>
                        {pct(return_pct)}
                    </dd>
                </div>
                <div>
                    <dt className="text-xs text-muted-foreground">Maior queda</dt>
                    <dd className="text-2xl font-bold sm:text-3xl">{max_drawdown_pct == null ? '—' : pct(-max_drawdown_pct)}</dd>
                </div>
                <div>
                    <dt className="text-xs text-muted-foreground">Operações</dt>
                    <dd className="text-2xl font-bold sm:text-3xl">{trades}</dd>
                </div>
            </dl>
            <Sparkline values={curve} label={`Resultado acumulado de ${listing.title} em 90 dias`} height={72} />
        </div>
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
    // The bar at the bottom of a phone hides while the subscribe box itself is on screen
    const box = useRef<HTMLElement>(null);
    const [boxVisible, setBoxVisible] = useState(false);

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

    useEffect(() => {
        const el = box.current;
        if (!el) return;
        const observer = new IntersectionObserver(([entry]) => setBoxVisible(entry.isIntersecting));
        observer.observe(el);
        return () => observer.disconnect();
    }, [listing]);

    if (missing) {
        return (
            <div className="panel">
                <EmptyState icon={<Store />} title="Portfólio não encontrado" description="Ele pode ter saído do marketplace." />
            </div>
        );
    }
    if (!listing) return <p className="text-sm text-muted-foreground">Carregando...</p>;

    return (
        <div className="space-y-8 pb-20 lg:pb-0">
            <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> Marketplace
            </Link>
            <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-3">
                <div className="space-y-4 lg:col-span-2">
                    <div className="flex flex-wrap gap-1">{listing.markets.map(m => <Badge key={m} variant="primary">{m}</Badge>)}</div>
                    <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{listing.title}</h1>
                    <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm text-muted-foreground">por <span className="font-medium text-foreground">{listing.manager.name}</span></p>
                        <div className="md:hidden"><AboutAuthor manager={listing.manager} /></div>
                    </div>
                    {listing.summary && <p className="text-base text-muted-foreground sm:text-lg">{listing.summary}</p>}
                    {listing.manager.bio && (
                        <p className="line-clamp-3 border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">{listing.manager.bio}</p>
                    )}
                    <Headline listing={listing} />
                    {(listing.description || listing.strategies.length > 0 || listing.manager.bio) && (
                        <details className="group rounded-lg border border-border bg-card">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-medium">
                                Sobre a estratégia e o gestor
                                <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="space-y-4 border-t border-border p-4">
                                {listing.description && <p className="whitespace-pre-line text-sm leading-relaxed">{listing.description}</p>}
                                {listing.strategies.length > 0 && (
                                    <p className="text-sm text-muted-foreground">Estratégias: {listing.strategies.join(', ')}</p>
                                )}
                                <div className="hidden space-y-3 md:block">
                                    <div>
                                        <p className="text-xs uppercase tracking-wider text-muted-foreground">Gestor</p>
                                        <p className="mt-1 font-semibold">{listing.manager.name}</p>
                                        {listing.manager.bio && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{listing.manager.bio}</p>}
                                    </div>
                                    <AuthorLinks manager={listing.manager} />
                                </div>
                            </div>
                        </details>
                    )}
                </div>
                <aside ref={box} id="assinar" className="panel scroll-mt-24 space-y-4 p-5 lg:sticky lg:top-24">
                    <p className="text-2xl font-bold">{priceLabel(listing)}</p>
                    <dl className="space-y-1 text-sm">
                        {listing.min_capital != null && (
                            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Capital recomendado</dt>
                                <dd>{formatMoney(listing.min_capital, listing.currency)}</dd></div>
                        )}
                        {!listing.hosting_price && (
                            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Como copia</dt>
                                <dd>{listing.hosting_allowed ? 'Nuvem ou seu computador' : 'EA no seu computador'}</dd></div>
                        )}
                    </dl>
                    {listing.hosting_price && (
                        <p className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
                            <Cloud className="mt-0.5 size-4 shrink-0 text-primary" />
                            <span>
                                <strong>Sem instalar nada:</strong> + {hostingPriceLabel(listing.hosting_price)} para rodar na nossa nuvem,
                                com o computador desligado. Opcional: você escolhe depois de assinar.
                            </span>
                        </p>
                    )}
                    <SubscribeBox listing={listing} />
                    <p className="text-xs text-muted-foreground">Resultados passados não garantem resultados futuros. Operar envolve risco de perda.</p>
                </aside>
            </div>

            <div className={cn('fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 py-3 backdrop-blur transition-transform lg:hidden', boxVisible && 'translate-y-full')}>
                <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
                    <p className="min-w-0 truncate font-semibold">{priceLabel(listing)}</p>
                    <Button onClick={() => box.current?.scrollIntoView({ behavior: 'smooth' })}>Copiar esta estratégia <ArrowRight /></Button>
                </div>
            </div>

            <section className="space-y-4">
                <div className="flex items-start justify-between gap-3 sm:items-center">
                    <div>
                        <h2 className="text-xl font-semibold">Desempenho real</h2>
                        <p className="text-sm text-muted-foreground">As operações fechadas na conta do gestor, no tamanho dele.</p>
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
