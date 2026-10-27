import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    Activity,
    ArrowRight,
    BarChart3,
    Calendar,
    ChevronRight,
    Layers,
    Pause,
    Play,
    Radio,
    RefreshCw,
    ShieldAlert,
    Sparkles,
    Store,
    Ticket,
    TrendingDown,
    TrendingUp,
} from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientDashboardData, type ClientLicense, type MyLicenses } from '../../api';
import Card from '../../components/Card';
import LineChart from '../../components/charts/LineChart';
import Sparkline from '../../components/charts/Sparkline';
import CopyToggle from '../../components/client/CopyToggle';
import { HostingOfferList } from '../../components/client/HostingOffer';
import NextSteps from '../../components/client/NextSteps';
import KPICard from '../../components/KPICard';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { copyState, hostingCandidates } from '../../lib/clientLicense';
import { formatMoney, priceLabel } from '../../lib/money';
import { apiError, cn, formatDate } from '../../lib/utils';

const POLL_MS = 15_000;

export default function ClientDashboard() {
    const [data, setData] = useState<ClientDashboardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [days, setDays] = useState(30);
    const [reload, setReload] = useState(0);
    const [claimCode, setClaimCode] = useState('');
    const [claiming, setClaiming] = useState(false);
    const [masterPausing, setMasterPausing] = useState(false);
    // How each license copies right now (the hub, the hosting): the dashboard's own figures do not say
    const [mine, setMine] = useState<MyLicenses | null>(null);

    useEffect(() => {
        let active = true;
        const load = () => {
            api.get<ClientDashboardData>('/me/dashboard', { params: { days } })
                .then(res => {
                    if (active) {
                        setData(res.data);
                        setFailed(false);
                    }
                })
                .catch(err => {
                    console.error(err);
                    if (active) setFailed(true);
                })
                .finally(() => {
                    if (active) setLoading(false);
                });
        };

        const loadLicenses = () => {
            api.get<MyLicenses>('/me/licenses')
                .then(res => { if (active) setMine(res.data); })
                .catch(err => console.error(err));
        };

        load();
        loadLicenses();
        const timer = window.setInterval(() => { load(); loadLicenses(); }, POLL_MS);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [days, reload]);

    const refresh = () => {
        setReload(n => n + 1);
    };

    const handleClaim = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!claimCode.trim() || claiming) return;
        setClaiming(true);
        try {
            const res = await api.post<ClientLicense>('/me/licenses/claim', { code: claimCode.trim() });
            toast.success(`Portfólio ${res.data.portfolio.name ?? ''} ativado!`, {
                description: `Conta MT5 ${res.data.mt5_login ?? 'conectada'}.`,
            });
            setClaimCode('');
            refresh();
        } catch (err) {
            toast.error(apiError(err, 'Código inválido ou expirado.'));
        } finally {
            setClaiming(false);
        }
    };

    const handleMasterToggle = async () => {
        if (!data || masterPausing) return;
        const targetPause = !data.all_paused;
        setMasterPausing(true);
        try {
            const res = await api.post<{ paused: boolean; count: number }>('/me/licenses/pause-all', {
                paused: targetPause,
            });
            if (targetPause) {
                toast.warning('Todas as cópias foram pausadas', {
                    description: `Pausa suave em ${res.data.count} portfólios. Novas ordens não serão abertas.`,
                });
            } else {
                toast.success('Todas as cópias foram retomadas', {
                    description: `${res.data.count} portfólios voltaram a copiar em tempo real.`,
                });
            }
            refresh();
        } catch (err) {
            toast.error(apiError(err, 'Não foi possível alterar o estado geral.'));
        } finally {
            setMasterPausing(false);
        }
    };

    if (loading && !data) {
        return (
            <div className="space-y-6">
                <PageHeader
                    title="Início"
                    description="Carregando métricas e desempenho da sua conta..."
                    icon={<Activity />}
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="panel h-28 animate-pulse p-4" />
                    ))}
                </div>
            </div>
        );
    }

    if (failed && !data) {
        return (
            <div className="space-y-6">
                <PageHeader title="Início" description="Visão geral do assinante" icon={<Activity />} />
                <div className="panel p-8 text-center">
                    <ShieldAlert className="mx-auto size-10 text-destructive mb-3" />
                    <h3 className="text-lg font-semibold">Não foi possível carregar o painel</h3>
                    <p className="mt-1 text-sm text-muted-foreground">Verifique sua conexão ou tente novamente.</p>
                    <Button onClick={refresh} className="mt-4" variant="outline">
                        <RefreshCw className="size-4" /> Tentar novamente
                    </Button>
                </div>
            </div>
        );
    }

    // Lead View: no active licenses yet
    if (data?.is_lead) {
        return (
            <div className="space-y-8 animate-fade-in">
                {/* Hero Onboarding Card */}
                <div className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card p-6 sm:p-8 shadow-card">
                    <div className="max-w-2xl space-y-3">
                        <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                            <Sparkles className="size-3.5" /> Bem-vindo à Trademetric
                        </div>
                        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                            Escolha um gestor para copiar na sua conta
                        </h1>
                        <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
                            Quando o gestor opera, a mesma ordem é feita no seu MetaTrader 5, no tamanho que você definir.
                            Você acompanha tudo aqui e pausa quando quiser.
                        </p>
                        <div className="flex flex-wrap gap-3 pt-2">
                            <Link to="/marketplace" className="w-full sm:w-auto">
                                <Button size="lg" className="w-full shadow-lg shadow-primary/20">
                                    <Store className="size-4" /> Ver gestores
                                </Button>
                            </Link>
                        </div>
                    </div>
                </div>

                {/* Claim Access Code Section */}
                <Card
                    title="Recebeu um código de acesso?"
                    description="Se você assinou direto com um gestor, fora do Marketplace, informe o código que ele enviou."
                    icon={<Ticket />}
                >
                    <form onSubmit={handleClaim} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
                        <div className="flex-1 space-y-1">
                            <Input
                                value={claimCode}
                                onChange={e => setClaimCode(e.target.value.toUpperCase())}
                                placeholder="Ex.: ABCD-EFGH-JKLM"
                                className="font-mono uppercase tracking-wider"
                                autoComplete="off"
                                aria-label="Código de acesso"
                            />
                        </div>
                        <Button type="submit" loading={claiming} disabled={!claimCode.trim()}>
                            {!claiming && <Ticket />} Adicionar
                        </Button>
                    </form>
                </Card>

                {/* Lead Marketplace Highlights */}
                {data.lead_highlights.length > 0 && (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-xl font-bold tracking-tight">Portfólios em Destaque</h2>
                                <p className="text-xs text-muted-foreground">O resultado real dos últimos 90 dias</p>
                            </div>
                            <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                                Ver todos <ArrowRight className="size-4" />
                            </Link>
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            {data.lead_highlights.map(l => (
                                <Link
                                    key={l.slug}
                                    to={`/marketplace/${l.slug}`}
                                    className="panel group flex flex-col p-5 transition-all hover:border-primary/50 hover:shadow-glow"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="flex flex-wrap gap-1">
                                            {l.markets.slice(0, 2).map(m => (
                                                <Badge key={m} variant="primary" className="text-[10px]">{m}</Badge>
                                            ))}
                                        </div>
                                    </div>
                                    <h3 className="mt-3 text-base font-semibold leading-tight line-clamp-1">{l.title}</h3>
                                    <p className="text-xs text-muted-foreground">por {l.manager.name}</p>

                                    <div className="my-3 space-y-2 border-y border-border py-2 text-xs">
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Retorno 90d</span>
                                            <span className={cn('font-semibold', (l.stats.return_pct ?? 0) >= 0 ? 'text-success' : 'text-destructive')}>
                                                {(l.stats.return_pct ?? 0) > 0 ? '+' : ''}{l.stats.return_pct?.toFixed(1) ?? '—'}%
                                            </span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Maior queda</span>
                                            <span className="font-semibold">{l.stats.max_drawdown_pct ? `-${l.stats.max_drawdown_pct.toFixed(1)}%` : '—'}</span>
                                        </div>
                                    </div>

                                    <Sparkline values={l.stats.curve} label={`Resultado de ${l.title}`} height={36} />

                                    <div className="mt-auto pt-3 flex items-center justify-between text-xs">
                                        <span className="font-medium">{priceLabel(l)}</span>
                                        <span className="inline-flex items-center gap-0.5 text-primary font-semibold group-hover:translate-x-0.5 transition-transform">
                                            Ver <ChevronRight className="size-3.5" />
                                        </span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    const {
        profit_today,
        trades_today,
        profit_week,
        trades_week,
        profit_month,
        trades_month,
        currency,
        curve,
        running_today,
        traders,
        all_paused,
    } = data!;

    const activeTraders = traders.filter(t => t.valid && !t.is_paused);
    const totalOpenPositions = traders.reduce((acc, t) => acc + t.open_positions, 0);

    // Chart points
    const chartSeries = curve.length > 0 ? [{
        key: 'cumulative',
        label: 'Lucro acumulado',
        color: 'var(--viz-series-1)',
        points: curve.map(p => ({
            t: new Date(p.t).getTime(),
            v: p.v,
        })),
    }] : [];

    return (
        <div className="space-y-6 sm:space-y-8 animate-fade-in">
            {/* Header with Title & Master Controls */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Início</h1>
                    <p className="text-sm text-muted-foreground">
                        Acompanhe seus lucros em tempo real e gerencie suas cópias com um clique.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                    {/* Master On/Off Toggle Button */}
                    {traders.length > 0 && (
                        <Button
                            variant={all_paused ? 'default' : 'outline'}
                            onClick={handleMasterToggle}
                            loading={masterPausing}
                            className={cn(
                                'h-9 text-xs font-semibold transition-all',
                                all_paused
                                    ? 'bg-success hover:bg-success/90 text-success-foreground'
                                    : 'border-warning/50 text-warning hover:bg-warning/10',
                            )}
                        >
                            {!masterPausing && (all_paused ? <Play className="size-3.5 fill-current" /> : <Pause className="size-3.5 fill-current" />)}
                            {all_paused ? 'Retomar Todas as Cópias' : 'Pausar Tudo'}
                        </Button>
                    )}

                    <Button variant="ghost" size="icon" onClick={refresh} title="Atualizar dados agora" className="size-9">
                        <RefreshCw className="size-4" />
                    </Button>
                </div>
            </div>

            {/* What still keeps a license from copying, first: the dashboard is where the client looks */}
            {mine && <NextSteps licenses={mine.licenses} />}

            {/* Hosting upsell: while some license copies from the client's own computer */}
            {mine?.hosting_price && <HostingOfferList price={mine.hosting_price} licenses={hostingCandidates(mine)} dismissible />}

            {/* Top KPI Cards Row */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KPICard
                    label="Lucro Hoje"
                    value={
                        <span className={cn(profit_today > 0 && 'text-success', profit_today < 0 && 'text-destructive')}>
                            {profit_today > 0 ? '+' : ''}{formatMoney(profit_today, currency)}
                        </span>
                    }
                    subValue={`${trades_today} ${trades_today === 1 ? 'operação fechada' : 'operações fechadas'} hoje`}
                    icon={profit_today >= 0 ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
                />

                <KPICard
                    label="Lucro na Semana (7d)"
                    value={
                        <span className={cn(profit_week > 0 && 'text-success', profit_week < 0 && 'text-destructive')}>
                            {profit_week > 0 ? '+' : ''}{formatMoney(profit_week, currency)}
                        </span>
                    }
                    subValue={`${trades_week} ${trades_week === 1 ? 'operação' : 'operações'} no período`}
                    icon={<Calendar className="size-4" />}
                />

                <KPICard
                    label="Lucro no Mês (30d)"
                    value={
                        <span className={cn(profit_month > 0 && 'text-success', profit_month < 0 && 'text-destructive')}>
                            {profit_month > 0 ? '+' : ''}{formatMoney(profit_month, currency)}
                        </span>
                    }
                    subValue={`${trades_month} ${trades_month === 1 ? 'operação' : 'operações'} no período`}
                    icon={<BarChart3 className="size-4" />}
                />

                <KPICard
                    label="Status da Conta"
                    value={
                        <span className="inline-flex items-center gap-2">
                            <span className={cn('size-2.5 rounded-full', activeTraders.length > 0 ? 'bg-success animate-pulse' : 'bg-muted-foreground')} />
                            {activeTraders.length} de {traders.length} ativos
                        </span>
                    }
                    subValue={
                        totalOpenPositions > 0
                            ? `${totalOpenPositions} ${totalOpenPositions === 1 ? 'ordem aberta agora' : 'ordens abertas agora'}`
                            : 'Nenhuma ordem aberta no momento'
                    }
                    icon={<Radio className="size-4" />}
                />
            </div>

            {/* Middle Section: Cumulative Chart & Running Strategies */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                {/* Mini Gráfico de Lucro Acumulado */}
                <div className="panel lg:col-span-2 p-5 sm:p-6 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-lg font-semibold tracking-tight">Lucro Acumulado na Conta</h2>
                            <p className="text-xs text-muted-foreground">Evolução do saldo fechado pelo Copy</p>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-muted-foreground">Janela:</span>
                            {[7, 30, 90].map(d => (
                                <button
                                    key={d}
                                    type="button"
                                    onClick={() => setDays(d)}
                                    className={cn(
                                        'rounded-md px-2.5 py-1 font-medium transition-colors',
                                        days === d
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-muted/50 text-muted-foreground hover:bg-muted',
                                    )}
                                >
                                    {d}d
                                </button>
                            ))}
                        </div>
                    </div>

                    {chartSeries.length > 0 ? (
                        <div className="pt-2">
                            <LineChart
                                series={chartSeries}
                                ariaLabel="Gráfico de Lucro Acumulado"
                                formatValue={v => formatMoney(v, currency)}
                                formatTime={t => formatDate(t)}
                                height={240}
                                zeroLine
                                area
                            />
                        </div>
                    ) : (
                        <div className="flex h-56 flex-col items-center justify-center text-center p-4">
                            <BarChart3 className="size-8 text-muted-foreground/50 mb-2" />
                            <p className="text-sm font-medium text-muted-foreground">Sem operações fechadas neste período</p>
                            <p className="text-xs text-muted-foreground/70">O gráfico se formará conforme suas cópias forem finalizadas.</p>
                        </div>
                    )}
                </div>

                {/* Estratégias Rodando Hoje */}
                <div className="panel p-5 sm:p-6 space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-lg font-semibold tracking-tight">Estratégias Hoje</h2>
                            <p className="text-xs text-muted-foreground">As estratégias dos gestores que você copia</p>
                        </div>
                        <Badge variant="primary" className="text-xs">{running_today.length}</Badge>
                    </div>

                    {running_today.length === 0 ? (
                        <div className="flex h-48 flex-col items-center justify-center text-center p-4">
                            <Layers className="size-8 text-muted-foreground/50 mb-2" />
                            <p className="text-xs text-muted-foreground">Nenhuma estratégia configurada ainda.</p>
                        </div>
                    ) : (
                        <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1 scrollbar-none">
                            {running_today.map((s, idx) => {
                                const isOperating = s.open_positions > 0 || s.trades_today > 0;
                                return (
                                    <div
                                        key={`${s.license_id}-${s.magic_number ?? idx}`}
                                        className="rounded-lg border border-border bg-card/60 p-3 text-sm transition-colors hover:border-primary/30"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="font-semibold truncate">{s.strategy_name}</p>
                                                <p className="text-[11px] text-muted-foreground truncate">
                                                    {s.portfolio_name} {s.manager_name ? `· ${s.manager_name}` : ''}
                                                </p>
                                            </div>
                                            <Badge
                                                variant={s.is_paused ? 'warning' : isOperating ? 'success' : 'muted'}
                                                className="text-[10px]"
                                            >
                                                {s.status}
                                            </Badge>
                                        </div>

                                        <div className="mt-2.5 flex items-center justify-between text-xs text-muted-foreground border-t border-border/50 pt-2">
                                            <span>Hoje: <strong>{s.trades_today} op.</strong></span>
                                            <span className={cn('font-mono font-medium', s.profit_today > 0 && 'text-success', s.profit_today < 0 && 'text-destructive')}>
                                                {s.profit_today !== 0 ? `${s.profit_today > 0 ? '+' : ''}${formatMoney(s.profit_today, currency)}` : '0,00'}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Bottom Section: Trader Cards with Individual On/Off Controls */}
            <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                        <h2 className="text-xl font-bold tracking-tight">Quem você copia</h2>
                        <p className="text-xs text-muted-foreground">
                            Ligue ou desligue a cópia individualmente. A pausa suave permite que posições abertas fechem normalmente.
                        </p>
                    </div>

                    <Link to="/client/licenses" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                        Minhas cópias <ChevronRight className="size-3.5" />
                    </Link>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {traders.map(t => (
                        <div
                            key={t.license_id}
                            className={cn(
                                'panel p-5 transition-all space-y-4',
                                t.is_paused ? 'opacity-85 border-warning/30' : 'hover:border-primary/40',
                            )}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h3 className="text-base font-semibold truncate leading-tight">{t.portfolio_name}</h3>
                                    {t.manager_name && (
                                        <p className="text-xs text-muted-foreground">por {t.manager_name}</p>
                                    )}
                                </div>

                                <CopyToggle
                                    licenseId={t.license_id}
                                    isPaused={t.is_paused}
                                    disabled={!t.valid}
                                    traderName={t.portfolio_name}
                                    onChanged={refresh}
                                    size="md"
                                    showLabel={false}
                                />
                            </div>

                            <div className="flex items-center gap-2">
                                {(() => {
                                    const lic = mine?.licenses.find(l => l.id === t.license_id);
                                    const state = lic ? copyState(lic) : null;
                                    return (
                                        <Badge variant={state?.variant ?? (t.is_paused ? 'warning' : 'muted')} className="text-xs">
                                            {state?.label ?? (t.is_paused ? 'Pausado' : '…')}
                                        </Badge>
                                    );
                                })()}
                                {t.mt5_login && (
                                    <span className="font-mono text-xs text-muted-foreground">
                                        Conta MT5: {t.mt5_login}
                                    </span>
                                )}
                            </div>

                            <div className="grid grid-cols-3 gap-2 rounded-lg bg-card/40 p-2.5 text-center border border-border/50 text-xs">
                                <div>
                                    <span className="text-[10px] text-muted-foreground block">Hoje</span>
                                    <span className={cn('font-mono font-medium', t.profit_today > 0 && 'text-success', t.profit_today < 0 && 'text-destructive')}>
                                        {t.profit_today > 0 ? '+' : ''}{formatMoney(t.profit_today, currency)}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-[10px] text-muted-foreground block">7 dias</span>
                                    <span className={cn('font-mono font-medium', t.profit_week > 0 && 'text-success', t.profit_week < 0 && 'text-destructive')}>
                                        {t.profit_week > 0 ? '+' : ''}{formatMoney(t.profit_week, currency)}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-[10px] text-muted-foreground block">30 dias</span>
                                    <span className={cn('font-mono font-medium', t.profit_month > 0 && 'text-success', t.profit_month < 0 && 'text-destructive')}>
                                        {t.profit_month > 0 ? '+' : ''}{formatMoney(t.profit_month, currency)}
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center justify-between text-xs pt-1 border-t border-border">
                                <span className="text-muted-foreground">
                                    {t.open_positions > 0 ? `${t.open_positions} posições abertas` : 'Sem posições abertas'}
                                </span>
                                <Link
                                    to={`/client/licenses/${t.license_id}`}
                                    className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
                                >
                                    Ver detalhes <ArrowRight className="size-3.5" />
                                </Link>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
