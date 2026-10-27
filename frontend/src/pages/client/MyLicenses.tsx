import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, KeyRound, Monitor, Server, Store, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLicense, type MyLicenses as MyLicensesData } from '../../api';
import CopyToggle from '../../components/client/CopyToggle';
import EmptyState from '../../components/EmptyState';
import { EmailReminder } from '../../components/client/MySubscriptions';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { copyState, needsSetup } from '../../lib/clientLicense';
import { apiError, formatDate } from '../../lib/utils';

const POLL_MS = 15_000; // A hosted terminal changes state on its own

type ClaimForm = { code: string };

export default function MyLicenses() {
    const [data, setData] = useState<MyLicensesData | null>(null);
    const [failed, setFailed] = useState(false);
    const [reload, setReload] = useState(0); // Bumped to load again now, after adding a license
    const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<ClaimForm>();
    const [params, setParams] = useSearchParams();
    const navigate = useNavigate();
    const [arrived] = useState(() => params.get('pagamento') === 'ok'); // Just paid: on to the new license's activation

    // Back from Stripe's Checkout: the webhook frees the license within seconds, sooner than the next poll
    useEffect(() => {
        if (params.get('pagamento') !== 'ok') return;
        toast.success('Pagamento recebido!', { description: 'Agora falta ativar a cópia: leva 2 minutos.' });
        const timers = [3_000, 8_000].map(ms => window.setTimeout(() => setReload(n => n + 1), ms));
        setParams({}, { replace: true });
        return () => timers.forEach(t => window.clearTimeout(t));
        // Once, on arrival: clearing the address must not cancel the reloads
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const load = () => api.get<MyLicensesData>('/me/licenses')
            .then(res => {
                setData(res.data);
                setFailed(false);
                const fresh = arrived && [...res.data.licenses].reverse().find(needsSetup);
                if (fresh) navigate(`/client/licenses/${fresh.id}`, { replace: true });
            })
            .catch(e => { console.error(e); setFailed(true); });
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => window.clearInterval(timer);
    }, [reload, arrived, navigate]);

    const onClaim = async ({ code }: ClaimForm) => {
        try {
            const res = await api.post<ClientLicense>('/me/licenses/claim', { code: code.trim() });
            reset();
            toast.success(`Licença de ${res.data.portfolio.name ?? 'portfólio'} adicionada`, {
                description: `Conta MT5 ${res.data.mt5_login}`,
            });
            setReload(n => n + 1);
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível adicionar a licença.'));
        }
    };

    const licenses = data?.licenses ?? [];

    return (
        <div className="space-y-6">
            <PageHeader
                title="Minhas cópias"
                description="Os gestores que você copia, a conta de cada um e se a cópia está funcionando agora."
                icon={<KeyRound />}
            />

            <EmailReminder />

            <details className="group panel">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-medium sm:px-5">
                    <span className="flex items-center gap-2"><Ticket className="size-4 text-primary" /> Recebeu um código de acesso de um gestor?</span>
                    <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-3 border-t border-border p-4 sm:px-5">
                    <p className="text-sm text-muted-foreground">Quem vendeu a cópia fora do Marketplace envia um código. Ele vale uma vez só.</p>
                    <form onSubmit={handleSubmit(onClaim)} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
                        <div className="flex-1 space-y-2">
                            <Input
                                {...register('code', {
                                    required: 'Informe o código',
                                    minLength: { value: 4, message: 'Código incompleto' },
                                })}
                                placeholder="Ex.: ABCD-EFGH-JKLM"
                                className="font-mono uppercase"
                                autoComplete="off"
                                aria-label="Código de acesso"
                            />
                            {errors.code && <p className="text-sm text-destructive">{errors.code.message}</p>}
                        </div>
                        <Button loading={isSubmitting}>{!isSubmitting && <Ticket />} Adicionar</Button>
                    </form>
                </div>
            </details>

            {data === null ? (
                <p className="text-sm text-muted-foreground">
                    {failed ? 'Não foi possível carregar as licenças. Tentando de novo...' : 'Carregando...'}
                </p>
            ) : licenses.length === 0 ? (
                <div className="panel">
                    <EmptyState
                        icon={<KeyRound />}
                        title="Você ainda não copia ninguém"
                        description="Escolha um gestor no Marketplace: depois de assinar, a cópia aparece aqui para você ativar."
                        action={<Link to="/marketplace"><Button><Store /> Ver gestores</Button></Link>}
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {licenses.map(l => {
                        const state = copyState(l);
                        return (
                            <Link
                                key={l.id}
                                to={`/client/licenses/${l.id}`}
                                className="panel group block p-5 transition-colors hover:border-primary/40"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-lg font-semibold">{l.portfolio.name ?? `Portfólio #${l.portfolio.id}`}</p>
                                        {l.manager && <p className="text-xs text-muted-foreground">por {l.manager}</p>}
                                    </div>
                                    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                        <CopyToggle
                                            licenseId={l.id}
                                            isPaused={Boolean(l.is_paused)}
                                            disabled={!l.valid}
                                            traderName={l.portfolio.name ?? undefined}
                                            onChanged={() => setReload(n => n + 1)}
                                            size="sm"
                                            showLabel={false}
                                        />
                                        <Badge variant={state.variant}>{state.label}</Badge>
                                    </div>
                                </div>
                                {state.detail && <p className="mt-2 text-xs text-muted-foreground">{state.detail}</p>}
                                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Conta MT5</dt>
                                        <dd className="font-mono font-semibold">{l.mt5_login ?? '—'}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Limite por ordem</dt>
                                        <dd className="font-mono">{l.max_lots.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} lotes</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Validade</dt>
                                        <dd>{l.expires_at ? formatDate(l.expires_at) : 'Sem validade'}</dd>
                                    </div>
                                </dl>
                                <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                                    <span className="inline-flex items-center gap-1.5">
                                        {l.hosting ? <><Server className="size-3.5" /> Hospedada com a gente</> : <><Monitor className="size-3.5" /> EA no seu computador</>}
                                    </span>
                                    <span className="inline-flex items-center gap-0.5 font-medium text-primary">
                                        {needsSetup(l) ? 'Ativar agora' : 'Abrir'} <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                                    </span>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
