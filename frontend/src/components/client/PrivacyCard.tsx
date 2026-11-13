import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ShieldCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import api, { type Me } from '../../api';
import Card from '../Card';
import InlineConfirm from '../InlineConfirm';
import { PRIVACY_PATH } from '../TermsNotice';
import { Button } from '../ui/Button';
import { COMPANY } from '../../lib/company';
import { apiError, formatDate, parseUtc } from '../../lib/utils';

const CLOSURE_DAYS = 15; // The answer the Privacy Policy promises
const link = 'font-medium text-primary underline-offset-4 hover:underline';

// The holder's own data (LGPD, art. 18): a copy of everything, and the request to close the account. A person closes
// it, since a running subscription may have to be settled first; until then the request can be taken back here
export default function PrivacyCard() {
    const [me, setMe] = useState<Me | null>(null);
    const [busy, setBusy] = useState<'export' | 'closure' | null>(null);
    const [confirming, setConfirming] = useState(false);

    useEffect(() => {
        api.get<Me>('/me').then(res => setMe(res.data)).catch(e => console.error(e));
    }, []);

    const download = async () => {
        setBusy('export');
        try {
            const res = await api.get('/me/export', { responseType: 'blob' });
            const url = URL.createObjectURL(res.data as Blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'meus-dados-trademetric-mirror.json';
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível gerar o arquivo. Tente de novo em instantes.'));
        } finally {
            setBusy(null);
        }
    };

    const closure = async (ask: boolean) => {
        setBusy('closure');
        try {
            const res = ask
                ? await api.post<{ closure_requested_at: string }>('/me/closure-request')
                : await api.delete<{ closure_requested_at: null }>('/me/closure-request');
            setMe(m => (m ? { ...m, closure_requested_at: res.data.closure_requested_at } : m));
            setConfirming(false);
            toast.success(ask ? 'Pedido recebido' : 'Pedido cancelado', {
                description: ask ? `Encerramos a conta em até ${CLOSURE_DAYS} dias e avisamos por email.` : 'A sua conta continua como estava.',
            });
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível registrar o pedido.'));
        } finally {
            setBusy(null);
        }
    };

    const asked = me?.closure_requested_at ? parseUtc(me.closure_requested_at) : null;
    const due = asked ? new Date(asked.getTime() + CLOSURE_DAYS * 86_400_000) : null;

    return (
        <Card title="Seus dados" icon={<ShieldCheck />}
            description="Baixe uma cópia do que guardamos sobre você ou peça o encerramento da conta.">
            <div className="space-y-4 text-sm">
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" loading={busy === 'export'} onClick={download}>
                        {busy !== 'export' && <Download />} Baixar meus dados
                    </Button>
                    {me && !asked && !confirming && (
                        <Button variant="ghost" onClick={() => setConfirming(true)}><UserX /> Encerrar minha conta</Button>
                    )}
                </div>
                {confirming && (
                    <InlineConfirm confirmLabel="Pedir encerramento" icon={<UserX />} loading={busy === 'closure'}
                        onConfirm={() => closure(true)} onCancel={() => setConfirming(false)}>
                        O acesso e as credenciais são apagados e as cópias param de abrir operações novas. Cancele antes as
                        assinaturas ativas. Concluímos em até {CLOSURE_DAYS} dias.
                    </InlineConfirm>
                )}
                {asked && due && (
                    <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <p>Você pediu o encerramento da conta em {formatDate(asked)}. Concluímos até {formatDate(due)}.</p>
                        <Button size="sm" variant="outline" loading={busy === 'closure'} onClick={() => closure(false)}>Cancelar o pedido</Button>
                    </div>
                )}
                <p className="text-xs text-muted-foreground">
                    Para corrigir um dado ou fazer outro pedido, escreva para{' '}
                    <a href={`mailto:${COMPANY.email}`} className={link}>{COMPANY.email}</a>.
                    Veja a <Link to={PRIVACY_PATH} className={link}>Política de Privacidade</Link>.
                </p>
            </div>
        </Card>
    );
}
