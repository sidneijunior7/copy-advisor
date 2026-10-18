import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Check, Power, PowerOff, Server, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import api, { type HostedTerminal, type HostingInputs, type License } from '../api';
import InlineConfirm from './InlineConfirm';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Field, Input, Select } from './ui/Field';
import { HOSTING_STATES } from '../lib/labels';
import { apiError } from '../lib/utils';

export function HostingBadge({ terminal }: { terminal: HostedTerminal }) {
    const { label, variant } = HOSTING_STATES[terminal.state] ?? { label: terminal.state, variant: 'muted' };
    return <Badge variant={variant} title={terminal.detail ?? undefined}>{label}</Badge>;
}

// After "Com cópias abertas, "
const UNMANAGED = 'as posições ficam sem acompanhamento: o que o Master fizer não chega à conta.';

type HostingForm = {
    server: string;
    password: string;
    sizing_mode: NonNullable<HostingInputs['sizing_mode']>;
    lots_factor: string;
    reference_capital: string;
    sltp_mode: NonNullable<HostingInputs['sltp_mode']>;
    symbol_map: string;
    suffix_map: string;
    late_max_deviation_points: string;
};

interface HostingPanelProps {
    license: License;
    terminal?: HostedTerminal;
    servers: string[]; // Broker servers the pods online can log into
    onChange: (terminal: HostedTerminal | null) => void;
    onClose: () => void;
}

// Registers or edits the terminal a pod runs for this license: broker login and the Slave's inputs
export default function HostingPanel({ license, terminal, servers, onChange, onClose }: HostingPanelProps) {
    const [confirm, setConfirm] = useState<'disable' | 'remove' | null>(null);
    const [busy, setBusy] = useState(false);
    const inputs = terminal?.inputs ?? {};
    const login = license.client_mt5_login;
    const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<HostingForm>({
        defaultValues: {
            server: terminal?.server ?? '',
            password: '',
            sizing_mode: inputs.sizing_mode ?? 'factor',
            lots_factor: String(inputs.lots_factor ?? 1),
            reference_capital: String(inputs.reference_capital ?? 10000),
            sltp_mode: inputs.sltp_mode ?? 'distance',
            symbol_map: inputs.symbol_map ?? '',
            suffix_map: inputs.suffix_map ?? '',
            late_max_deviation_points: inputs.late_max_deviation_points != null ? String(inputs.late_max_deviation_points) : '',
        },
    });
    const sizing = watch('sizing_mode');
    const server = watch('server').trim();

    const save = async (data: HostingForm) => {
        const body: { server: string; password?: string; inputs: HostingInputs } = {
            server: data.server.trim(),
            inputs: {
                sizing_mode: data.sizing_mode,
                lots_factor: parseFloat(data.lots_factor),
                sltp_mode: data.sltp_mode,
                ...(data.sizing_mode !== 'factor' && { reference_capital: parseFloat(data.reference_capital) }),
                ...(data.symbol_map.trim() && { symbol_map: data.symbol_map.trim() }),
                ...(data.suffix_map.trim() && { suffix_map: data.suffix_map.trim() }),
                ...(data.late_max_deviation_points !== '' && { late_max_deviation_points: parseInt(data.late_max_deviation_points) }),
            },
        };
        if (data.password) body.password = data.password;
        try {
            const res = await api.put<HostedTerminal>(`/licenses/${license.id}/hosting`, body);
            onChange(res.data);
            toast.success(terminal ? `Conta ${login}: hospedagem atualizada` : `Conta ${login} hospedada`, {
                description: 'O pod inicia o terminal com esta configuração em instantes.',
            });
            onClose();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível salvar a hospedagem.'));
        }
    };

    const setEnabled = async (enabled: boolean) => {
        setBusy(true);
        try {
            const res = await api.put<HostedTerminal>(`/licenses/${license.id}/hosting`, { enabled });
            onChange(res.data);
            setConfirm(null);
            toast.success(`Conta ${login}: terminal ${enabled ? 'ligado' : 'desligado'}`);
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível alterar o terminal.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        try {
            await api.delete(`/licenses/${license.id}/hosting`);
            onChange(null);
            onClose();
            toast.success(`Conta ${login}: hospedagem removida`);
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível remover a hospedagem.'));
            setBusy(false);
        }
    };

    if (confirm === 'disable') {
        return (
            <InlineConfirm confirmLabel="Desligar terminal" icon={<PowerOff />} loading={busy}
                onConfirm={() => setEnabled(false)} onCancel={() => setConfirm(null)}>
                Desligar o terminal da conta <strong>{login}</strong>? Com cópias abertas, {UNMANAGED}
            </InlineConfirm>
        );
    }
    if (confirm === 'remove') {
        return (
            <InlineConfirm confirmLabel="Remover hospedagem" icon={<Trash2 />} loading={busy}
                onConfirm={remove} onCancel={() => setConfirm(null)}>
                Remover a hospedagem da conta <strong>{login}</strong>? O terminal é fechado. Com cópias abertas, {UNMANAGED}{' '}
                Para o cliente rodar o EA por conta própria, gere uma nova chave.
            </InlineConfirm>
        );
    }

    return (
        <form onSubmit={handleSubmit(save)} className="space-y-4 rounded-lg border border-border bg-secondary/30 p-4" noValidate>
            <div className="flex flex-wrap items-center gap-2">
                <Server className="size-4 text-muted-foreground" />
                <p className="text-sm font-medium">Terminal hospedado da conta {login}</p>
                {terminal && <HostingBadge terminal={terminal} />}
                {terminal?.detail && <p className="text-xs text-muted-foreground">{terminal.detail}</p>}
            </div>
            {!terminal && (
                <p className="text-xs text-muted-foreground">
                    O MetaTrader 5 do cliente roda num servidor nosso, sem nada instalado do lado dele. A licença ganha uma chave
                    nova, que só o servidor conhece: um EA que o cliente rode no próprio computador é desconectado.
                </p>
            )}
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Field
                    label="Servidor da corretora"
                    htmlFor={`hosting-server-${license.id}`}
                    error={errors.server?.message}
                    hint={servers.length === 0 ? 'Nenhum pod no ar agora: o terminal fica na fila.'
                        : server && !servers.includes(server) ? 'Nenhum pod conhece este servidor: o terminal não conecta.'
                        : 'Como aparece no login do MT5.'}
                >
                    <Input
                        {...register('server', {
                            required: 'Informe o servidor',
                            pattern: { value: /^[\w .-]+$/, message: 'Letras, números, espaço, ponto e hífen' },
                        })}
                        id={`hosting-server-${license.id}`}
                        list={`hosting-servers-${license.id}`}
                        placeholder="Ex.: XPMT5-DEMO"
                        autoComplete="off"
                    />
                    <datalist id={`hosting-servers-${license.id}`}>
                        {servers.map(s => <option key={s} value={s} />)}
                    </datalist>
                </Field>
                <Field
                    label="Senha da conta"
                    htmlFor={`hosting-password-${license.id}`}
                    error={errors.password?.message}
                    hint={terminal ? 'Em branco, mantém a atual.' : 'A de negociação, não a de investidor. Fica cifrada e não aparece de novo.'}
                >
                    <Input
                        {...register('password', { required: terminal ? false : 'Informe a senha' })}
                        id={`hosting-password-${license.id}`}
                        type="password"
                        autoComplete="new-password"
                    />
                </Field>
                <Field label="Tamanho das posições" htmlFor={`hosting-sizing-${license.id}`}>
                    <Select {...register('sizing_mode')} id={`hosting-sizing-${license.id}`}>
                        <option value="factor">Fator fixo sobre o lote do Master</option>
                        <option value="balance">Proporcional ao saldo</option>
                        <option value="equity">Proporcional ao patrimônio</option>
                    </Select>
                </Field>
                <Field label="Fator" htmlFor={`hosting-factor-${license.id}`} error={errors.lots_factor?.message}
                    hint={sizing === 'factor' ? 'Lote do Master × fator.' : 'Multiplica a proporção.'}>
                    <Input
                        {...register('lots_factor', { validate: v => parseFloat(v) > 0 || 'Deve ser maior que zero' })}
                        id={`hosting-factor-${license.id}`}
                        type="number"
                        step="0.01"
                        min="0.01"
                        className="font-mono"
                    />
                </Field>
                {sizing !== 'factor' && (
                    <Field label="Capital de referência" htmlFor={`hosting-capital-${license.id}`} error={errors.reference_capital?.message}
                        hint="Capital, na moeda da conta, que copia o lote do Master por inteiro.">
                        <Input
                            {...register('reference_capital', { validate: v => parseFloat(v) > 0 || 'Deve ser maior que zero' })}
                            id={`hosting-capital-${license.id}`}
                            type="number"
                            step="1"
                            min="1"
                            className="font-mono"
                        />
                    </Field>
                )}
                <Field label="SL/TP" htmlFor={`hosting-sltp-${license.id}`}
                    hint="Corretoras com cotação diferente da do Master pedem a distância.">
                    <Select {...register('sltp_mode')} id={`hosting-sltp-${license.id}`}>
                        <option value="distance">Mesma distância da entrada</option>
                        <option value="price">Mesmo preço do Master</option>
                    </Select>
                </Field>
            </div>
            <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Avançado</summary>
                <div className="mt-3 grid grid-cols-1 items-start gap-4 md:grid-cols-3">
                    <Field label="Mapa de símbolos" htmlFor={`hosting-symbols-${license.id}`} hint="Ex.: EURUSD=EURUSDm;XAUUSD=GOLD">
                        <Input {...register('symbol_map')} id={`hosting-symbols-${license.id}`} className="font-mono" />
                    </Field>
                    <Field label="Mapa de sufixos" htmlFor={`hosting-suffix-${license.id}`} hint="Ex.: .a=m (EURUSD.a vira EURUSDm)">
                        <Input {...register('suffix_map')} id={`hosting-suffix-${license.id}`} className="font-mono" />
                    </Field>
                    <Field label="Entrada atrasada (pontos)" htmlFor={`hosting-late-${license.id}`}
                        hint="Distância máxima da entrada do Master; em branco, a do EA (50). 0 = nunca.">
                        <Input
                            {...register('late_max_deviation_points', { pattern: { value: /^\d*$/, message: 'Use apenas dígitos' } })}
                            id={`hosting-late-${license.id}`}
                            inputMode="numeric"
                            className="font-mono"
                        />
                    </Field>
                </div>
            </details>
            <div className="flex flex-wrap justify-end gap-1">
                {terminal && (terminal.enabled ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm('disable')}>
                        <PowerOff /> Desligar
                    </Button>
                ) : (
                    <Button type="button" size="sm" variant="ghost" loading={busy} onClick={() => setEnabled(true)}>
                        {!busy && <Power />} Ligar
                    </Button>
                ))}
                {terminal && (
                    <Button type="button" size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setConfirm('remove')}>
                        <Trash2 /> Remover
                    </Button>
                )}
                <Button size="sm" loading={isSubmitting}>
                    {!isSubmitting && <Check />} {terminal ? 'Salvar' : 'Hospedar conta'}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancelar</Button>
            </div>
        </form>
    );
}
