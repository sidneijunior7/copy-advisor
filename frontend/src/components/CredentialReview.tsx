import { useEffect, useState } from 'react';
import { BadgeCheck, ExternalLink, ShieldQuestion, X } from 'lucide-react';
import { toast } from 'sonner';
import api, { type CredentialStatus } from '../api';
import Card from './Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Input } from './ui/Field';
import { apiError, formatDate, parseUtc } from '../lib/utils';

type Trader = {
    id: number; email: string; public_name: string | null; seller_name: string | null; document: string | null;
    credential: string; status: CredentialStatus; checked_at: string | null; note: string | null; published: number;
};
type Credentials = { list_url: string; traders: Trader[] };

const STATUS: Record<CredentialStatus, { label: string; variant: 'warning' | 'success' | 'destructive' }> = {
    pending: { label: 'Para conferir', variant: 'warning' },
    verified: { label: 'Conferido', variant: 'success' },
    rejected: { label: 'Recusado', variant: 'destructive' },
};

// The traders' analyst credentials, checked by hand on APIMEC's public list (name, certificate number, status
// "credenciado"): a trader publishes only once checked. Refusing, or revoking a checked one, takes its portfolios out
// of the vitrine; licenses already sold keep working
export default function CredentialReview() {
    const [data, setData] = useState<Credentials | null>(null);
    const [refusing, setRefusing] = useState<number | null>(null);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState<number | null>(null);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        api.get<Credentials>('/admin/credentials').then(res => setData(res.data)).catch(e => console.error(e));
    }, [reload]);

    const decide = async (t: Trader, verified: boolean) => {
        setBusy(t.id);
        try {
            const res = await api.post<{ withdrawn: number }>(`/admin/users/${t.id}/credential`, { verified, note: verified ? null : reason.trim() });
            toast.success(verified ? 'Credenciamento conferido' : 'Credenciamento recusado', {
                description: verified ? 'O trader já pode publicar e foi avisado por email.'
                    : `${res.data.withdrawn ? `${res.data.withdrawn} portfólio(s) saíram da vitrine. ` : ''}O trader foi avisado por email.`,
            });
            setRefusing(null);
            setReason('');
            setReload(n => n + 1);
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível registrar a conferência.'));
        } finally {
            setBusy(null);
        }
    };

    if (!data || data.traders.length === 0) return null;
    const pending = data.traders.filter(t => t.status === 'pending').length;
    return (
        <Card title="Credenciamentos" icon={<ShieldQuestion />}
            description={pending ? `${pending} para conferir. Confira o nome, o número do certificado e a situação "credenciado" na lista da APIMEC.`
                : 'Os credenciamentos de analista informados pelos traders.'}
            action={<a href={data.list_url} target="_blank" rel="noopener noreferrer"><Button size="sm" variant="outline"><ExternalLink /> Lista da APIMEC</Button></a>}>
            <ul className="divide-y divide-border">
                {data.traders.map(t => (
                    <li key={t.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0 text-sm">
                                <p className="flex flex-wrap items-center gap-2 font-medium">
                                    {t.seller_name ?? t.public_name ?? t.email} <Badge variant={STATUS[t.status].variant}>{STATUS[t.status].label}</Badge>
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    Credenciamento: <span className="font-mono text-foreground">{t.credential}</span>
                                    {t.document && <> · {t.document}</>} · {t.email} · {t.published} {t.published === 1 ? 'portfólio publicado' : 'portfólios publicados'}
                                </p>
                                {t.checked_at && <p className="text-xs text-muted-foreground">{STATUS[t.status].label} em {formatDate(parseUtc(t.checked_at))}{t.note && `: ${t.note}`}</p>}
                            </div>
                            {refusing !== t.id && (
                                <div className="flex shrink-0 gap-1">
                                    {t.status !== 'verified' && (
                                        <Button size="sm" variant="outline" loading={busy === t.id} onClick={() => decide(t, true)}>
                                            {busy !== t.id && <BadgeCheck />} Conferido
                                        </Button>
                                    )}
                                    {t.status !== 'rejected' && (
                                        <Button size="sm" variant="ghost" onClick={() => { setRefusing(t.id); setReason(''); }}>
                                            <X /> {t.status === 'verified' ? 'Revogar' : 'Recusar'}
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                        {refusing === t.id && (
                            <form onSubmit={e => { e.preventDefault(); if (reason.trim()) void decide(t, false); }}
                                className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 sm:flex-row sm:items-center">
                                <label htmlFor={`refuse-${t.id}`} className="sr-only">Motivo</label>
                                <Input id={`refuse-${t.id}`} value={reason} onChange={e => setReason(e.target.value)} maxLength={255} autoFocus
                                    placeholder="Motivo, que o trader recebe por email (ex.: número não consta na lista)" />
                                <div className="flex shrink-0 gap-1">
                                    <Button size="sm" variant="destructive" loading={busy === t.id} disabled={!reason.trim()}>
                                        {t.status === 'verified' ? 'Revogar' : 'Recusar'}{t.published > 0 && ' e tirar do ar'}
                                    </Button>
                                    <Button size="sm" variant="ghost" type="button" onClick={() => setRefusing(null)}>Cancelar</Button>
                                </div>
                            </form>
                        )}
                    </li>
                ))}
            </ul>
        </Card>
    );
}
