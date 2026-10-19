import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Check, Pencil, Radio } from 'lucide-react';
import { toast } from 'sonner';
import api, { type MasterAccount, type Portfolio } from '../api';
import { Button } from './ui/Button';
import { Field, Select } from './ui/Field';
import { apiError } from '../lib/utils';

type OriginForm = { master_login: string };
type Origin = Pick<Portfolio, 'master_login'>;

const MODES: Record<string, string> = { demo: 'demo', contest: 'torneio', real: 'real' };

// "XP Investimentos 123456 (demo, BRL)"
const accountLabel = (a: MasterAccount) =>
    `${a.company || a.server || 'Conta'} ${a.master_login} (${[MODES[a.trade_mode] ?? a.trade_mode, a.currency].filter(Boolean).join(', ')})`;

// The Master account the portfolio copies from: its clients get only that account's positions, and what they got is
// the portfolio's track record
export default function PortfolioOrigin({ portfolio, accounts, onSaved }: {
    portfolio: Portfolio;
    accounts: MasterAccount[];
    onSaved: (origin: Origin) => void;
}) {
    const [editing, setEditing] = useState(false);
    const account = accounts.find(a => a.master_login === portfolio.master_login);
    const { register, handleSubmit, formState: { isSubmitting } } = useForm<OriginForm>({
        defaultValues: { master_login: portfolio.master_login == null ? '' : String(portfolio.master_login) },
    });

    const save = async (data: OriginForm) => {
        try {
            const res = await api.put<Origin>(`/portfolios/${portfolio.id}/origin`, {
                master_login: data.master_login ? Number(data.master_login) : null,
            });
            onSaved(res.data);
            setEditing(false);
            toast.success(`${portfolio.name}: conta de origem salva`);
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível salvar a conta de origem.'));
        }
    };

    if (!editing) {
        return (
            <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
                <p className="flex items-start gap-1.5">
                    <Radio className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                        {portfolio.master_login == null
                            ? 'Copia de todas as suas contas Master: uma conta de teste com os mesmos magic numbers também manda sinais aos clientes.'
                            : `Copia só da conta ${account ? accountLabel(account) : portfolio.master_login}.`}
                    </span>
                </p>
                <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => setEditing(true)}>
                    <Pencil /> Editar
                </Button>
            </div>
        );
    }

    return (
        <form onSubmit={handleSubmit(save)} className="mt-4 space-y-4 border-t border-border pt-4" noValidate>
            <Field label="Conta de origem" htmlFor={`origin-${portfolio.id}`}
                hint="Os clientes recebem só as operações desta conta. O que já receberam continua no histórico do portfólio.">
                <Select {...register('master_login')} id={`origin-${portfolio.id}`}>
                    <option value="">Todas as contas</option>
                    {accounts.map(a => <option key={a.master_login} value={a.master_login}>{accountLabel(a)}</option>)}
                </Select>
            </Field>
            <div className="flex justify-end gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
                <Button size="sm" loading={isSubmitting}>{!isSubmitting && <Check />} Salvar</Button>
            </div>
        </form>
    );
}
