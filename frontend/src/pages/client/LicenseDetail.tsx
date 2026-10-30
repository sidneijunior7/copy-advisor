import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import api, { type MyLicenses, type Subscription } from '../../api';
import Card from '../../components/Card';
import BillingCard from '../../components/client/BillingCard';
import ClientHosting from '../../components/client/ClientHosting';
import ActivationWizard from '../../components/client/ActivationWizard';
import CopyToggle from '../../components/client/CopyToggle';
import ClientPerformance from '../../components/client/ClientPerformance';
import ClientSettingsForm from '../../components/client/ClientSettingsForm';
import { ClientIssues, CopiesTable } from '../../components/client/CopiesTable';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import PlanPicker from '../../components/PlanPicker';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { copyState, needsSetup, onFreeDays, validityLabel } from '../../lib/clientLicense';
import { SIZING_LABELS, SLTP_LABELS } from '../../lib/labels';
import { openCheckout } from '../../lib/stripe';
import { apiError, cn, formatDate, parseUtc } from '../../lib/utils';

const POLL_MS = 15_000;
const MIN_TRIAL_MS = 49 * 3600_000; // Stripe waits for the end only this far ahead (payments.MIN_TRIAL)

const TABS = [
    { id: 'overview', label: 'Visão geral' },
    { id: 'performance', label: 'Desempenho' },
    { id: 'copies', label: 'Cópias' },
    { id: 'settings', label: 'Ajustes' },
    { id: 'issues', label: 'Problemas' },
] as const;
type Tab = typeof TABS[number]['id'];

export default function LicenseDetail() {
    const { id } = useParams();
    const [data, setData] = useState<MyLicenses | null>(null);
    const [failed, setFailed] = useState(false);
    const [tab, setTab] = useState<Tab>('overview');
    const [reload, setReload] = useState(0); // Bumped to load again now, after a change
    const refresh = () => setReload(n => n + 1);
    const [renewal, setRenewal] = useState<Subscription | null>(null);
    const [renewing, setRenewing] = useState(false);
    const [planId, setPlanId] = useState<number | null>(null);
    const [params, setParams] = useSearchParams();
    const [offerOpen] = useState(() => params.get('hospedar') === '1'); // A "yes" to the hosting offer on Subscriptions
    // The activation stays on screen from the first look at a license being set up until the client leaves it;
    // back from the hosting's Checkout, it shows the terminal starting
    const [wizard, setWizard] = useState<boolean | null>(() => (params.get('hospedagem') === 'ok' ? true : null));

    // Back from the hosting's Checkout: the webhook takes it within seconds, sooner than the next poll
    useEffect(() => {
        if (params.get('hospedagem') !== 'ok') return;
        toast.success('Pagamento da hospedagem recebido', { description: 'O terminal liga em instantes. Acompanhe o estado aqui.' });
        const timers = [3_000, 8_000].map(ms => window.setTimeout(refresh, ms));
        setParams({}, { replace: true });
        return () => timers.forEach(t => window.clearTimeout(t));
        // Once, on arrival: clearing the address must not cancel the reloads
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const load = () => api.get<MyLicenses>('/me/licenses')
            .then(res => { setData(res.data); setFailed(false); })
            .catch(e => { console.error(e); setFailed(true); });
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => window.clearInterval(timer);
    }, [reload]);

    const license = data?.licenses.find(l => String(l.id) === id);
    const setup = license ? needsSetup(license) : false;
    useEffect(() => {
        if (license && wizard === null) setWizard(setup);
    }, [license, wizard, setup]);
    // Faster while waiting on the EA or the terminal to connect
    useEffect(() => {
        if (!wizard) return;
        const timer = window.setInterval(refresh, 5_000);
        return () => window.clearInterval(timer);
    }, [wizard]);

    if (!license) {
        return (
            <div className="space-y-6">
                <Link to="/client/licenses" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="size-4" /> Minhas cópias
                </Link>
                {data === null ? (
                    <p className="text-sm text-muted-foreground">{failed ? 'Não foi possível carregar a licença.' : 'Carregando...'}</p>
                ) : (
                    <div className="panel">
                        <EmptyState icon={<KeyRound />} title="Licença não encontrada" description="Ela pode ter sido desvinculada da sua conta." />
                    </div>
                )}
            </div>
        );
    }

    const state = copyState(license);
    const free = onFreeDays(license);
    // More than one plan: the client picks (a license from a launch code never had one)
    const choosePlan = license.renew_plans.length > 1;
    const plan = planId ?? license.billing?.plan?.id ?? license.renew_plans[0]?.id ?? null;
    // Subscribing in Stripe with this much left charges only when the license ends
    const chargesAtEnd = license.renew_plans.length > 0 && license.expires_at != null
        && parseUtc(license.expires_at).getTime() - Date.now() > MIN_TRIAL_MS;

    const renew = async () => {
        setRenewing(true);
        try {
            const res = await api.post<Subscription>(`/me/licenses/${license.id}/renew`, choosePlan ? { plan_id: plan } : {});
            if (res.data.listing.pay_online) {
                await openCheckout(res.data.id); // Charged only when the current validity ends
                return;
            }
            setRenewal(res.data);
            toast.success('Pedido de renovação enviado', { description: 'O gestor estende a validade depois do pagamento.' });
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível pedir a renovação.'));
        } finally {
            setRenewing(false);
        }
    };
    const s = license.settings;

    return (
        <div className="space-y-6">
            <Link to="/client/licenses" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> Minhas cópias
            </Link>
            <PageHeader
                title={license.portfolio.name ?? `Portfólio #${license.portfolio.id}`}
                description={`${license.mt5_login != null ? `Conta MT5 ${license.mt5_login}` : 'Sem conta MT5 ainda'}${license.manager ? ` · por ${license.manager}` : ''}`}
                icon={<Briefcase />}
            >
                <div className="flex flex-wrap items-center gap-3">
                    <CopyToggle
                        licenseId={license.id}
                        isPaused={Boolean(license.is_paused)}
                        disabled={!license.valid}
                        traderName={license.portfolio.name ?? undefined}
                        onChanged={refresh}
                    />
                    <Badge variant={state.variant} className="text-sm">{state.label}</Badge>
                </div>
            </PageHeader>

            {(setup || wizard) && data && (
                <ActivationWizard license={license} data={data} onChanged={refresh} onDone={() => setWizard(false)} />
            )}

            {!setup && !wizard && <>
            <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-border scrollbar-none">
                {TABS.map(t => (
                    <button
                        key={t.id}
                        role="tab"
                        aria-selected={tab === t.id}
                        onClick={() => setTab(t.id)}
                        className={cn('whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                            tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {tab === 'overview' && (
                <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
                    <div className="space-y-6">
                        <Card title="Situação" icon={<KeyRound />}>
                            <div className="space-y-2 text-sm">
                                <Badge variant={state.variant}>{state.label}</Badge>
                                {state.detail && <p className="text-muted-foreground">{state.detail}</p>}
                            </div>
                        </Card>
                        <Card title="Licença" icon={<Briefcase />}>
                            <dl className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                    <dt className="text-xs text-muted-foreground">Limite de lotes</dt>
                                    <dd className="font-mono">{license.max_lots.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">Validade</dt>
                                    <dd>{validityLabel(license)}</dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">Tamanho</dt>
                                    <dd>
                                        {SIZING_LABELS[s.sizing_mode ?? 'factor']}, fator {(s.lots_factor ?? 1).toLocaleString('pt-BR')}
                                        {s.sizing_mode && s.sizing_mode !== 'factor' && s.reference_capital != null && `, capital ${s.reference_capital.toLocaleString('pt-BR')}`}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">SL/TP</dt>
                                    <dd>{SLTP_LABELS[s.sltp_mode ?? 'distance']}</dd>
                                </div>
                            </dl>
                            {!license.billing?.renewing && (
                            <div className="mt-4 space-y-3 border-t border-border pt-4">
                                {renewal ? (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-sm text-muted-foreground">Renovação pedida.</p>
                                        {renewal.listing.checkout_url && (
                                            <a href={renewal.listing.checkout_url} target="_blank" rel="noopener noreferrer">
                                                <Button size="sm"><ExternalLink /> Pagar</Button>
                                            </a>
                                        )}
                                    </div>
                                ) : (
                                    <>
                                        {choosePlan && <PlanPicker plans={license.renew_plans} value={plan} onChange={setPlanId} name={`renovar-${license.id}`} />}
                                        {free && license.expires_at && (
                                            <p className="text-sm text-muted-foreground">
                                                {chargesAtEnd
                                                    ? `Assinando agora, você não perde nenhum dia: a cobrança só começa quando o grátis acabar, em ${formatDate(license.expires_at)}.`
                                                    : `Seu acesso grátis termina em ${formatDate(license.expires_at)}. Assine para continuar copiando.`}
                                            </p>
                                        )}
                                        <Button size="sm" variant={free ? 'default' : 'outline'} loading={renewing} disabled={choosePlan && plan == null} onClick={renew}>
                                            {!renewing && <RefreshCw />} {free ? 'Assinar' : 'Renovar'}
                                        </Button>
                                    </>
                                )}
                            </div>
                            )}
                        </Card>
                        {license.billing && <BillingCard billing={license.billing} onChanged={refresh} />}
                    </div>
                    <ClientHosting
                        license={license}
                        available={(data?.hosting_available && data.hosting_room) ?? false}
                        servers={data?.servers ?? []}
                        price={data?.hosting_price ?? null}
                        offerOpen={offerOpen}
                        onChanged={refresh}
                    />
                </div>
            )}
            {tab === 'performance' && <ClientPerformance license={license} />}
            {tab === 'copies' && <CopiesTable licenseId={license.id} />}
            {tab === 'settings' && <ClientSettingsForm key={JSON.stringify(license.settings)} license={license} onSaved={refresh} />}
            {tab === 'issues' && <ClientIssues licenseId={license.id} />}
            </>}
        </div>
    );
}
