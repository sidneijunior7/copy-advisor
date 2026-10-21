import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import api, { type MyLicenses, type Subscription } from '../../api';
import Card from '../../components/Card';
import ClientHosting from '../../components/client/ClientHosting';
import ConnectAccount from '../../components/client/ConnectAccount';
import CopyToggle from '../../components/client/CopyToggle';
import ClientPerformance from '../../components/client/ClientPerformance';
import ClientSettingsForm from '../../components/client/ClientSettingsForm';
import { ClientIssues, CopiesTable } from '../../components/client/CopiesTable';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { copyState } from '../../lib/clientLicense';
import { SIZING_LABELS, SLTP_LABELS } from '../../lib/labels';
import { apiError, cn, formatDate } from '../../lib/utils';

const POLL_MS = 15_000;

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

    useEffect(() => {
        const load = () => api.get<MyLicenses>('/me/licenses')
            .then(res => { setData(res.data); setFailed(false); })
            .catch(e => { console.error(e); setFailed(true); });
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => window.clearInterval(timer);
    }, [reload]);

    const license = data?.licenses.find(l => String(l.id) === id);

    if (!license) {
        return (
            <div className="space-y-6">
                <Link to="/client" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="size-4" /> Minhas licenças
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

    const renew = async () => {
        setRenewing(true);
        try {
            const res = await api.post<Subscription>(`/me/licenses/${license.id}/renew`);
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
            <Link to="/client" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> Minhas licenças
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

            {license.mt5_login == null && <ConnectAccount license={license} onDone={refresh} />}

            {license.mt5_login != null && <>
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
                                    <dd>{license.expires_at ? formatDate(license.expires_at) : 'Sem validade'}</dd>
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
                            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                                {renewal ? (
                                    <>
                                        <p className="text-sm text-muted-foreground">Renovação pedida.</p>
                                        {renewal.listing.checkout_url && (
                                            <a href={renewal.listing.checkout_url} target="_blank" rel="noopener noreferrer">
                                                <Button size="sm"><ExternalLink /> Pagar</Button>
                                            </a>
                                        )}
                                    </>
                                ) : (
                                    <Button size="sm" variant="outline" loading={renewing} onClick={renew}>
                                        {!renewing && <RefreshCw />} Renovar
                                    </Button>
                                )}
                            </div>
                        </Card>
                    </div>
                    <ClientHosting
                        license={license}
                        available={data?.hosting_available ?? false}
                        servers={data?.servers ?? []}
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
