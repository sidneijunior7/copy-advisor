import { useState } from 'react';
import { Ticket, UserMinus, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import api, { type License } from '../api';
import InlineConfirm from './InlineConfirm';
import OneTimeKey from './OneTimeKey';
import { Button } from './ui/Button';
import { apiError, formatDate, formatDateTime, isPast } from '../lib/utils';

interface ClientLinkPanelProps {
    license: License;
    onChange: (license: License) => void;
    onClose: () => void;
}

// Which client account sees this license in its dashboard, and the one-time code that links it
export default function ClientLinkPanel({ license, onChange, onClose }: ClientLinkPanelProps) {
    const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
    const [confirmUnlink, setConfirmUnlink] = useState(false);
    const [busy, setBusy] = useState(false);
    const login = license.client_mt5_login;
    const pending = license.claim_expires_at != null && !isPast(license.claim_expires_at);

    const generate = async () => {
        setBusy(true);
        try {
            const res = await api.post<{ code: string; expires_at: string }>(`/licenses/${license.id}/claim-code`);
            setCode(res.data);
            onChange({ ...license, claim_expires_at: res.data.expires_at });
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível gerar o código.'));
        } finally {
            setBusy(false);
        }
    };

    const unlink = async () => {
        setBusy(true);
        try {
            const res = await api.delete<License>(`/licenses/${license.id}/client`);
            onChange(res.data);
            setConfirmUnlink(false);
            toast.success(`Conta ${login} desvinculada do cliente`, { description: 'A cópia continua: o EA não depende do painel.' });
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível desvincular.'));
        } finally {
            setBusy(false);
        }
    };

    if (code) {
        return (
            <OneTimeKey title={`Código de acesso da conta ${login}`} value={code.code} label="Código de acesso" onClose={() => setCode(null)}>
                Envie ao cliente. Ele cria a conta em {window.location.origin}/cadastro e digita o código em Minhas licenças.
                Vale uma vez só, até {formatDateTime(code.expires_at)}.
            </OneTimeKey>
        );
    }

    if (confirmUnlink && license.client) {
        return (
            <InlineConfirm confirmLabel="Desvincular" icon={<UserMinus />} loading={busy} onConfirm={unlink} onCancel={() => setConfirmUnlink(false)}>
                Desvincular a conta <strong>{login}</strong> de {license.client.name ?? license.client.email}? O cliente deixa de vê-la no
                painel. A cópia continua.
            </InlineConfirm>
        );
    }

    return (
        <div className="space-y-3 rounded-lg border border-border bg-secondary/30 p-4 text-sm">
            <div className="flex items-start gap-2">
                <UserRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p>
                    {license.client
                        ? <>Vinculada a <strong>{license.client.name ?? license.client.email}</strong> ({license.client.email}).</>
                        : 'Nenhuma conta de cliente vinculada: o cliente ainda não acompanha esta licença no painel.'}
                    {pending && <> Há um código esperando uso até {formatDate(license.claim_expires_at!)}; gerar outro invalida esse.</>}
                </p>
            </div>
            <div className="flex flex-wrap justify-end gap-1">
                {license.client && (
                    <Button type="button" size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setConfirmUnlink(true)}>
                        <UserMinus /> Desvincular
                    </Button>
                )}
                <Button type="button" size="sm" loading={busy} onClick={generate}
                    title={license.client ? 'O código leva a licença para a conta que o usar' : undefined}>
                    {!busy && <Ticket />} {license.client ? 'Gerar código para outra conta' : 'Gerar código de acesso'}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={onClose}>Fechar</Button>
            </div>
        </div>
    );
}
