import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Check } from 'lucide-react';
import { toast } from 'sonner';
import api, { type BrokerChoice, type Me } from '../../api';
import { B3_BROKERS, brokerLabel } from '../../lib/brokers';
import { apiError, cn } from '../../lib/utils';
import { radioKeys } from '../../pages/market/checkout/format';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';

type Advisor = 'yes' | 'no' | 'unknown';

const chip = (on: boolean) => cn('inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
    on ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground');

// Where the MT5 account is, asked after paying instead of before: optional, and it helps the support set the copy up.
// The B3 brokers show only for a portfolio that trades on the B3; any other is named in "Outra corretora"
export default function BrokerQuestion({ markets }: { markets: string[] }) {
    const [me, setMe] = useState<Me | null>(null);
    const [open, setOpen] = useState(false);
    const [broker, setBroker] = useState<BrokerChoice | null>(null);
    const [other, setOther] = useState('');
    const [advisor, setAdvisor] = useState<Advisor | null>(null);
    const [advisorName, setAdvisorName] = useState('');
    const [saving, setSaving] = useState(false);
    const b3 = markets.includes('B3');

    useEffect(() => {
        api.get<Me>('/me').then(res => {
            setMe(res.data);
            setBroker(res.data.broker ?? null);
            setOther(res.data.broker_other ?? '');
            setAdvisor(res.data.advisor ? 'yes' : res.data.advisor_unknown ? 'unknown' : null);
            setAdvisorName(res.data.advisor ?? '');
            setOpen(!res.data.broker);
        }).catch(e => console.error(e));
    }, []);

    const save = async (body: Record<string, unknown>) => {
        setSaving(true);
        try {
            const res = await api.put<Me>('/me/broker', body);
            setMe(res.data);
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível salvar a corretora.'));
        } finally {
            setSaving(false);
        }
    };

    const pick = (id: BrokerChoice) => {
        setBroker(id);
        if (id !== 'other') void save({ broker: id });
    };

    const saveOther = (e: FormEvent) => {
        e.preventDefault();
        if (other.trim().length >= 2) void save({ broker: 'other', broker_other: other.trim() });
    };

    const pickAdvisor = (a: Advisor) => {
        setAdvisor(a);
        if (a !== 'yes') void save({ advisor: null, advisor_unknown: a === 'unknown' });
    };

    if (!me) return null;
    if (!open) {
        return (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Building2 className="size-4" /> Corretora: <span className="font-medium text-foreground">{brokerLabel(me.broker, me.broker_other)}</span>
                <button type="button" onClick={() => setOpen(true)} className="min-h-9 font-medium text-primary underline-offset-4 hover:underline">Alterar</button>
            </p>
        );
    }

    const options: { id: BrokerChoice; name: string }[] = [...(b3 ? B3_BROKERS : []), { id: 'other', name: 'Outra corretora' }, { id: 'none', name: 'Ainda não tenho conta' }];
    return (
        <div className="space-y-4 rounded-xl border border-border bg-secondary/20 p-4">
            <div>
                <p className="flex items-center gap-2 text-sm font-semibold"><Building2 className="size-4 text-primary" /> Em qual corretora você vai operar? <span className="font-normal text-muted-foreground">(opcional)</span></p>
                <p className="mt-1 text-xs text-muted-foreground">Ajuda o suporte a configurar a cópia. {b3 ? 'Qualquer corretora com MetaTrader 5 serve.' : 'Qualquer corretora com MetaTrader 5 para este mercado serve.'}</p>
            </div>
            <div role="radiogroup" aria-label="Corretora" onKeyDown={radioKeys} className="flex flex-wrap gap-2">
                {options.map((o, i) => (
                    <button key={o.id} type="button" role="radio" aria-checked={broker === o.id} tabIndex={broker === o.id || (broker == null && i === 0) ? 0 : -1}
                        onClick={() => pick(o.id)} className={chip(broker === o.id)}>
                        {broker === o.id && <Check className="size-3.5 text-primary" />} {o.name}
                    </button>
                ))}
            </div>
            {broker === 'other' && (
                <form onSubmit={saveOther} className="flex gap-2">
                    <label htmlFor="broker-other" className="sr-only">Nome da corretora</label>
                    <Input id="broker-other" value={other} onChange={e => setOther(e.target.value)} maxLength={60} placeholder="Nome da corretora" autoFocus />
                    <Button type="submit" variant="outline" loading={saving} disabled={other.trim().length < 2}>Salvar</Button>
                </form>
            )}
            {broker && broker !== 'none' && (broker !== 'other' || me.broker === 'other') && (
                <div className="space-y-2">
                    <p className="text-sm font-medium">Você tem assessoria de investimentos? <span className="font-normal text-muted-foreground">(opcional)</span></p>
                    <div role="radiogroup" aria-label="Assessoria" onKeyDown={radioKeys} className="flex flex-wrap gap-2">
                        {([['yes', 'Sim'], ['no', 'Não'], ['unknown', 'Não sei']] as const).map(([id, label], i) => (
                            <button key={id} type="button" role="radio" aria-checked={advisor === id} tabIndex={advisor === id || (advisor == null && i === 0) ? 0 : -1}
                                onClick={() => pickAdvisor(id)} className={chip(advisor === id)}>
                                {advisor === id && <Check className="size-3.5 text-primary" />} {label}
                            </button>
                        ))}
                    </div>
                    {advisor === 'yes' && (
                        <form onSubmit={e => { e.preventDefault(); if (advisorName.trim().length >= 2) void save({ advisor: advisorName.trim(), advisor_unknown: false }); }} className="flex gap-2">
                            <label htmlFor="advisor-name" className="sr-only">Escritório ou nome do assessor</label>
                            <Input id="advisor-name" value={advisorName} onChange={e => setAdvisorName(e.target.value)} maxLength={120} placeholder="Escritório ou nome do assessor" />
                            <Button type="submit" variant="outline" loading={saving} disabled={advisorName.trim().length < 2}>Salvar</Button>
                        </form>
                    )}
                </div>
            )}
            {me.broker && <button type="button" onClick={() => setOpen(false)} className="min-h-9 text-xs font-medium text-primary underline-offset-4 hover:underline">Fechar</button>}
        </div>
    );
}
