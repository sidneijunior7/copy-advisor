import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
    AlertTriangle, ArrowLeft, ArrowRight, Building2, Check, CheckCircle2, Cloud, CreditCard,
    Eye, EyeOff, Lock, Mail, Minus, Monitor, Pencil, Plus, ShieldAlert, Sparkles, Store,
    Ticket, TrendingUp, User as UserIcon, Wallet, Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import api, {
    type BrokerChoice, type ClientLicense, type HostingPrice, type Me, type PortfolioSimulation,
    type PublicListing, type SimulationStep, type Subscription,
} from '../../api';
import ColumnChart from '../../components/charts/ColumnChart';
import EmptyState from '../../components/EmptyState';
import ResendLinkButton from '../../components/ResendLinkButton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';
import { useAuth } from '../../context/AuthContext';
import { cleanCpf, formatCpf, isValidCpf } from '../../lib/cpf';
import { formatMonth } from '../../lib/labels';
import { formatMoney, hostingPriceLabel, periodLabel } from '../../lib/money';
import { riskOf } from '../../lib/risk';
import { openCheckout } from '../../lib/stripe';
import { apiError, cn } from '../../lib/utils';

type StepId =
    | 'contracts'
    | 'hosting'
    | 'broker'
    | 'email'
    | 'login_password'
    | 'name'
    | 'register_password'
    | 'cpf'
    | 'summary';

type AdvisorChoice = 'yes' | 'no' | 'unknown' | null;

const PASSWORD_MIN = 8;
const DEFAULT_HOSTING_PRICE: HostingPrice = { price: 9.99, currency: 'BRL', days: 30 };

const BROKER_OPTIONS: { id: BrokerChoice; name: string; tag: string; detail: string }[] = [
    { id: 'XP', name: 'XP Investimentos', tag: 'Homologada', detail: 'MetaTrader 5 integrado para B3' },
    { id: 'Clear', name: 'Clear Corretora', tag: 'Homologada', detail: 'Corretagem zero e execução rápida' },
    { id: 'Rico', name: 'Rico', tag: 'Homologada', detail: 'Plataforma MT5 pronta para cópia' },
    { id: 'Genial', name: 'Genial Investimentos', tag: 'Homologada', detail: 'Alta velocidade no mini-índice e dólar' },
    { id: 'none', name: 'Ainda não tenho conta', tag: 'Abrir depois', detail: 'Você pode abrir sua conta depois de garantir a assinatura' },
];

const MANUAL_INSTALL_STEPS = [
    'Instalar o MetaTrader 5 no seu computador ou contratar e configurar uma VPS Windows (recomendado)',
    'Baixar o arquivo do Replicador da Trademetric (Slave.ex5) e copiar para a pasta de dados do MT5',
    'Liberar manualmente permissões de WebRequest e negociação algorítmica no terminal',
    'Calibrar os parâmetros do replicador e colar a chave de licença no gráfico',
    'Testar a comunicação e validar a sincronização da cópia',
    'Autorizar a cópia em produção e manter o computador ou VPS ligado durante todo o pregão',
];

type SavedCheckoutState = {
    stepIndex?: number;
    wantsHosting?: boolean;
    broker?: BrokerChoice | null;
    advisorChoice?: AdvisorChoice;
    advisorName?: string;
    email?: string;
    name?: string;
    cpf?: string;
    customCapital?: number | null;
};

const storageKey = (slug: string) => `tdm-checkout-${slug}`;

function buildFallbackSteps(listing: PublicListing): SimulationStep[] {
    const plans = [...listing.plans].sort((a, b) => a.max_lots - b.max_lots || a.price - b.price);
    const baseLots = plans[0]?.max_lots ?? 1;
    const baseCap = listing.min_capital && listing.min_capital > 0 ? listing.min_capital : 3000;
    const unitCap = baseCap / (baseLots || 1);
    const unitNet = listing.stats.per_lot ?? (listing.stats.net / (baseLots || 1));
    const maxDdPct = listing.stats.max_drawdown_pct ?? 10;
    const unitDd = Math.round((unitCap * maxDdPct) / 100);
    if (plans.length > 0) {
        return plans.map(p => ({
            plan_id: p.id,
            name: p.name,
            lots: p.max_lots,
            price: p.price,
            currency: p.currency,
            days: p.days,
            recommended_capital: Math.round(unitCap * p.max_lots),
            simulated_profit: Math.round(unitNet * p.max_lots * 100) / 100,
            max_drawdown: Math.round(unitDd * p.max_lots * 100) / 100,
        }));
    }
    return [1, 2, 3, 5, 10].map(lots => ({
        plan_id: null,
        name: `${lots} ${lots === 1 ? 'contrato' : 'contratos'}`,
        lots,
        price: listing.price,
        currency: listing.currency,
        days: listing.default_days,
        recommended_capital: Math.round(unitCap * lots),
        simulated_profit: Math.round(unitNet * lots * 100) / 100,
        max_drawdown: Math.round(unitDd * lots * 100) / 100,
    }));
}

export default function CheckoutPage() {
    const { slug = '' } = useParams();
    const [params] = useSearchParams();
    const urlCode = params.get('codigo')?.trim() ?? '';
    const navigate = useNavigate();
    const { user, login } = useAuth();

    const saved = useMemo<SavedCheckoutState>(() => {
        try {
            const raw = sessionStorage.getItem(storageKey(slug));
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }, [slug]);

    const [listing, setListing] = useState<PublicListing | null>(null);
    const [simulation, setSimulation] = useState<PortfolioSimulation | null>(null);
    const [missing, setMissing] = useState(false);
    const [me, setMe] = useState<Me | null>(null);

    // Step state
    const [step, setStep] = useState<StepId>('contracts');
    const [stepIdx, setStepIdx] = useState<number>(saved.stepIndex ?? 0);
    const [customCapital, setCustomCapital] = useState<number | null>(saved.customCapital ?? null);
    const [editingCapital, setEditingCapital] = useState(false);
    const [capitalDraft, setCapitalDraft] = useState('');

    // Step 2: Hosting choice (default true to nudge the user toward cloud hosting)
    const [wantsHosting, setWantsHosting] = useState<boolean>(saved.wantsHosting ?? true);

    // Step 3: Broker & Advisor
    const [broker, setBroker] = useState<BrokerChoice | null>(saved.broker ?? null);
    const [advisorChoice, setAdvisorChoice] = useState<AdvisorChoice>(saved.advisorChoice ?? null);
    const [advisorName, setAdvisorName] = useState<string>(saved.advisorName ?? '');

    // Step 4-7: Guest auth / registration one question at a time
    const [email, setEmail] = useState<string>(saved.email ?? '');
    const [emailExists, setEmailExists] = useState<boolean | null>(null);
    const [name, setName] = useState<string>(saved.name ?? '');
    const [password, setPassword] = useState<string>('');
    const [showPassword, setShowPassword] = useState(false);
    const [cpf, setCpf] = useState<string>(saved.cpf ?? '');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Summary / Promo / Done
    const [promoCode, setPromoCode] = useState<string>(urlCode);
    const [promoOpen, setPromoOpen] = useState<boolean>(urlCode !== '');
    const [done, setDone] = useState<Subscription | null>(null);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            api.get<PublicListing>(`/api/marketplace/${slug}`),
            api.get<PortfolioSimulation>(`/api/marketplace/${slug}/simulation`).catch(() => null),
        ])
            .then(([listingRes, simRes]) => {
                if (cancelled) return;
                setListing(listingRes.data);
                if (simRes?.data) setSimulation(simRes.data);
                if (!listingRes.data.hosting_allowed) setWantsHosting(false);
            })
            .catch(e => {
                console.error(e);
                if (!cancelled) setMissing(true);
            });
        return () => { cancelled = true; };
    }, [slug]);

    useEffect(() => {
        if (!user) return;
        api.get<Me>('/me')
            .then(res => {
                setMe(res.data);
                if (res.data.broker && !broker) setBroker(res.data.broker);
                if (res.data.advisor_unknown && !advisorChoice) setAdvisorChoice('unknown');
                else if (res.data.advisor && !advisorChoice) {
                    setAdvisorChoice('yes');
                    setAdvisorName(res.data.advisor);
                }
            })
            .catch(e => console.error(e));
    }, [user, broker, advisorChoice]);

    // Persist choices across refreshes
    useEffect(() => {
        try {
            const payload: SavedCheckoutState = {
                stepIndex: stepIdx,
                wantsHosting,
                broker,
                advisorChoice,
                advisorName,
                email,
                name,
                cpf,
                customCapital,
            };
            sessionStorage.setItem(storageKey(slug), JSON.stringify(payload));
        } catch {
            // Storage unavailable
        }
    }, [slug, stepIdx, wantsHosting, broker, advisorChoice, advisorName, email, name, cpf, customCapital]);

    const steps = useMemo<SimulationStep[]>(() => {
        if (simulation && simulation.steps.length > 0) return simulation.steps;
        if (listing) return buildFallbackSteps(listing);
        return [];
    }, [simulation, listing]);

    const clampedIdx = Math.min(Math.max(0, stepIdx), Math.max(0, steps.length - 1));
    const currentTier = steps[clampedIdx] ?? null;

    // Ordered flow of steps based on listing & user state
    const flow = useMemo<StepId[]>(() => {
        const list: StepId[] = ['contracts'];
        if (listing?.hosting_allowed !== false) list.push('hosting');
        list.push('broker');
        if (!user) {
            list.push('email');
            if (emailExists === true) {
                list.push('login_password');
            } else {
                list.push('name', 'register_password', 'cpf');
            }
        }
        list.push('summary');
        return list;
    }, [listing?.hosting_allowed, user, emailExists]);

    const currentFlowIndex = Math.max(0, flow.indexOf(step));
    const progressPct = Math.round(((currentFlowIndex + 1) / flow.length) * 100);

    const goNext = (from: StepId) => {
        setFieldError(null);
        const idx = flow.indexOf(from);
        if (idx >= 0 && idx + 1 < flow.length) {
            setStep(flow[idx + 1]);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };

    const goBack = () => {
        setFieldError(null);
        const idx = flow.indexOf(step);
        if (idx > 0) {
            setStep(flow[idx - 1]);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            navigate(`/marketplace/${slug}${urlCode ? `?codigo=${encodeURIComponent(urlCode)}` : ''}`);
        }
    };

    if (missing) {
        return (
            <div className="panel">
                <EmptyState icon={<Store />} title="Portfólio não encontrado" description="Ele pode ter saído do marketplace." />
            </div>
        );
    }

    if (!listing || !currentTier) {
        return <p className="text-sm text-muted-foreground">Preparando sua experiência...</p>;
    }

    const currency = simulation?.currency ?? listing.currency ?? 'BRL';
    const hostingOfferPrice: HostingPrice = listing.hosting_price ?? {
        ...DEFAULT_HOSTING_PRICE,
        currency: listing.currency || 'BRL',
    };

    // Base capital for dynamic risk comparison: defaults to the portfolio's base capital so stepping up contracts
    // visibly shifts the risk gauge, while letting the user also simulate their own capital or click "Usar capital recomendado"
    const baseCapital = simulation?.base_capital ?? listing.min_capital ?? steps[0]?.recommended_capital ?? 3000;
    const referenceCapital = customCapital && customCapital > 0 ? customCapital : baseCapital;
    const drawdownPctOnRef = referenceCapital > 0
        ? Math.round((currentTier.max_drawdown / referenceCapital) * 1000) / 10
        : (listing.stats.max_drawdown_pct ?? 0);
    const drawdownPctOnRecommended = currentTier.recommended_capital > 0
        ? Math.round((currentTier.max_drawdown / currentTier.recommended_capital) * 1000) / 10
        : drawdownPctOnRef;
    const dynamicRisk = riskOf(drawdownPctOnRef) ?? {
        label: 'Conservador',
        variant: 'success' as const,
        hint: 'Oscilação controlada para o capital selecionado',
    };

    const scaledMonths = (simulation?.months ?? []).map(m => ({
        label: formatMonth(m.month),
        value: Math.round(m.net * currentTier.lots * 100) / 100,
    }));

    const brokerValid = broker !== null && (
        broker === 'none'
        || advisorChoice === 'no'
        || advisorChoice === 'unknown'
        || (advisorChoice === 'yes' && advisorName.trim().length >= 2)
    );

    const handleEmailSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setFieldError(null);
        const trimmed = email.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
            setFieldError('Digite um email válido para continuar.');
            return;
        }
        setBusy(true);
        try {
            const res = await api.post<{ exists: boolean }>('/auth/email-check', { email: trimmed });
            setEmail(trimmed);
            setEmailExists(res.data.exists);
            setStep(res.data.exists ? 'login_password' : 'name');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (err) {
            setFieldError(apiError(err, 'Não foi possível verificar seu email agora.'));
        } finally {
            setBusy(false);
        }
    };

    const handleLoginSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setFieldError(null);
        if (!password) {
            setFieldError('Digite sua senha para entrar.');
            return;
        }
        setBusy(true);
        try {
            const formData = new URLSearchParams();
            formData.append('username', email.trim());
            formData.append('password', password);
            const res = await api.post<{ access_token: string }>('/token', formData);
            login(res.data.access_token);
            toast.success('Bem-vindo de volta!');
            setStep('summary');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (err) {
            setFieldError(apiError(err, 'Senha incorreta. Tente novamente ou recupere sua senha.'));
        } finally {
            setBusy(false);
        }
    };

    const handleNameSubmit = (e: FormEvent) => {
        e.preventDefault();
        setFieldError(null);
        if (name.trim().length < 2) {
            setFieldError('Informe como podemos chamar você.');
            return;
        }
        goNext('name');
    };

    const handleRegisterPasswordSubmit = (e: FormEvent) => {
        e.preventDefault();
        setFieldError(null);
        if (password.length < PASSWORD_MIN) {
            setFieldError(`Sua senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`);
            return;
        }
        goNext('register_password');
    };

    const handleCpfAndRegister = async (e: FormEvent) => {
        e.preventDefault();
        setFieldError(null);
        if (!isValidCpf(cpf)) {
            setFieldError('Confira os números: este CPF não é válido.');
            return;
        }
        setBusy(true);
        try {
            const res = await api.post<{ access_token: string }>('/register', {
                email: email.trim().toLowerCase(),
                password,
                name: name.trim(),
                cpf: cleanCpf(cpf),
                broker: broker ?? undefined,
                advisor: advisorChoice === 'yes' ? advisorName.trim() : null,
                advisor_unknown: advisorChoice === 'unknown',
            });
            login(res.data.access_token);
            toast.success(`Conta criada, ${name.trim().split(' ')[0]}!`);
            setStep('summary');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (err) {
            setFieldError(apiError(err, 'Não foi possível concluir seu cadastro.'));
        } finally {
            setBusy(false);
        }
    };

    const handleSubscribe = async () => {
        setBusy(true);
        try {
            const payload: Record<string, unknown> = {
                wants_hosting: listing.hosting_allowed ? wantsHosting : false,
                broker: broker ?? undefined,
                advisor: advisorChoice === 'yes' ? advisorName.trim() : null,
                advisor_unknown: advisorChoice === 'unknown',
            };
            if (listing.pay_online && currentTier.plan_id != null) {
                payload.plan_id = currentTier.plan_id;
            }
            const res = await api.post<Subscription>(`/api/marketplace/${listing.slug}/subscribe`, payload);
            sessionStorage.removeItem(storageKey(slug));
            if (res.data.listing.pay_online) {
                await openCheckout(res.data.id);
                return;
            }
            setDone(res.data);
            if (res.data.listing.checkout_url) {
                window.open(res.data.listing.checkout_url, '_blank', 'noopener,noreferrer');
            }
        } catch (err) {
            toast.error(apiError(err, 'Não foi possível enviar o pedido de assinatura.'));
        } finally {
            setBusy(false);
        }
    };

    const handleRedeemPromo = async (e: FormEvent) => {
        e.preventDefault();
        if (!promoCode.trim()) return;
        setBusy(true);
        try {
            const res = await api.post<ClientLicense>(`/api/marketplace/${listing.slug}/redeem`, { code: promoCode.trim() });
            sessionStorage.removeItem(storageKey(slug));
            toast.success('Código aplicado!', {
                description: `Conecte sua conta MT5: seus ${res.data.promo?.free_days ?? ''} dias grátis começam quando ela estiver conectada.`,
            });
            navigate(`/client/licenses/${res.data.id}`);
        } catch (err) {
            toast.error(apiError(err, 'Não foi possível usar o código.'));
        } finally {
            setBusy(false);
        }
    };

    const lotsText = `${currentTier.lots.toLocaleString('pt-BR')} ${currentTier.lots === 1 ? 'contrato' : 'contratos'}`;
    const tierPriceText = currentTier.price == null
        ? 'Sob consulta'
        : currentTier.price === 0
            ? 'Gratuito'
            : `${formatMoney(currentTier.price, currentTier.currency)} / ${periodLabel(currentTier.days)}`;

    return (
        <div className="mx-auto max-w-3xl space-y-6 pb-24">
            {/* Top Navigation + Progress Bar */}
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <button
                        type="button"
                        onClick={goBack}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <ArrowLeft className="size-4" /> Voltar
                    </button>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate font-medium text-foreground">{listing.title}</span>
                        <span>·</span>
                        <span>Passo {currentFlowIndex + 1} de {flow.length}</span>
                    </div>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                        className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{ width: `${progressPct}%` }}
                        role="progressbar"
                        aria-valuenow={progressPct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                    />
                </div>
            </div>

            {/* STEP 1: CONTRACTS & DOPAMINE SIMULATOR */}
            {step === 'contracts' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    <div className="space-y-2 text-center">
                        <Badge variant="primary"><Sparkles className="size-3" /> Monte o seu plano</Badge>
                        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                            Quantos contratos você deseja operar?
                        </h1>
                        <p className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">
                            Aumente ou diminua os contratos para ver na hora quanto esta estratégia teria rendido,
                            o capital recomendado e o risco atualizado.
                        </p>
                    </div>

                    {/* Big Tactile Contract Stepper */}
                    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5">
                        <div className="flex w-full items-center justify-between gap-4">
                            <button
                                type="button"
                                aria-label="Diminuir contratos"
                                disabled={clampedIdx <= 0}
                                onClick={() => setStepIdx(Math.max(0, clampedIdx - 1))}
                                className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-sm transition-all hover:border-primary hover:bg-primary/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
                            >
                                <Minus className="size-5" />
                            </button>
                            <div className="min-w-0 text-center">
                                <p className="text-3xl font-extrabold tracking-tight sm:text-4xl">
                                    {lotsText}
                                </p>
                                <p className="mt-0.5 text-xs font-medium text-primary">
                                    {currentTier.name} · {tierPriceText}
                                </p>
                            </div>
                            <button
                                type="button"
                                aria-label="Aumentar contratos"
                                disabled={clampedIdx >= steps.length - 1}
                                onClick={() => setStepIdx(Math.min(steps.length - 1, clampedIdx + 1))}
                                className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-primary/50 bg-primary text-primary-foreground shadow-md shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
                            >
                                <Plus className="size-5" />
                            </button>
                        </div>

                        {steps.length > 1 && (
                            <div className="flex flex-wrap justify-center gap-1.5 pt-1" role="group" aria-label="Opções de contratos">
                                {steps.map((s, idx) => (
                                    <button
                                        key={`${s.lots}-${idx}`}
                                        type="button"
                                        onClick={() => setStepIdx(idx)}
                                        className={cn(
                                            'rounded-full px-3 py-1 text-xs font-semibold transition-all',
                                            idx === clampedIdx
                                                ? 'bg-primary text-primary-foreground shadow-sm'
                                                : 'border border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
                                        )}
                                    >
                                        {s.lots.toLocaleString('pt-BR')} {s.lots === 1 ? 'contrato' : 'contratos'}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Three Live KPI Cards: Profit, Recommended Capital, Updated Risk */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        {/* 1. Simulated Profit */}
                        <div className="relative overflow-hidden rounded-xl border-2 border-success/40 bg-gradient-to-br from-success/15 via-success/5 to-transparent p-4">
                            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                <TrendingUp className="size-4 text-success" />
                                Lucro nos últimos meses
                            </div>
                            <p className={cn(
                                'mt-2 text-2xl font-extrabold tracking-tight transition-all sm:text-3xl',
                                currentTier.simulated_profit >= 0 ? 'text-success' : 'text-destructive',
                            )}>
                                {currentTier.simulated_profit > 0 ? '+ ' : ''}
                                {formatMoney(currentTier.simulated_profit, currency)}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {simulation && simulation.trades > 0
                                    ? `Em ${simulation.trades} operações fechadas com ${lotsText}`
                                    : `Projeção proporcional para ${lotsText}`}
                            </p>
                        </div>

                        {/* 2. Recommended Capital */}
                        <div className="rounded-xl border border-border bg-secondary/40 p-4">
                            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                <Wallet className="size-4 text-primary" />
                                Capital recomendado
                            </div>
                            <p className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
                                {formatMoney(currentTier.recommended_capital, currency)}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Margem recomendada para operar {lotsText} com folga
                            </p>
                        </div>

                        {/* 3. Updated Risk */}
                        <div className="rounded-xl border border-border bg-secondary/40 p-4">
                            <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                    <ShieldAlert className="size-4 text-warning" />
                                    Risco atualizado
                                </span>
                                <Badge variant={dynamicRisk.variant}>{dynamicRisk.label}</Badge>
                            </div>
                            <p className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
                                {currentTier.max_drawdown > 0
                                    ? `- ${formatMoney(currentTier.max_drawdown, currency)}`
                                    : formatMoney(0, currency)}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Maior oscilação ({drawdownPctOnRef.toLocaleString('pt-BR')}% sobre {formatMoney(referenceCapital, currency)})
                            </p>
                        </div>
                    </div>

                    {/* Interactive Capital Reference Bar for Risk */}
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-4 py-3 text-xs">
                        <div className="space-y-0.5">
                            <p className="font-medium text-foreground">
                                Simulando risco para um capital na corretora de{' '}
                                <strong className="text-primary">{formatMoney(referenceCapital, currency)}</strong>
                            </p>
                            <p className="text-muted-foreground">
                                Com o capital recomendado de {formatMoney(currentTier.recommended_capital, currency)}, a oscilação histórica representa {drawdownPctOnRecommended.toLocaleString('pt-BR')}%.
                            </p>
                        </div>
                        {editingCapital ? (
                            <form
                                onSubmit={e => {
                                    e.preventDefault();
                                    const num = Number(capitalDraft.replace(/\./g, '').replace(',', '.'));
                                    if (!Number.isNaN(num) && num > 0) setCustomCapital(num);
                                    setEditingCapital(false);
                                }}
                                className="flex items-center gap-2"
                            >
                                <Input
                                    type="number"
                                    min={100}
                                    step={500}
                                    value={capitalDraft}
                                    onChange={e => setCapitalDraft(e.target.value)}
                                    placeholder="Seu capital"
                                    className="h-8 w-32 text-xs"
                                    autoFocus
                                />
                                <Button size="sm" type="submit">Aplicar</Button>
                            </form>
                        ) : (
                            <div className="flex flex-wrap items-center gap-2">
                                {referenceCapital !== currentTier.recommended_capital && (
                                    <button
                                        type="button"
                                        onClick={() => setCustomCapital(currentTier.recommended_capital)}
                                        className="rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 font-medium text-primary hover:bg-primary/20"
                                    >
                                        Usar recomendado ({formatMoney(currentTier.recommended_capital, currency)})
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => {
                                        setCapitalDraft(String(referenceCapital));
                                        setEditingCapital(true);
                                    }}
                                    className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground hover:border-primary/40"
                                >
                                    <Pencil className="size-3" /> Alterar meu capital
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Monthly chart scaled to the selected contract tier */}
                    {scaledMonths.length > 0 && (
                        <div className="space-y-2 rounded-xl border border-border bg-card p-4">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold">
                                    Resultado mês a mês com {lotsText}
                                </p>
                                <span className="text-xs text-muted-foreground">Operações reais fechadas</span>
                            </div>
                            <ColumnChart
                                data={scaledMonths}
                                ariaLabel={`Resultado mensal simulado para ${lotsText}`}
                                formatValue={v => formatMoney(v, currency)}
                                height={170}
                            />
                        </div>
                    )}

                    <div className="space-y-3 pt-2">
                        <Button size="lg" className="w-full" onClick={() => goNext('contracts')}>
                            Continuar com {lotsText} <ArrowRight />
                        </Button>
                        <p className="text-center text-xs text-muted-foreground">
                            Resultados passados não garantem resultados futuros. Você pode alterar ou cancelar seu plano quando quiser.
                        </p>
                    </div>
                </section>
            )}

            {/* STEP 2: CLOUD HOSTING VS MANUAL INSTALLATION */}
            {step === 'hosting' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    <div className="space-y-2 text-center">
                        <Badge variant="primary"><Cloud className="size-3" /> Instalação e hospedagem</Badge>
                        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                            Como você prefere rodar a sua cópia?
                        </h1>
                        <p className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">
                            Você pode deixar toda a parte técnica com a Trademetric na nuvem ou fazer a instalação manual por conta própria.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        {/* Option A: Trademetric takes care of everything */}
                        <button
                            type="button"
                            onClick={() => setWantsHosting(true)}
                            className={cn(
                                'relative flex flex-col justify-between gap-4 rounded-2xl border-2 p-5 text-left transition-all',
                                wantsHosting
                                    ? 'border-primary bg-gradient-to-br from-primary/15 via-primary/5 to-transparent shadow-lg shadow-primary/10'
                                    : 'border-border bg-card hover:border-primary/40',
                            )}
                        >
                            <div className="space-y-4">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="inline-flex items-center gap-2 rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground">
                                        <Cloud className="size-3.5" /> Recomendado · Sem trabalho
                                    </span>
                                    <Badge variant="success">+ {hostingPriceLabel(hostingOfferPrice)}</Badge>
                                </div>

                                <div>
                                    <h2 className="text-lg font-bold text-foreground">
                                        Deixar tudo por conta da Trademetric
                                    </h2>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        Você apenas configura qual é o seu capital e conecta sua conta. A Trademetric cuida de todo o resto.
                                    </p>
                                </div>

                                <ul className="space-y-2.5 text-sm">
                                    <li className="flex items-start gap-2.5">
                                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                                        <span><strong>Zero instalação:</strong> não precisa baixar arquivos nem contratar VPS</span>
                                    </li>
                                    <li className="flex items-start gap-2.5">
                                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                                        <span><strong>Seu computador desligado:</strong> roda 24h nos nossos servidores de baixa latência</span>
                                    </li>
                                    <li className="flex items-start gap-2.5">
                                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                                        <span><strong>Calibrado e monitorado:</strong> nós instalamos, calibramos e mantemos a cópia ativa</span>
                                    </li>
                                </ul>
                            </div>

                            <div className="flex items-center justify-between border-t border-border/60 pt-3 text-sm font-semibold text-primary">
                                <span>{wantsHosting ? 'Selecionado: Trademetric cuida de tudo' : 'Escolher hospedagem Trademetric'}</span>
                                {wantsHosting && <Check className="size-4" />}
                            </div>
                        </button>

                        {/* Option B: DIY Manual Setup */}
                        <button
                            type="button"
                            onClick={() => setWantsHosting(false)}
                            className={cn(
                                'relative flex flex-col justify-between gap-4 rounded-2xl border-2 p-5 text-left transition-all',
                                !wantsHosting
                                    ? 'border-warning bg-warning/5'
                                    : 'border-border bg-card/60 opacity-85 hover:opacity-100',
                            )}
                        >
                            <div className="space-y-4">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">
                                        <Wrench className="size-3.5" /> Instalação manual
                                    </span>
                                    <Badge variant="muted">Por sua conta</Badge>
                                </div>

                                <div>
                                    <h2 className="text-lg font-bold text-foreground">
                                        Eu mesmo quero instalar sozinho
                                    </h2>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Você precisará cumprir e manter todos estes passos técnicos por conta própria:
                                    </p>
                                </div>

                                <ol className="space-y-2 text-xs text-muted-foreground">
                                    {MANUAL_INSTALL_STEPS.map((item, i) => (
                                        <li key={item} className="flex items-start gap-2">
                                            <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-[10px] font-bold text-foreground">
                                                {i + 1}
                                            </span>
                                            <span>{item}</span>
                                        </li>
                                    ))}
                                </ol>
                            </div>

                            <div className="flex items-center justify-between border-t border-border/60 pt-3 text-xs font-medium text-muted-foreground">
                                <span>{!wantsHosting ? 'Selecionado: Vou fazer toda a instalação sozinho' : 'Quero ter o trabalho de instalar'}</span>
                                {!wantsHosting && <Check className="size-4 text-warning" />}
                            </div>
                        </button>
                    </div>

                    {!wantsHosting && (
                        <div className="flex flex-col justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 sm:flex-row sm:items-center">
                            <p className="flex items-start gap-2.5 text-xs text-foreground sm:text-sm">
                                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                                <span>
                                    Se o seu computador desligar, hibernar ou cair a internet com operação aberta, sua conta não receberá a saída do gestor.
                                    Por <strong>{hostingPriceLabel(hostingOfferPrice)}</strong> a Trademetric cuida de tudo na nuvem.
                                </span>
                            </p>
                            <Button size="sm" className="shrink-0" onClick={() => setWantsHosting(true)}>
                                Deixar com a Trademetric
                            </Button>
                        </div>
                    )}

                    <Button size="lg" className="w-full" onClick={() => goNext('hosting')}>
                        {wantsHosting ? 'Continuar com tudo pronto na nuvem' : 'Continuar instalando por conta própria'} <ArrowRight />
                    </Button>
                </section>
            )}

            {/* STEP 3: HOMOLOGATED BROKER & ADVISOR */}
            {step === 'broker' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    <div className="space-y-2 text-center">
                        <Badge variant="primary"><Building2 className="size-3" /> Corretora</Badge>
                        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                            Você já tem conta em uma das corretoras homologadas?
                        </h1>
                        <p className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">
                            As estratégias operam nas corretoras homologadas abaixo para garantir a melhor execução.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {BROKER_OPTIONS.map(opt => {
                            const selected = broker === opt.id;
                            return (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => {
                                        setBroker(opt.id);
                                        if (opt.id === 'none') {
                                            setAdvisorChoice(null);
                                            setAdvisorName('');
                                        }
                                    }}
                                    className={cn(
                                        'flex items-start justify-between gap-3 rounded-xl border-2 p-4 text-left transition-all',
                                        opt.id === 'none' && 'sm:col-span-2',
                                        selected
                                            ? 'border-primary bg-primary/10 shadow-sm'
                                            : 'border-border bg-card hover:border-primary/40',
                                    )}
                                >
                                    <div className="space-y-1">
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-foreground">{opt.name}</span>
                                            <Badge variant={selected ? 'primary' : 'muted'}>{opt.tag}</Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">{opt.detail}</p>
                                    </div>
                                    <span className={cn(
                                        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                                        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                                    )}>
                                        {selected && <Check className="size-3" />}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Follow-up when the user already has a broker account */}
                    {broker && broker !== 'none' && (
                        <div className="space-y-4 rounded-xl border border-border bg-secondary/30 p-4 sm:p-5">
                            <div className="space-y-1">
                                <p className="text-base font-semibold text-foreground">
                                    Você tem assessoria de investimentos na {broker}?
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    Isso nos ajuda a orientar melhor a configuração da sua conta MetaTrader 5.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                                {[
                                    { id: 'yes' as const, label: 'Sim, tenho assessoria' },
                                    { id: 'no' as const, label: 'Não tenho assessoria' },
                                    { id: 'unknown' as const, label: 'Não sei' },
                                ].map(item => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setAdvisorChoice(item.id)}
                                        className={cn(
                                            'flex items-center justify-between gap-2 rounded-lg border p-3 text-left text-sm font-medium transition-all',
                                            advisorChoice === item.id
                                                ? 'border-primary bg-primary/10 text-foreground'
                                                : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
                                        )}
                                    >
                                        <span>{item.label}</span>
                                        {advisorChoice === item.id && <Check className="size-4 text-primary" />}
                                    </button>
                                ))}
                            </div>

                            {advisorChoice === 'yes' && (
                                <Field
                                    label="De quem é a sua assessoria? (escritório ou nome do assessor)"
                                    htmlFor="advisor-name"
                                >
                                    <Input
                                        id="advisor-name"
                                        value={advisorName}
                                        onChange={e => setAdvisorName(e.target.value)}
                                        placeholder="Ex.: nome do escritório ou do seu assessor"
                                        autoFocus
                                    />
                                </Field>
                            )}

                            {advisorChoice === 'unknown' && (
                                <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
                                    Tudo bem! Se você não sabe, provavelmente sua conta está no atendimento padrão (mesa convencional) da {broker}.
                                </p>
                            )}
                        </div>
                    )}

                    {broker === 'none' && (
                        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm text-muted-foreground">
                            <strong className="text-foreground">Sem problema!</strong> Você garante sua assinatura agora e pode abrir sua conta gratuitamente na XP, Clear, Rico ou Genial antes de conectar o MetaTrader 5.
                        </div>
                    )}

                    <Button
                        size="lg"
                        className="w-full"
                        disabled={!brokerValid}
                        onClick={() => goNext('broker')}
                    >
                        Continuar <ArrowRight />
                    </Button>
                </section>
            )}

            {/* STEP 4: EMAIL (detects whether user already has a Mirror account) */}
            {step === 'email' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    <div className="space-y-2 text-center">
                        <Badge variant="primary"><Mail className="size-3" /> Seu acesso</Badge>
                        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                            Qual é o seu melhor email?
                        </h1>
                        <p className="mx-auto max-w-md text-sm text-muted-foreground">
                            Se você já tiver cadastro no Trademetric Mirror, vamos identificar sua conta automaticamente.
                        </p>
                    </div>

                    <form onSubmit={handleEmailSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                        <Field label="Email" htmlFor="checkout-email" error={fieldError ?? undefined}>
                            <Input
                                id="checkout-email"
                                type="email"
                                autoComplete="email"
                                value={email}
                                onChange={e => { setEmail(e.target.value); setFieldError(null); }}
                                placeholder="voce@exemplo.com"
                                icon={<Mail />}
                                className="h-12 text-base"
                                autoFocus
                            />
                        </Field>
                        <Button type="submit" size="lg" className="w-full" loading={busy}>
                            Continuar {!busy && <ArrowRight />}
                        </Button>
                    </form>
                </section>
            )}

            {/* STEP 5a: PASSWORD FOR EXISTING USER */}
            {step === 'login_password' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    <div className="space-y-2 text-center">
                        <Badge variant="success"><CheckCircle2 className="size-3" /> Conta encontrada</Badge>
                        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                            Que bom te ver de novo!
                        </h1>
                        <p className="mx-auto max-w-md text-sm text-muted-foreground">
                            Você já tem cadastro com <strong className="text-foreground">{email}</strong>. Digite sua senha para continuar sua assinatura.
                        </p>
                        <button
                            type="button"
                            onClick={() => { setPassword(''); setFieldError(null); setStep('email'); }}
                            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                        >
                            Usar outro email
                        </button>
                    </div>

                    <form onSubmit={handleLoginSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                        <Field label="Sua senha no Mirror" htmlFor="checkout-login-password" error={fieldError ?? undefined}>
                            <div className="relative">
                                <Input
                                    id="checkout-login-password"
                                    type={showPassword ? 'text' : 'password'}
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={e => { setPassword(e.target.value); setFieldError(null); }}
                                    icon={<Lock />}
                                    className="h-12 pr-12 text-base"
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(v => !v)}
                                    aria-label={showPassword ? 'Esconder a senha' : 'Mostrar a senha'}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground [&_svg]:size-4"
                                >
                                    {showPassword ? <EyeOff /> : <Eye />}
                                </button>
                            </div>
                        </Field>
                        <Button type="submit" size="lg" className="w-full" loading={busy}>
                            Entrar e continuar {!busy && <ArrowRight />}
                        </Button>
                        <p className="text-center text-xs text-muted-foreground">
                            Esqueceu a senha?{' '}
                            <Link to="/recuperar-senha" className="font-medium text-primary underline-offset-4 hover:underline">
                                Recuperar acesso por email
                            </Link>
                        </p>
                    </form>
                </section>
            )}

            {/* STEP 5b: NAME (for new user, one thing at a time) */}
            {step === 'name' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    <div className="space-y-2 text-center">
                        <Badge variant="primary"><UserIcon className="size-3" /> Passo rápido</Badge>
                        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                            Como podemos chamar você?
                        </h1>
                        <p className="mx-auto max-w-md text-sm text-muted-foreground">
                            Criando seu acesso para <strong className="text-foreground">{email}</strong>.
                        </p>
                    </div>

                    <form onSubmit={handleNameSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                        <Field label="Seu nome completo" htmlFor="checkout-name" error={fieldError ?? undefined}>
                            <Input
                                id="checkout-name"
                                type="text"
                                autoComplete="name"
                                value={name}
                                onChange={e => { setName(e.target.value); setFieldError(null); }}
                                placeholder="Ex.: João Silva"
                                icon={<UserIcon />}
                                className="h-12 text-base"
                                autoFocus
                            />
                        </Field>
                        <Button type="submit" size="lg" className="w-full">
                            Continuar <ArrowRight />
                        </Button>
                    </form>
                </section>
            )}

            {/* STEP 6: CREATE PASSWORD (one thing at a time) */}
            {step === 'register_password' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    <div className="space-y-2 text-center">
                        <Badge variant="primary"><Lock className="size-3" /> Segurança</Badge>
                        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                            Crie uma senha para sua conta
                        </h1>
                        <p className="mx-auto max-w-md text-sm text-muted-foreground">
                            Prazer, <strong className="text-foreground">{name.trim().split(' ')[0]}</strong>! Escolha uma senha de pelo menos {PASSWORD_MIN} caracteres para acompanhar suas cópias.
                        </p>
                    </div>

                    <form onSubmit={handleRegisterPasswordSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                        <Field
                            label="Crie sua senha"
                            htmlFor="checkout-register-password"
                            hint={`Mínimo de ${PASSWORD_MIN} caracteres.`}
                            error={fieldError ?? undefined}
                        >
                            <div className="relative">
                                <Input
                                    id="checkout-register-password"
                                    type={showPassword ? 'text' : 'password'}
                                    autoComplete="new-password"
                                    value={password}
                                    onChange={e => { setPassword(e.target.value); setFieldError(null); }}
                                    icon={<Lock />}
                                    className="h-12 pr-12 text-base"
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(v => !v)}
                                    aria-label={showPassword ? 'Esconder a senha' : 'Mostrar a senha'}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground [&_svg]:size-4"
                                >
                                    {showPassword ? <EyeOff /> : <Eye />}
                                </button>
                            </div>
                        </Field>
                        <Button type="submit" size="lg" className="w-full">
                            Continuar <ArrowRight />
                        </Button>
                    </form>
                </section>
            )}

            {/* STEP 7: CPF (final identity step, creates the account) */}
            {step === 'cpf' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    <div className="space-y-2 text-center">
                        <Badge variant="primary"><CreditCard className="size-3" /> Último dado</Badge>
                        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                            Por último, qual é o seu CPF?
                        </h1>
                        <p className="mx-auto max-w-md text-sm text-muted-foreground">
                            Necessário para vincular a titularidade da sua assinatura com segurança.
                        </p>
                    </div>

                    <form onSubmit={handleCpfAndRegister} className="mx-auto max-w-md space-y-4" noValidate>
                        <Field label="CPF" htmlFor="checkout-cpf" error={fieldError ?? undefined}>
                            <Input
                                id="checkout-cpf"
                                inputMode="numeric"
                                autoComplete="off"
                                value={cpf}
                                onChange={e => { setCpf(formatCpf(e.target.value)); setFieldError(null); }}
                                placeholder="000.000.000-00"
                                className="h-12 font-mono text-base tracking-wider"
                                autoFocus
                            />
                        </Field>
                        <Button type="submit" size="lg" className="w-full" loading={busy}>
                            Concluir cadastro e revisar pedido {!busy && <ArrowRight />}
                        </Button>
                    </form>
                </section>
            )}

            {/* FINAL STEP: SUMMARY & PAYMENT */}
            {step === 'summary' && (
                <section className="panel space-y-6 p-5 sm:p-8">
                    {done ? (
                        <div className="space-y-4 text-center">
                            <CheckCircle2 className="mx-auto size-12 text-success" />
                            <h1 className="text-2xl font-bold">Pedido de assinatura enviado!</h1>
                            <p className="mx-auto max-w-md text-sm text-muted-foreground">
                                {done.listing.checkout_url
                                    ? 'Conclua o pagamento na página aberta em uma nova aba. Assim que aprovado, sua cópia estará disponível em Minhas cópias.'
                                    : 'O gestor enviará as instruções de pagamento e liberará sua cópia.'}
                            </p>
                            {done.listing.checkout_url && (
                                <a href={done.listing.checkout_url} target="_blank" rel="noopener noreferrer" className="block">
                                    <Button size="lg" className="w-full">Abrir página de pagamento</Button>
                                </a>
                            )}
                            <Link to="/client/licenses" className="block text-sm font-medium text-primary underline-offset-4 hover:underline">
                                Ir para Minhas cópias
                            </Link>
                        </div>
                    ) : (
                        <>
                            <div className="space-y-2 text-center">
                                <Badge variant="success"><CheckCircle2 className="size-3" /> Tudo pronto</Badge>
                                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                                    Revise o seu pacote antes de ativar
                                </h1>
                                <p className="mx-auto max-w-lg text-sm text-muted-foreground">
                                    Confira as escolhas que você montou para copiar <strong className="text-foreground">{listing.title}</strong>.
                                </p>
                            </div>

                            <div className="divide-y divide-border rounded-2xl border border-border bg-secondary/20">
                                {/* 1. Contracts */}
                                <div className="flex items-center justify-between gap-4 p-4">
                                    <div>
                                        <p className="text-xs text-muted-foreground">Volume e plano</p>
                                        <p className="font-semibold text-foreground">{lotsText} ({currentTier.name})</p>
                                        <p className="text-xs text-muted-foreground">
                                            Capital recomendado: {formatMoney(currentTier.recommended_capital, currency)}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className="font-bold">{tierPriceText}</span>
                                        <Button size="sm" variant="ghost" onClick={() => setStep('contracts')}>
                                            Alterar
                                        </Button>
                                    </div>
                                </div>

                                {/* 2. Hosting */}
                                {listing.hosting_allowed && (
                                    <div className="flex items-center justify-between gap-4 p-4">
                                        <div>
                                            <p className="text-xs text-muted-foreground">Onde a cópia vai rodar</p>
                                            <p className="flex items-center gap-1.5 font-semibold text-foreground">
                                                {wantsHosting ? (
                                                    <><Cloud className="size-4 text-primary" /> Trademetric cuida de tudo (Nuvem)</>
                                                ) : (
                                                    <><Monitor className="size-4 text-muted-foreground" /> Eu mesmo instalo no meu PC/VPS</>
                                                )}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {wantsHosting
                                                    ? 'Ativada assim que você conectar os dados da sua conta MT5'
                                                    : 'Você fará o download e instalação manual do EA'}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="text-sm font-semibold">
                                                {wantsHosting ? `+ ${hostingPriceLabel(hostingOfferPrice)}` : 'Grátis'}
                                            </span>
                                            <Button size="sm" variant="ghost" onClick={() => setStep('hosting')}>
                                                Alterar
                                            </Button>
                                        </div>
                                    </div>
                                )}

                                {/* 3. Broker */}
                                <div className="flex items-center justify-between gap-4 p-4">
                                    <div>
                                        <p className="text-xs text-muted-foreground">Corretora e assessoria</p>
                                        <p className="font-semibold text-foreground">
                                            {broker === 'none' || !broker ? 'Vai abrir conta depois' : broker}
                                        </p>
                                        {broker && broker !== 'none' && (
                                            <p className="text-xs text-muted-foreground">
                                                {advisorChoice === 'yes'
                                                    ? `Assessoria: ${advisorName.trim()}`
                                                    : advisorChoice === 'unknown'
                                                        ? 'Assessoria: Não sei (mesa padrão)'
                                                        : 'Sem assessoria'}
                                            </p>
                                        )}
                                    </div>
                                    <Button size="sm" variant="ghost" onClick={() => setStep('broker')}>
                                        Alterar
                                    </Button>
                                </div>
                            </div>

                            {/* Launch promo code box */}
                            {(urlCode !== '' || listing.has_promo) && (
                                <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
                                    {promoOpen ? (
                                        <form onSubmit={handleRedeemPromo} className="space-y-2" noValidate>
                                            <label htmlFor="checkout-promo" className="flex items-center gap-2 text-sm font-semibold">
                                                <Ticket className="size-4 text-primary" /> Código de lançamento
                                            </label>
                                            {me?.email_enabled && !me.email_verified ? (
                                                <div className="space-y-2 text-sm">
                                                    <p className="text-muted-foreground">
                                                        Confirme seu email pelo link que enviamos para ativar os dias grátis sem cartão.
                                                    </p>
                                                    <ResendLinkButton />
                                                </div>
                                            ) : (
                                                <div className="flex gap-2">
                                                    <Input
                                                        id="checkout-promo"
                                                        value={promoCode}
                                                        onChange={e => setPromoCode(e.target.value)}
                                                        placeholder="Digite seu código"
                                                        className="font-mono uppercase"
                                                    />
                                                    <Button type="submit" loading={busy} disabled={!promoCode.trim()}>
                                                        Ativar grátis
                                                    </Button>
                                                </div>
                                            )}
                                        </form>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => setPromoOpen(true)}
                                            className="flex w-full items-center justify-center gap-2 text-sm font-medium text-primary hover:underline"
                                        >
                                            <Ticket className="size-4" /> Tenho um código de lançamento
                                        </button>
                                    )}
                                </div>
                            )}

                            <div className="space-y-3">
                                <Button size="lg" className="w-full" loading={busy} onClick={handleSubscribe}>
                                    Ir para o pagamento seguro {!busy && <ArrowRight />}
                                </Button>
                                {listing.pay_online && (
                                    <p className="text-center text-xs text-muted-foreground">
                                        Pagamento processado com segurança pela Stripe. Após o pagamento, você conectará sua conta MT5 em 1 minuto.
                                    </p>
                                )}
                            </div>
                        </>
                    )}
                </section>
            )}
        </div>
    );
}

