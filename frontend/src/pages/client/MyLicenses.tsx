import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { ChevronRight, KeyRound, Monitor, Server, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLicense, type MyLicenses as MyLicensesData } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import MySubscriptions, { EmailReminder } from '../../components/client/MySubscriptions';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { copyState } from '../../lib/clientLicense';
import { apiError, formatDate } from '../../lib/utils';

const POLL_MS = 15_000; // A hosted terminal changes state on its own

type ClaimForm = { code: string };

export default function MyLicenses() {
    const [data, setData] = useState<MyLicensesData | null>(null);
    const [failed, setFailed] = useState(false);
    const [reload, setReload] = useState(0); // Bumped to load again now, after adding a license
    const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<ClaimForm>();

    useEffect(() => {
        const load = () => api.get<MyLicensesData>('/me/licenses')
            .then(res => { setData(res.data); setFailed(false); })
            .catch(e => { console.error(e); setFailed(true); });
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => window.clearInterval(timer);
    }, [reload]);

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
                title="Minhas licenças"
                description="Os portfólios que você copia, a conta MT5 de cada um e como a cópia está agora."
                icon={<KeyRound />}
            />

            <EmailReminder />
            <MySubscriptions />

            <Card
                title="Adicionar licença"
                description="Quem vendeu a licença envia um código de acesso. Ele vale uma vez só."
                icon={<Ticket />}
            >
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
            </Card>

            {data === null ? (
                <p className="text-sm text-muted-foreground">
                    {failed ? 'Não foi possível carregar as licenças. Tentando de novo...' : 'Carregando...'}
                </p>
            ) : licenses.length === 0 ? (
                <div className="panel">
                    <EmptyState
                        icon={<KeyRound />}
                        title="Nenhuma licença ainda"
                        description="Assine um portfólio no Marketplace, ou adicione a licença com o código de acesso que você recebeu de quem a vendeu."
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
                                    <Badge variant={state.variant}>{state.label}</Badge>
                                </div>
                                {state.detail && <p className="mt-2 text-xs text-muted-foreground">{state.detail}</p>}
                                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Conta MT5</dt>
                                        <dd className="font-mono font-semibold">{l.mt5_login ?? '—'}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Limite</dt>
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
                                        Abrir <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
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
