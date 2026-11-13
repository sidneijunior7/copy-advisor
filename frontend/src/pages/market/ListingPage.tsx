import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CalendarDays, CheckCircle2, ChevronDown, Cloud, Lock, Store, Ticket, Users } from 'lucide-react';
import api, {
    type BacktestView, type ClientLicense, type MyLicenses, type PortfolioPerformance, type PublicFollowerStats, type PublicListing,
} from '../../api';
import AboutAuthor, { AuthorLinks } from '../../components/AboutAuthor';
import BacktestSection from '../../components/BacktestSection';
import Sparkline from '../../components/charts/Sparkline';
import EmptyState from '../../components/EmptyState';
import FollowerStatsView from '../../components/FollowerStatsView';
import SellerInfo from '../../components/market/SellerInfo';
import PerformanceView from '../../components/PerformanceView';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { IconSelect, Input, Select } from '../../components/ui/Field';
import { useAuth } from '../../context/AuthContext';
import { PERIODS } from '../../lib/labels';
import { formatMoney, hostingPriceLabel, priceLabel } from '../../lib/money';
import { riskOf } from '../../lib/risk';
import { track } from '../../lib/track';
import { cn } from '../../lib/utils';
import { Skeleton } from './checkout/parts';

// The checkout's address, carrying a campaign's launch code when the visitor came with one
const checkoutHref = (slug: string, code: string) => `/assinar/${slug}${code ? `?codigo=${encodeURIComponent(code)}` : ''}`;

// A launch code typed here goes to the checkout, which makes the account and asks about the risk before using it
function CodeEntry({ slug }: { slug: string }) {
    const navigate = useNavigate();
    const [code, setCode] = useState('');
    const go = (e: FormEvent) => {
        e.preventDefault();
        if (code.trim()) navigate(checkoutHref(slug, code.trim()));
    };
    return (
        <form onSubmit={go} className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3" noValidate>
            <label htmlFor="promo-code" className="flex items-center gap-2 text-sm font-medium"><Ticket className="size-4 text-primary" /> Código de lançamento</label>
            <div className="flex gap-2">
                <Input id="promo-code" value={code} onChange={e => setCode(e.target.value)} placeholder="Digite o código"
                    className="font-mono uppercase" autoComplete="off" />
                <Button variant="outline" disabled={!code.trim()}>Usar</Button>
            </div>
            <p className="text-xs text-muted-foreground">Grátis por tempo limitado, sem cartão. Os dias começam quando você conecta sua conta MT5.</p>
        </form>
    );
}

// Next to the button that sells: the payment, the cancelling and who else copies
function Trust({ listing, copiers }: { listing: PublicListing; copiers: string | null }) {
    return (
        <ul className="space-y-1 text-xs text-muted-foreground">
            {listing.pay_online && <li className="flex items-center gap-1.5"><Lock className="size-3.5" /> Pagamento seguro pela Stripe. Cancele quando quiser, sem multa.</li>}
            {copiers && <li className="flex items-center gap-1.5"><Users className="size-3.5" /> {copiers}</li>}
        </ul>
    );
}

function SubscribeBox({ listing, copiers }: { listing: PublicListing; copiers: string | null }) {
    const { user } = useAuth();
    const [params] = useSearchParams();
    const urlCode = params.get('codigo')?.trim() ?? ''; // From a campaign's link
    const [mine, setMine] = useState<ClientLicense | null>(null); // A license of this portfolio the client has already
    const [codeOpen, setCodeOpen] = useState(false);
    const href = checkoutHref(listing.slug, urlCode);

    useEffect(() => {
        if (user?.role !== 'CLIENT') return;
        api.get<MyLicenses>('/me/licenses')
            .then(res => setMine(res.data.licenses.find(l => l.listing_slug === listing.slug) ?? null))
            .catch(e => console.error(e));
    }, [user, listing.slug]);

    if (user && user.role !== 'CLIENT') {
        return <p className="text-sm text-muted-foreground">Entre com uma conta de cliente para assinar.</p>;
    }
    if (mine) {
        return (
            <div className="space-y-2">
                <p className="flex items-start gap-2 text-sm"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                    Você já tem este portfólio{mine.mt5_login != null ? ` na conta ${mine.mt5_login}` : ''}.</p>
                <Link to={`/client/licenses/${mine.id}`} className="block"><Button size="lg" className="w-full">Ver minha cópia <ArrowRight /></Button></Link>
                <Link to={href} className="block"><Button variant="ghost" className="w-full">Assinar para outra conta MT5</Button></Link>
            </div>
        );
    }
    if (urlCode && listing.has_promo) {
        return (
            <div className="space-y-2.5">
                <p className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                    <Ticket className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>Você tem o código <strong className="font-mono">{urlCode.toUpperCase()}</strong>: copie grátis, sem cartão.</span>
                </p>
                <Link to={href} className="block"><Button size="lg" className="w-full">Ativar com o código <ArrowRight /></Button></Link>
                <p className="text-center text-xs text-muted-foreground">Leva 1 minuto: seu email, uma senha e o CPF.</p>
            </div>
        );
    }
    return (
        <div className="space-y-3">
            <Link to={href} className="block"><Button size="lg" className="w-full">Simular meu plano <ArrowRight /></Button></Link>
            <p className="text-center text-xs text-muted-foreground">Faça sua simulação antes de criar sua conta.</p>
            <Trust listing={listing} copiers={copiers} />
            {listing.has_promo && (codeOpen
                ? <CodeEntry slug={listing.slug} />
                : <Button variant="ghost" className="w-full" onClick={() => setCodeOpen(true)}><Ticket /> Tenho um código de lançamento</Button>)}
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
    const [params] = useSearchParams();
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
        if (slug) track('listing_view', { slug });
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
                <EmptyState icon={<Store />} title="Portfólio não encontrado" description="Ele pode ter saído do ar." />
            </div>
        );
    }
    if (!listing) {
        return (
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3" aria-busy="true" aria-label="Carregando o portfólio">
                <div className="space-y-4 lg:col-span-2">
                    <Skeleton className="h-5 w-24" /><Skeleton className="h-9 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-40" />
                </div>
                <Skeleton className="h-72" />
            </div>
        );
    }
    const href = checkoutHref(listing.slug, params.get('codigo')?.trim() ?? '');
    const periodName = PERIODS.find(p => p.days === days)?.label.toLowerCase();
    const copiers = followers?.enough && followers.followers
        ? `${followers.followers.toLocaleString('pt-BR')} ${followers.followers === 1 ? 'conta copiou' : 'contas copiaram'}${periodName ? ` (${periodName})` : ''}`
        : null;

    return (
        <div className="space-y-8 pb-20 lg:pb-0">
            <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> Portfólios
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
                        <p className="line-clamp-3 border-l-2 md:hidden border-primary/40 pl-3 text-sm text-muted-foreground">{listing.manager.bio}</p>
                    )}
                    <Headline listing={listing} />
                    {(listing.description || listing.strategies.length > 0 || listing.manager.bio) && (
                        <details className="group rounded-lg border border-border bg-card">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-medium">
                                Sobre a estratégia e o trader
                                <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="space-y-4 border-t border-border p-4">
                                {listing.description && <p className="whitespace-pre-line text-sm leading-relaxed">{listing.description}</p>}
                                {listing.strategies.length > 0 && (
                                    <p className="text-sm text-muted-foreground">Estratégias: {listing.strategies.join(', ')}</p>
                                )}
                                <div className="hidden space-y-3 md:block">
                                    <div>
                                        <p className="text-xs uppercase tracking-wider text-muted-foreground">Trader</p>
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
                                <dd>{listing.hosting_allowed && listing.hosting_room ? 'Nuvem ou seu computador' : 'EA no seu computador'}</dd></div>
                        )}
                    </dl>
                    {listing.hosting_price && (
                        <p className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
                            <Cloud className="mt-0.5 size-4 shrink-0 text-primary" />
                            <span>
                                <strong>Sem instalar nada:</strong> + {hostingPriceLabel(listing.hosting_price)} para rodar na nossa nuvem,
                                com o computador desligado. Você escolhe na assinatura e paga à parte, quando conectar a conta.
                            </span>
                        </p>
                    )}
                    <SubscribeBox listing={listing} copiers={copiers} />
                    <SellerInfo seller={listing.seller} fallbackName={listing.manager.name} className="border-t border-border pt-4" />
                    <p className="text-xs text-muted-foreground">Resultados passados não garantem resultados futuros. Operar envolve risco de perda.</p>
                </aside>
            </div>

            <div className={cn('fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 py-3 backdrop-blur transition-transform lg:hidden', boxVisible && 'translate-y-full')}>
                <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
                    <p className="min-w-0 truncate font-semibold">{priceLabel(listing)}</p>
                    <Link to={href}><Button>{params.get('codigo') && listing.has_promo ? 'Ativar com o código' : 'Simular meu plano'} <ArrowRight /></Button></Link>
                </div>
            </div>

            <section className="space-y-4">
                <div className="flex items-start justify-between gap-3 sm:items-center">
                    <div>
                        <h2 className="text-xl font-semibold">Desempenho real</h2>
                        <p className="text-sm text-muted-foreground">As operações fechadas na conta do trader, no tamanho dele.</p>
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
                            emptyDescription="Escolha um período maior, ou volte quando o trader fechar as primeiras operações." />
                    </div>
                )}
            </section>

            {backtestView?.available && (
                <section className="space-y-4">
                    <div>
                        <h2 className="text-xl font-semibold">Backtest e resultado ao vivo</h2>
                        <p className="text-sm text-muted-foreground">O que o trader testou antes de operar, e se a conta real está se comportando como o teste previa.</p>
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
