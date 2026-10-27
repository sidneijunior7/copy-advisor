import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Monitor, Pencil, Power, PowerOff, RefreshCw, Server, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLicense, type HostingPrice } from '../../api';
import Card from '../Card';
import InlineConfirm from '../InlineConfirm';
import { HostingBillingBody } from './HostingBilling';
import HostingForm from './HostingForm';
import HostingOffer from './HostingOffer';
import OneTimeKey from '../OneTimeKey';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { HOSTING_STATES } from '../../lib/labels';
import { apiError, formatAgo, formatDateTime } from '../../lib/utils';

// After "Com posições abertas, "
const UNMANAGED = 'elas ficam sem acompanhamento até a cópia voltar: o que o Master fizer não chega à sua conta.';

interface ClientHostingProps {
    license: ClientLicense;
    available: boolean; // The server takes hosted terminals
    servers: string[]; // Broker servers our servers can log into
    price: HostingPrice | null; // Charged in Stripe, apart from the portfolio; null: not charged
    offerOpen?: boolean; // Came from a "yes" elsewhere: the credentials form is open already
    onChanged: () => void;
}

// "Not now" on the hosting offer, per license: it stays folded into one line
const laterKey = (licenseId: number) => `hosting-offer-later-${licenseId}`;

// Where the copy runs: a terminal we host for the client, or the EA on the client's own computer
export default function ClientHosting({ license, available, servers, price, offerOpen = false, onChanged }: ClientHostingProps) {
    const hosted = license.hosting;
    const [offer, setOffer] = useState<'offer' | 'form' | 'later'>(() =>
        offerOpen ? 'form' : localStorage.getItem(laterKey(license.id)) ? 'later' : 'offer');
    const [editing, setEditing] = useState(false);
    const [confirm, setConfirm] = useState<'pause' | 'remove' | 'key' | null>(null);
    const [busy, setBusy] = useState(false);
    const [key, setKey] = useState<string | null>(null);

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

    const hostingForm = (onCancel: (() => void) | undefined, cancelLabel?: string) => (
        <HostingForm license={license} servers={servers} price={price} onCancel={onCancel} cancelLabel={cancelLabel}
            onSaved={() => { setEditing(false); onChanged(); }} />
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
                    ) : editing ? hostingForm(() => setEditing(false)) : (
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
            {available && price && (
                <HostingOffer
                    price={price}
                    stage={license.has_key && !license.connection && offer === 'later' ? 'offer' : offer}
                    stopped={license.has_key && !license.connection}
                    onYes={() => { localStorage.removeItem(laterKey(license.id)); setOffer('form'); }}
                    onLater={() => { localStorage.setItem(laterKey(license.id), '1'); setOffer('later'); }}
                >
                    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
                        <p className="text-sm text-muted-foreground">
                            Informe o acesso da conta {license.mt5_login} e siga para o pagamento. O terminal liga assim que o
                            pagamento passar; nesse momento a licença ganha uma chave nova e o EA do seu computador é desconectado.
                        </p>
                        {hostingForm(() => setOffer('offer'), 'Voltar')}
                    </div>
                </HostingOffer>
            )}

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

            {available && !price && (
                <Card
                    title="Prefere não deixar o computador ligado?"
                    description="Hospede a conta com a gente: o MetaTrader roda num servidor nosso. A licença ganha uma chave nova, e o EA do seu computador é desconectado."
                    icon={<Server />}
                >
                    {hostingForm(undefined)}
                </Card>
            )}
        </div>
    );
}
