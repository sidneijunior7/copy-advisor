import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { Check, KeyRound, Monitor, Pencil, Power, PowerOff, RefreshCw, Server, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLicense, type HostedTerminal, type HostingPrice } from '../../api';
import Card from '../Card';
import InlineConfirm from '../InlineConfirm';
import { HostingBillingBody } from './HostingBilling';
import { hostingPriceLabel } from '../../lib/money';
import OneTimeKey from '../OneTimeKey';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { HOSTING_STATES } from '../../lib/labels';
import { openHostingCheckout } from '../../lib/stripe';
import { apiError, formatAgo, formatDateTime } from '../../lib/utils';

// After "Com posições abertas, "
const UNMANAGED = 'elas ficam sem acompanhamento até a cópia voltar: o que o Master fizer não chega à sua conta.';

type HostingForm = { server: string; password: string };

interface ClientHostingProps {
    license: ClientLicense;
    available: boolean; // The server takes hosted terminals
    servers: string[]; // Broker servers our servers can log into
    price: HostingPrice | null; // Charged in Stripe, apart from the portfolio; null: not charged
    onChanged: () => void;
}

// Where the copy runs: a terminal we host for the client, or the EA on the client's own computer
export default function ClientHosting({ license, available, servers, price, onChanged }: ClientHostingProps) {
    const hosted = license.hosting;
    const [editing, setEditing] = useState(false);
    const [confirm, setConfirm] = useState<'pause' | 'remove' | 'key' | null>(null);
    const [busy, setBusy] = useState(false);
    const [key, setKey] = useState<string | null>(null);
    const { register, handleSubmit, watch, reset, formState: { errors, isSubmitting } } = useForm<HostingForm>({
        defaultValues: { server: hosted?.server ?? '', password: '' },
    });
    const server = watch('server').trim();

    const call = async (run: () => Promise<unknown>, success: string, failure: string) => {
        setBusy(true);
        try {
            await run();
            toast.success(success);
            setConfirm(null);
            onChanged();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, failure));
        } finally {
            setBusy(false);
        }
    };

    const save = async (data: HostingForm) => {
        try {
            const res = await api.put<HostedTerminal>(`/me/licenses/${license.id}/hosting`, {
                server: data.server.trim(),
                ...(data.password && { password: data.password }),
            });
            if (!hosted && !res.data.billing.paid) { // Kept: the terminal starts once Stripe takes the payment
                await openHostingCheckout(license.id);
                onChanged();
                return;
            }
            toast.success(hosted ? 'Hospedagem atualizada' : 'Conta hospedada', {
                description: 'O terminal inicia em instantes. Acompanhe o estado aqui.',
            });
            reset({ server: data.server.trim(), password: '' });
            setEditing(false);
            onChanged();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível salvar a hospedagem.'));
        }
    };

    const newKey = async () => {
        setBusy(true);
        try {
            const res = await api.post<{ license_key: string }>(`/me/licenses/${license.id}/key`);
            setKey(res.data.license_key);
            setConfirm(null);
            onChanged();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível gerar a chave.'));
        } finally {
            setBusy(false);
        }
    };

    const hostingForm = (
        <form onSubmit={handleSubmit(save)} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
                <Field
                    label="Servidor da corretora"
                    htmlFor={`server-${license.id}`}
                    error={errors.server?.message}
                    hint={server && servers.length > 0 && !servers.includes(server)
                        ? 'Ainda não atendemos este servidor: a conta não vai conectar.'
                        : 'Como aparece na tela de login do MetaTrader 5.'}
                >
                    <Input
                        {...register('server', {
                            required: 'Informe o servidor',
                            pattern: { value: /^[\w .-]+$/, message: 'Letras, números, espaço, ponto e hífen' },
                        })}
                        id={`server-${license.id}`}
                        list={`servers-${license.id}`}
                        autoComplete="off"
                        placeholder="Ex.: XPMT5-DEMO"
                    />
                    <datalist id={`servers-${license.id}`}>
                        {servers.map(s => <option key={s} value={s} />)}
                    </datalist>
                </Field>
                <Field
                    label="Senha da conta MT5"
                    htmlFor={`password-${license.id}`}
                    error={errors.password?.message}
                    hint={hosted ? 'Em branco, mantém a atual.' : 'A senha de negociação, não a de investidor. Fica cifrada e ninguém a vê.'}
                >
                    <Input
                        {...register('password', { required: hosted ? false : 'Informe a senha' })}
                        id={`password-${license.id}`}
                        type="password"
                        autoComplete="new-password"
                    />
                </Field>
            </div>
            <div className="flex flex-wrap justify-end gap-1">
                {hosted && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
                )}
                <Button size="sm" loading={isSubmitting}>
                    {!isSubmitting && <Check />} {hosted ? 'Salvar' : price ? 'Hospedar e ir para o pagamento' : 'Hospedar minha conta'}
                </Button>
            </div>
        </form>
    );

    if (hosted) {
        const { label, variant } = HOSTING_STATES[hosted.state] ?? { label: hosted.state, variant: 'muted' as const };
        return (
            <Card title="Hospedada com a gente" description="O MetaTrader da sua conta roda num servidor nosso, ligado o tempo todo." icon={<Server />}>
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant={variant}>{label}</Badge>
                        <span className="font-mono">{hosted.server}</span>
                        {hosted.status_at && <span className="text-xs text-muted-foreground">desde {formatDateTime(hosted.status_at)}</span>}
                    </div>
                    {hosted.detail && <p className="text-sm text-muted-foreground">{hosted.detail}</p>}
                    {!hosted.billing.exempt && (
                        <div className="border-t border-border pt-4">
                            <HostingBillingBody licenseId={license.id} billing={hosted.billing} price={price} onChanged={onChanged} />
                        </div>
                    )}

                    {confirm === 'pause' ? (
                        <InlineConfirm confirmLabel="Pausar" icon={<PowerOff />} loading={busy}
                            onConfirm={() => call(() => api.put(`/me/licenses/${license.id}/hosting`, { enabled: false }), 'Cópia pausada', 'Não foi possível pausar.')}
                            onCancel={() => setConfirm(null)}>
                            Pausar a cópia? Com posições abertas, {UNMANAGED}
                        </InlineConfirm>
                    ) : confirm === 'remove' ? (
                        <InlineConfirm confirmLabel="Remover hospedagem" icon={<Trash2 />} loading={busy}
                            onConfirm={() => call(() => api.delete(`/me/licenses/${license.id}/hosting`), 'Hospedagem removida', 'Não foi possível remover.')}
                            onCancel={() => setConfirm(null)}>
                            Remover a hospedagem? O terminal é fechado. Com posições abertas, {UNMANAGED} Para usar o EA no
                            seu computador, gere uma chave depois.
                            {hosted.billing.renewing && ' A assinatura da hospedagem é encerrada agora, sem reembolso do período em curso.'}
                        </InlineConfirm>
                    ) : editing ? hostingForm : (
                        <div className="flex flex-wrap gap-1">
                            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                                <Pencil /> Trocar senha ou servidor
                            </Button>
                            {hosted.enabled ? (
                                <Button size="sm" variant="ghost" onClick={() => setConfirm('pause')}><PowerOff /> Pausar</Button>
                            ) : (
                                <Button size="sm" variant="ghost" loading={busy}
                                    onClick={() => call(() => api.put(`/me/licenses/${license.id}/hosting`, { enabled: true }), 'Cópia retomada', 'Não foi possível retomar.')}>
                                    {!busy && <Power />} Retomar
                                </Button>
                            )}
                            <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => setConfirm('remove')}>
                                <Trash2 /> Remover
                            </Button>
                        </div>
                    )}
                </div>
            </Card>
        );
    }

    return (
        <div className="space-y-6">
            <Card title="EA no seu computador" description="O MetaTrader com o EA precisa ficar aberto durante o pregão." icon={<Monitor />}>
                <div className="space-y-4 text-sm">
                    <p>
                        {license.connection
                            ? <>EA {license.connection.ea_version} conectado{license.connection.last_ack_age_s != null && <>, último contato {formatAgo(license.connection.last_ack_age_s)}</>}.</>
                            : 'Nenhum EA conectado agora.'}
                    </p>
                    {key ? (
                        <OneTimeKey title="Chave da licença" value={key} label="Chave da licença" onClose={() => setKey(null)}>
                            Cole na entrada License key do EA. A chave anterior parou de funcionar.
                        </OneTimeKey>
                    ) : confirm === 'key' ? (
                        <InlineConfirm confirmLabel="Gerar nova chave" icon={<RefreshCw />} loading={busy} onConfirm={newKey} onCancel={() => setConfirm(null)}>
                            Gerar uma nova chave? A atual ({license.key_prefix}…) para de funcionar, e o EA que a usa é desconectado.
                        </InlineConfirm>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" variant="outline" loading={busy} onClick={() => (license.has_key ? setConfirm('key') : newKey())}>
                                {!busy && <KeyRound />} {license.has_key ? 'Gerar nova chave' : 'Gerar chave'}
                            </Button>
                            <Link to="/client/install" className="font-medium text-primary underline-offset-4 hover:underline">
                                Como instalar o EA
                            </Link>
                        </div>
                    )}
                </div>
            </Card>

            {available && (
                <Card
                    title="Prefere não deixar o computador ligado?"
                    description={price
                        ? `Hospede a conta com a gente por ${hostingPriceLabel(price)}, cobrado à parte da assinatura do portfólio. O MetaTrader roda num servidor nosso, ligado o tempo todo. Quando o pagamento passar, a licença ganha uma chave nova e o EA do seu computador é desconectado.`
                        : 'Hospede a conta com a gente: o MetaTrader roda num servidor nosso. A licença ganha uma chave nova, e o EA do seu computador é desconectado.'}
                    icon={<Server />}
                >
                    {hostingForm}
                </Card>
            )}
        </div>
    );
}
