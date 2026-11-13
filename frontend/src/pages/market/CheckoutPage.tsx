import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, Store, UserX } from 'lucide-react';
import { toast } from 'sonner';
import api, {
    type ClientLicense, type Me, type MyLicenses, type PortfolioSimulation, type PublicFollowerStats,
    type PublicListing, type SimulationStep, type Subscription,
} from '../../api';
import EmptyState from '../../components/EmptyState';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../context/AuthContext';
import { cleanCpf, isValidCpf } from '../../lib/cpf';
import { formatMoney, periodLabel } from '../../lib/money';
import { openCheckout } from '../../lib/stripe';
import { track } from '../../lib/track';
import { apiError, cn } from '../../lib/utils';
import { AFTER_VERIFY_KEY } from '../EmailLinks';
import { CpfStep, DetailsStep, EmailStep, LoginStep, NameStep, PASSWORD_MIN } from './checkout/AccountSteps';
import ContractsStep from './checkout/ContractsStep';
import { periodWords, planTitle, signedMoney, unitOf } from './checkout/format';
import HostingStep from './checkout/HostingStep';
import { OrderBar, OrderSummary } from './checkout/OrderSummary';
import { CheckoutColumns, CheckoutSkeleton } from './checkout/parts';
import { PRIVACY_PATH, TERMS_PATH } from '../../components/TermsNotice';
import { PaySummary, PromoSummary } from './checkout/SummaryStep';
import {
    STAGE_LABELS, buildFlow, buildStages, progressOf, resolveStep, stageOf, type StageId, type StepId,
} from './checkout/flow';

// What survives a refresh in the same tab. Never the CPF nor the password
type SavedCheckoutState = {
    tierIndex?: number;
    stepIndex?: number; // The old name of tierIndex (it always held the contracts level), read once
    wantsHosting?: boolean | null;
    email?: string;
    emailExists?: boolean | null;
    name?: string;
    customCapital?: number | null;
    startedAsGuest?: boolean; // A refresh after signing up keeps "Sua conta" among the stages
};

const storageKey = (slug: string) => `tdm-checkout-${slug}`;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function readSaved(slug: string): SavedCheckoutState {
    try {
        const raw = sessionStorage.getItem(storageKey(slug));
        const saved: SavedCheckoutState = raw ? JSON.parse(raw) : {};
        if (saved.tierIndex == null && saved.stepIndex != null) saved.tierIndex = saved.stepIndex;
        return saved;
    } catch {
        return {};
    }
}

function useCompact() {
    const query = '(max-width: 639px)';
    const [compact, setCompact] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const mq = window.matchMedia(query);
        const on = () => setCompact(mq.matches);
        mq.addEventListener('change', on);
        return () => mq.removeEventListener('change', on);
    }, []);
    return compact;
}

function buildFallbackSteps(listing: PublicListing): SimulationStep[] {
    const plans = [...listing.plans].sort((a, b) => a.max_lots - b.max_lots || a.price - b.price);
    const baseLots = plans[0]?.max_lots ?? 1;
    const baseCap = listing.min_capital && listing.min_capital > 0 ? listing.min_capital : 3000;
    const unitCap = baseCap / (baseLots || 1);
    const unitNet = listing.stats.per_lot ?? (listing.stats.net / (baseLots || 1));
    const unitDd = Math.round((unitCap * (listing.stats.max_drawdown_pct ?? 10)) / 100);
    const step = (lots: number, p?: (typeof plans)[number]): SimulationStep => ({
        plan_id: p?.id ?? null,
        name: p?.name ?? `${lots} ${lots === 1 ? 'contrato' : 'contratos'}`,
        lots,
        price: p ? p.price : listing.price,
        currency: p?.currency ?? listing.currency,
        days: p?.days ?? listing.default_days,
        recommended_capital: Math.round(unitCap * lots),
        simulated_profit: Math.round(unitNet * lots * 100) / 100,
        max_drawdown: Math.round(unitDd * lots * 100) / 100,
    });
    return plans.length > 0 ? plans.map(p => step(p.max_lots, p)) : [1, 2, 3, 5, 10].map(lots => step(lots));
}

// Where the client is: the named stages on a wide screen, a bar and "Etapa 2 de 4" on a phone. The portfolio's name
// is in the order, so it is not repeated here
function Progress({ stages, current, pct, onBack }: { stages: StageId[]; current: number; pct: number; onBack: () => void }) {
    const label = STAGE_LABELS[stages[current]];
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <button type="button" onClick={onBack}
                    className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                    <ArrowLeft className="size-4" /> Voltar
                </button>
                <p className="min-w-0 truncate text-xs text-muted-foreground sm:hidden">Etapa {current + 1} de {stages.length} · {label}</p>
            </div>
            <ol className="hidden grid-flow-col gap-2 border-b border-border pb-4 sm:grid" aria-label="Etapas da assinatura">
                {stages.map((s, i) => (
                    <li key={s} aria-current={i === current ? 'step' : undefined}
                        className={cn('flex items-center gap-2 text-[13px] lg:text-sm', i === current ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground')}>
                        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px]',
                            i < current && 'border-success bg-success text-success-foreground',
                            i === current && 'border-primary bg-primary text-primary-foreground',
                            i > current && 'border-border')}>
                            {i < current ? <CheckCircle2 className="size-3.5" /> : i + 1}
                        </span>
                        {STAGE_LABELS[s]}
                    </li>
                ))}
            </ol>
            <div className="h-1 w-full overflow-hidden rounded-full bg-secondary sm:hidden" role="progressbar" aria-label="Progresso da assinatura"
                aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`Etapa ${current + 1} de ${stages.length}: ${label}`}>
                <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

export default function CheckoutPage() {
    const { slug = '' } = useParams();
    const [params, setParams] = useSearchParams();
    const location = useLocation();
    const navigate = useNavigate();
    const { user, login } = useAuth();
    const compact = useCompact();
    const urlCode = params.get('codigo')?.trim() ?? '';
    const [saved] = useState(() => readSaved(slug));
    const [startedAsGuest] = useState(() => saved.startedAsGuest ?? !user); // The stages on screen are decided once

    const [listing, setListing] = useState<PublicListing | null>(null);
    const [simulation, setSimulation] = useState<PortfolioSimulation | null>(null);
    const [missing, setMissing] = useState(false);
    const [me, setMe] = useState<Me | null>(null);
    const [mine, setMine] = useState<ClientLicense | null>(null);
    const [copiers, setCopiers] = useState<number | null>(null);

    const [tierIdx, setTierIdx] = useState<number | null>(saved.tierIndex ?? null);
    const [customCapital, setCustomCapital] = useState<number | null>(saved.customCapital ?? null);
    const [wantsHosting, setWantsHosting] = useState<boolean | null>(saved.wantsHosting ?? null);
    const [email, setEmail] = useState(saved.email ?? '');
    const [emailExists, setEmailExists] = useState<boolean | null>(saved.emailExists ?? null);
    const [name, setName] = useState(saved.name ?? '');
    const [password, setPassword] = useState('');
    const [cpf, setCpf] = useState('');
    const [fieldError, setFieldError] = useState<{ field: 'email' | 'name' | 'password' | 'cpf' | 'form'; message: string } | null>(null);
    const [cpfTaken, setCpfTaken] = useState(false);
    const [busy, setBusy] = useState(false);
    const [risk, setRisk] = useState(false);
    const [code, setCode] = useState(urlCode);
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
            })
            .catch(e => { console.error(e); if (!cancelled) setMissing(true); });
        api.get<PublicFollowerStats>(`/api/marketplace/${slug}/followers`, { params: { days: 90 } })
            .then(res => { if (!cancelled && res.data.enough && res.data.followers) setCopiers(res.data.followers); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [slug]);

    const loadMe = useCallback(() => {
        if (!user) return;
        api.get<Me>('/me').then(res => setMe(res.data)).catch(e => console.error(e));
    }, [user]);

    useEffect(() => {
        loadMe();
        if (user?.role !== 'CLIENT') return;
        api.get<MyLicenses>('/me/licenses')
            .then(res => setMine(res.data.licenses.find(l => l.listing_slug === slug) ?? null))
            .catch(e => console.error(e));
    }, [user, slug, loadMe]);

    // Back from confirming the email in another tab: the free days unlock without a reload
    useEffect(() => {
        const onVisible = () => { if (document.visibilityState === 'visible') loadMe(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [loadMe]);

    useEffect(() => {
        try {
            const payload: SavedCheckoutState = { tierIndex: tierIdx ?? undefined, wantsHosting, email, emailExists, name, customCapital, startedAsGuest };
            sessionStorage.setItem(storageKey(slug), JSON.stringify(payload));
        } catch {
            // Storage unavailable
        }
    }, [slug, tierIdx, wantsHosting, email, emailExists, name, customCapital, startedAsGuest]);

    const steps = useMemo<SimulationStep[]>(() => {
        if (!listing) return [];
        const unit = unitOf(listing.markets);
        const base = simulation && simulation.steps.length > 0 ? simulation.steps : buildFallbackSteps(listing);
        return base.map(s => ({ ...s, unit }));
    }, [simulation, listing]);

    // A reminder's link names the contracts; otherwise the level chosen before, or the first
    const wantedLots = Number(params.get('contratos'));
    const linkedIdx = wantedLots > 0 ? steps.findIndex(s => Math.abs(s.lots - wantedLots) < 1e-9) : -1;
    const tierIndex = Math.min(Math.max(0, tierIdx ?? (linkedIdx >= 0 ? linkedIdx : 0)), Math.max(0, steps.length - 1));
    const tier = steps[tierIndex] ?? null;

    const promo = urlCode !== '' && listing?.has_promo === true;
    const hostingOffered = listing != null && listing.hosting_allowed && listing.hosting_room === true;
    const loggedIn = user != null;
    const flowFor = useCallback((exists: boolean | null, authed: boolean) => buildFlow({
        promo, loggedIn: authed, hosting: hostingOffered, emailExists: exists, compact,
    }), [promo, hostingOffered, compact]);
    const flow = useMemo(() => flowFor(emailExists, loggedIn), [flowFor, emailExists, loggedIn]);
    const stages = useMemo(() => buildStages({ promo, startedAsGuest, hosting: hostingOffered }), [promo, startedAsGuest, hostingOffered]);

    const wanted = params.get('passo');
    let step: StepId = resolveStep(wanted, flow, { loggedIn, hasEmail: EMAIL.test(email), promo });
    // A refresh forgets the password: its screen comes back before the CPF's
    if (step === 'cpf' && password.length < PASSWORD_MIN) step = 'name';
    const progress = progressOf(step, flow, stages, promo);

    // The address always names the screen on it, so the browser's back and a refresh work step by step
    useEffect(() => {
        if (!listing || wanted === step) return;
        setParams(p => { p.set('passo', step); return p; }, { replace: true, state: location.state });
    }, [listing, wanted, step, setParams, location.state]);

    const base = { slug, logged_in: loggedIn, promo };
    useEffect(() => {
        if (listing) track('checkout_step_view', { ...base, step, stage: stageOf(step, promo) });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per screen
    }, [listing != null, step]);

    const goTo = (next: StepId) => {
        setFieldError(null);
        setParams(p => { p.set('passo', next); return p; }, { state: { checkout: true } });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const goNext = (from: StepId, nextFlow = flow) => {
        track('checkout_step_complete', {
            ...base, step: from, stage: stageOf(from, promo), lots: tier?.lots, wants_hosting: wantsHosting,
        });
        const idx = nextFlow.indexOf(from);
        if (idx >= 0 && idx + 1 < nextFlow.length) goTo(nextFlow[idx + 1]);
    };

    const goBack = () => {
        setFieldError(null);
        if ((location.state as { checkout?: boolean } | null)?.checkout) { navigate(-1); return; }
        const idx = flow.indexOf(step);
        if (idx > 0) {
            setParams(p => { p.set('passo', flow[idx - 1]); return p; }, { replace: true });
            return;
        }
        navigate(`/marketplace/${slug}${urlCode ? `?codigo=${encodeURIComponent(urlCode)}` : ''}`);
    };

    // The visitor's email and choices, so the simulation can be sent if it stops here. Never blocks the flow
    const saveLead = (fields: { lots?: number; wants_hosting?: boolean | null; step: StepId }, to = email) => {
        if (loggedIn || promo || !EMAIL.test(to)) return;
        api.post(`/api/marketplace/${slug}/lead`, { email: to, ...fields, wants_hosting: fields.wants_hosting ?? undefined }).catch(() => undefined);
    };

    if (missing) {
        return <div className="px-4 py-10"><EmptyState icon={<Store />} title="Portfólio não encontrado" description="Ele pode ter saído do marketplace." /></div>;
    }
    if (!listing || !tier) return <CheckoutSkeleton />;

    // A manager's or the platform's account cannot subscribe: said here, not at the last click
    if (user && user.role !== 'CLIENT') {
        return (
            <div className="mx-auto max-w-xl px-4 py-10">
                <EmptyState icon={<UserX />} title="Entre com uma conta de cliente para assinar"
                    description="Esta conta é de gestor ou da plataforma. Para copiar um portfólio, use uma conta de cliente."
                    action={<Link to="/dashboard"><Button variant="outline">Ir para o meu painel</Button></Link>} />
            </div>
        );
    }

    const currency = simulation?.currency ?? listing.currency ?? 'BRL';

    const handleEmail = async (e: FormEvent) => {
        e.preventDefault();
        const trimmed = email.trim().toLowerCase();
        if (!EMAIL.test(trimmed)) { setFieldError({ field: 'email', message: 'Digite um email válido para continuar.' }); return; }
        setBusy(true);
        try {
            const res = await api.post<{ exists: boolean }>('/auth/email-check', { email: trimmed });
            setEmail(trimmed);
            setEmailExists(res.data.exists);
            saveLead({ lots: tier.lots, step: 'email' }, trimmed);
            goNext('email', flowFor(res.data.exists, false));
        } catch (err) {
            setFieldError({ field: 'email', message: apiError(err, 'Não foi possível verificar seu email agora.') });
        } finally {
            setBusy(false);
        }
    };

    const handleLogin = async (e: FormEvent) => {
        e.preventDefault();
        if (!password) { setFieldError({ field: 'password', message: 'Digite sua senha para entrar.' }); return; }
        setBusy(true);
        try {
            const form = new URLSearchParams();
            form.append('username', email.trim());
            form.append('password', password);
            const res = await api.post<{ access_token: string }>('/token', form);
            login(res.data.access_token);
            toast.success('Bem-vindo de volta!');
            goTo('summary');
        } catch (err) {
            setFieldError({ field: 'password', message: apiError(err, 'Senha incorreta. Tente de novo ou recupere sua senha.') });
        } finally {
            setBusy(false);
        }
    };

    const register = async () => {
        setBusy(true);
        setCpfTaken(false);
        try {
            const res = await api.post<{ access_token: string }>('/register', {
                email: email.trim().toLowerCase(), password, name: name.trim(), cpf: cleanCpf(cpf), terms_accepted: true,
            });
            if (promo) {
                // The confirmation link may open in another tab: it offers the way back here
                try { localStorage.setItem(AFTER_VERIFY_KEY, `/assinar/${slug}?codigo=${encodeURIComponent(code)}&passo=summary`); } catch { /* Storage unavailable */ }
            }
            login(res.data.access_token);
            toast.success(`Conta criada, ${name.trim().split(' ')[0]}!`);
            track('checkout_step_complete', { ...base, step: 'register', stage: 'account' });
            goTo('summary');
        } catch (err) {
            const status = (err as { response?: { status?: number } }).response?.status;
            const message = apiError(err, 'Não foi possível concluir seu cadastro.');
            if (status === 409 && message.includes('CPF')) setCpfTaken(true);
            else if (status === 409) { setEmailExists(true); toast.info('Este email já tem conta: entre com a sua senha.'); goTo('login_password'); }
            else setFieldError({ field: compact ? 'cpf' : 'form', message });
        } finally {
            setBusy(false);
        }
    };

    const nameOk = () => name.trim().length >= 2;
    const passwordOk = () => password.length >= PASSWORD_MIN;
    const otherEmail = () => { setCpfTaken(false); setPassword(''); setEmailExists(null); goTo('email'); };

    const handleDetails = (e: FormEvent) => {
        e.preventDefault();
        if (!nameOk()) { setFieldError({ field: 'name', message: 'Informe como podemos chamar você.' }); return; }
        if (!passwordOk()) { setFieldError({ field: 'password', message: `Sua senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.` }); return; }
        if (!isValidCpf(cpf)) { setFieldError({ field: 'cpf', message: 'Confira os números: este CPF não é válido.' }); return; }
        setFieldError(null);
        void register();
    };

    const handleSubscribe = async () => {
        if (!risk) return;
        setBusy(true);
        try {
            const payload: Record<string, unknown> = { wants_hosting: hostingOffered ? wantsHosting === true : false, risk_ack: true };
            if (listing.pay_online && tier.plan_id != null) payload.plan_id = tier.plan_id;
            track('checkout_submit', { ...base, pay_online: listing.pay_online, plan_id: tier.plan_id, lots: tier.lots, wants_hosting: payload.wants_hosting as boolean });
            const res = await api.post<Subscription>(`/api/marketplace/${listing.slug}/subscribe`, payload);
            sessionStorage.removeItem(storageKey(slug));
            if (res.data.listing.pay_online) { await openCheckout(res.data.id); return; }
            setDone(res.data);
            if (res.data.listing.checkout_url) window.open(res.data.listing.checkout_url, '_blank', 'noopener,noreferrer');
        } catch (err) {
            toast.error(apiError(err, 'Não foi possível enviar o pedido de assinatura.'));
        } finally {
            setBusy(false);
        }
    };

    const handleRedeem = async (value: string) => {
        if (!risk || !value.trim()) return;
        setBusy(true);
        try {
            track('checkout_submit', { ...base, promo: true, pay_online: false });
            const res = await api.post<ClientLicense>(`/api/marketplace/${listing.slug}/redeem`, { code: value.trim(), risk_ack: true });
            sessionStorage.removeItem(storageKey(slug));
            try { localStorage.removeItem(AFTER_VERIFY_KEY); } catch { /* Storage unavailable */ }
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

    const fe = (field: 'email' | 'name' | 'password' | 'cpf') => (fieldError?.field === field ? fieldError.message : null);
    const editName = (v: string) => { setName(v); setFieldError(null); };
    const editPassword = (v: string) => { setPassword(v); setFieldError(null); };
    const editCpf = (v: string) => { setCpf(v); setFieldError(null); setCpfTaken(false); };
    const unverified = me != null && me.email_enabled && !me.email_verified;
    const order = { listing, tier, promo, code, wantsHosting, periodLabel, copiers };
    // What the email will get, in one line: the plan and how it would have gone (its price is in the order beside)
    const preview = (
        <p>
            <span className="font-medium">{planTitle(tier)}:</span>{' '}
            <span className={cn('font-medium', tier.simulated_profit >= 0 ? 'text-success' : 'text-destructive')}>{signedMoney(tier.simulated_profit, currency)}</span>
            <span className="text-muted-foreground">{simulation ? ` em ${periodWords(simulation.days)}` : ''}, maior queda de {formatMoney(tier.max_drawdown, currency)}</span>
        </p>
    );
    const handleName = (e: FormEvent) => {
        e.preventDefault();
        if (!nameOk()) { setFieldError({ field: 'name', message: 'Informe como podemos chamar você.' }); return; }
        if (!passwordOk()) { setFieldError({ field: 'password', message: `Sua senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.` }); return; }
        goNext('name');
    };

    return (
        // A wide screen: the steps on one half and the order on the other, each to the edge of the screen. Below
        // that the order is a line that opens under the progress
        <CheckoutColumns
            mainClassName={step === 'summary' ? 'pb-56 sm:pb-10' : 'pb-28 sm:pb-10'}
            side={<OrderSummary {...order} />}
            main={
                <div className="space-y-6">
                    <Progress stages={stages} current={progress.index} pct={progress.pct} onBack={goBack} />

                    {step !== 'summary' && <OrderBar {...order} className="lg:hidden" />}

                    {mine && !done && (
                        <p className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
                            <span className="flex items-center gap-2"><CheckCircle2 className="size-4 shrink-0 text-success" />
                                Você já copia este portfólio{mine.mt5_login != null ? ` na conta ${mine.mt5_login}` : ''}. Pode assinar para outra conta MT5.</span>
                            <Link to={`/client/licenses/${mine.id}`} className="font-medium text-primary underline-offset-4 hover:underline">Ver minha cópia <ArrowRight className="inline size-3.5" /></Link>
                        </p>
                    )}

                    {step === 'contracts' && (
                        <ContractsStep steps={steps} tierIdx={tierIndex} onTier={setTierIdx} simulation={simulation} currency={currency}
                            customCapital={customCapital} onCapital={setCustomCapital} onContinue={() => goNext('contracts')} />
                    )}
                    {step === 'email' && (
                        <EmailStep email={email} onEmail={v => { setEmail(v); setFieldError(null); }} error={fe('email')} busy={busy} promo={promo}
                            preview={preview} onSubmit={handleEmail} />
                    )}
                    {step === 'hosting' && (
                        <HostingStep value={wantsHosting} onChange={setWantsHosting} price={listing.hosting_price}
                            onContinue={() => { saveLead({ wants_hosting: wantsHosting, step: 'hosting' }); goNext('hosting'); }} />
                    )}
                    {step === 'login_password' && (
                        <LoginStep email={email} password={password} onPassword={editPassword} error={fe('password')} busy={busy}
                            onOtherEmail={otherEmail} onSubmit={handleLogin} />
                    )}
                    {step === 'name' && (
                        <NameStep email={email} name={name} onName={editName} password={password} onPassword={editPassword}
                            error={fieldError} onOtherEmail={otherEmail} onSubmit={handleName} />
                    )}
                    {step === 'cpf' && (
                        <CpfStep cpf={cpf} onCpf={editCpf} error={fe('cpf')} taken={cpfTaken ? { onOtherEmail: otherEmail } : null} busy={busy}
                            onSubmit={e => { e.preventDefault(); if (isValidCpf(cpf)) void register(); else setFieldError({ field: 'cpf', message: 'Confira os números: este CPF não é válido.' }); }} />
                    )}
                    {step === 'details' && (
                        <DetailsStep email={email} name={name} onName={editName} password={password} onPassword={editPassword} cpf={cpf} onCpf={editCpf}
                            error={fieldError} taken={cpfTaken ? { onOtherEmail: otherEmail } : null} busy={busy} onOtherEmail={otherEmail} onSubmit={handleDetails} />
                    )}
                    {step === 'summary' && (promo ? (
                        <PromoSummary listing={listing} code={code} onCode={setCode} email={me?.email ?? email} unverified={unverified}
                            risk={risk} onRisk={setRisk} busy={busy} onRedeem={() => handleRedeem(code)}
                            onPreferPay={() => navigate(`/assinar/${slug}?passo=contracts`)} />
                    ) : (
                        <PaySummary listing={listing} tier={tier} periodLabel={periodLabel} wantsHosting={wantsHosting}
                            copiers={copiers} risk={risk} onRisk={setRisk} busy={busy} done={done} onEdit={goTo}
                            onSubscribe={handleSubscribe} onRedeem={handleRedeem} />
                    ))}

                    <footer className="space-y-1 border-t border-border pt-5 text-xs text-muted-foreground">
                        <p>Resultados passados não garantem resultados futuros. Operar no mercado envolve risco de perda.</p>
                        <p className="space-x-3">
                            <a href={TERMS_PATH} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Termos de Uso</a>
                            <a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Privacidade</a>
                        </p>
                    </footer>
                </div>
            }
        />
    );
}
