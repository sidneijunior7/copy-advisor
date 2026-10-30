import { useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import api, { type PortfolioDeletion } from '../api';
import InlineConfirm from './InlineConfirm';
import { Button } from './ui/Button';
import { apiError } from '../lib/utils';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// What goes with the portfolio, in one sentence
const removes = (r: PortfolioDeletion['removes']) => [
    r.listing && 'o anúncio do marketplace',
    r.codes > 0 && plural(r.codes, 'código de lançamento', 'códigos de lançamento'),
    r.requests > 0 && plural(r.requests, 'pedido de assinatura', 'pedidos de assinatura'),
    r.licenses > 0 && plural(r.licenses, 'licença vencida ou revogada', 'licenças vencidas ou revogadas'),
    r.track_record > 0 && `o histórico de ${plural(r.track_record, 'operação', 'operações')}`,
    r.homologation > 0 && `a homologação de ${plural(r.homologation, 'operação', 'operações')}`,
    r.dash && 'o vínculo com o Dash',
].filter(Boolean).join(', ');

// Deleting a portfolio: the API says first whether a client is still left with it, and what would go
export default function DeletePortfolio({ portfolioId, name, onDeleted }: { portfolioId: number; name: string; onDeleted: () => void }) {
    const [check, setCheck] = useState<PortfolioDeletion | null>(null);
    const [busy, setBusy] = useState(false);

    const ask = async () => {
        setBusy(true);
        try {
            setCheck((await api.get<PortfolioDeletion>(`/portfolios/${portfolioId}/deletion`)).data);
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível verificar o portfólio.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        try {
            await api.delete(`/portfolios/${portfolioId}`);
            toast.success(`Portfólio "${name}" excluído`);
            onDeleted();
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível excluir o portfólio.'));
            setBusy(false);
        }
    };

    if (!check) {
        return (
            <div className="mt-4 flex justify-end border-t border-border pt-3">
                <Button size="sm" variant="ghost" loading={busy} onClick={ask}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                    {!busy && <Trash2 />} Excluir portfólio
                </Button>
            </div>
        );
    }
    if (check.blockers.length > 0) {
        return (
            <div role="alert" className="mt-4 space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
                <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 text-warning" /> Ainda há clientes com este portfólio</p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {check.blockers.map(b => <li key={b}>{b}</li>)}
                </ul>
                <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => setCheck(null)}>Entendi</Button></div>
            </div>
        );
    }
    const what = removes(check.removes);
    return (
        <InlineConfirm className="mt-4" confirmLabel="Excluir de vez" icon={<Trash2 />} loading={busy}
            onConfirm={remove} onCancel={() => setCheck(null)}>
            Excluir <strong>{name}</strong>{what ? ` com ${what}` : ''}? Não dá para desfazer. As estratégias continuam suas.
        </InlineConfirm>
    );
}
