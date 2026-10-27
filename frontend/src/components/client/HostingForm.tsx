import { useForm } from 'react-hook-form';
import { Check, Lock, ShieldCheck, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLicense, type HostedTerminal, type HostingPrice } from '../../api';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { openHostingCheckout } from '../../lib/stripe';
import { apiError } from '../../lib/utils';

type Form = { server: string; password: string };

// Why handing over the broker password is safe, next to the field: what holds a newcomer back
const PROMISES = [
    { icon: Lock, text: 'A senha fica cifrada e só abre o MetaTrader no nosso servidor.' },
    { icon: Wallet, text: 'Depósitos e saques continuam só com você, na corretora.' },
    { icon: ShieldCheck, text: 'Trocou a senha na corretora? O acesso para na hora.' },
];

// The broker server and password of a hosted terminal. Creating one that has to be paid goes on to the Checkout
export default function HostingForm({ license, servers, price, onCancel, cancelLabel = 'Cancelar', onSaved }: {
    license: ClientLicense;
    servers: string[]; // Broker servers our servers can log into
    price: HostingPrice | null;
    onCancel?: () => void;
    cancelLabel?: string;
    onSaved: () => void;
}) {
    const hosted = license.hosting;
    const { register, handleSubmit, watch, reset, formState: { errors, isSubmitting } } = useForm<Form>({
        defaultValues: { server: hosted?.server ?? '', password: '' },
    });
    const server = watch('server').trim();

    const save = async (data: Form) => {
        try {
            const res = await api.put<HostedTerminal>(`/me/licenses/${license.id}/hosting`, {
                server: data.server.trim(),
                ...(data.password && { password: data.password }),
            });
            if (!hosted && !res.data.billing.paid) { // Kept: the terminal starts once Stripe takes the payment
                await openHostingCheckout(license.id);
                onSaved();
                return;
            }
            toast.success(hosted ? 'Hospedagem atualizada' : 'Conta hospedada', {
                description: 'O terminal inicia em instantes. Acompanhe o estado aqui.',
            });
            reset({ server: data.server.trim(), password: '' });
            onSaved();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível salvar a hospedagem.'));
        }
    };

    return (
        <form onSubmit={handleSubmit(save)} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
                <Field
                    label="Servidor da corretora"
                    htmlFor={`server-${license.id}`}
                    error={errors.server?.message}
                    hint={server && servers.length > 0 && !servers.includes(server)
                        ? 'Ainda não atendemos este servidor: a conta não vai conectar.'
                        : servers.length > 0 ? 'Toque no campo para ver os servidores atendidos.' : 'Como aparece na tela de login do MetaTrader 5.'}
                >
                    <Input
                        {...register('server', {
                            required: 'Informe o servidor',
                            pattern: { value: /^[\w .-]+$/, message: 'Letras, números, espaço, ponto e hífen' },
                        })}
                        id={`server-${license.id}`}
                        list={`servers-${license.id}`}
                        autoComplete="off"
                        autoCapitalize="none"
                        placeholder="Ex.: XPMT5-DEMO"
                        className="h-11"
                    />
                    <datalist id={`servers-${license.id}`}>
                        {servers.map(s => <option key={s} value={s} />)}
                    </datalist>
                </Field>
                <Field
                    label={`Senha da conta ${license.mt5_login ?? 'MT5'}`}
                    htmlFor={`password-${license.id}`}
                    error={errors.password?.message}
                    hint={hosted ? 'Em branco, mantém a atual.' : 'A senha de negociação, não a de investidor.'}
                >
                    <Input
                        {...register('password', { required: hosted ? false : 'Informe a senha' })}
                        id={`password-${license.id}`}
                        type="password"
                        autoComplete="new-password"
                        className="h-11"
                    />
                </Field>
            </div>
            {!hosted && (
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                    {PROMISES.map(({ icon: Icon, text }) => (
                        <li key={text} className="flex items-start gap-2"><Icon className="mt-0.5 size-3.5 shrink-0 text-success" /> {text}</li>
                    ))}
                </ul>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {onCancel && (
                    <Button type="button" variant="ghost" className="w-full sm:w-auto" onClick={onCancel}>{cancelLabel}</Button>
                )}
                <Button className="w-full sm:w-auto" loading={isSubmitting}>
                    {!isSubmitting && <Check />} {hosted ? 'Salvar' : price ? 'Continuar para o pagamento' : 'Hospedar minha conta'}
                </Button>
            </div>
            {!hosted && price && (
                <p className="text-center text-xs text-muted-foreground sm:text-right">
                    Uma assinatura separada da assinatura do portfólio. Cancele quando quiser.
                </p>
            )}
        </form>
    );
}
