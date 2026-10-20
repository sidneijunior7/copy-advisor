import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { MailCheck, Plug } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLicense, type Me } from '../../api';
import Card from '../Card';
import ResendLinkButton from '../ResendLinkButton';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { apiError } from '../../lib/utils';

type AccountForm = { mt5_login: string };

// A license bought without the account: the step between paying and copying
export default function ConnectAccount({ license, onDone }: { license: ClientLicense; onDone: () => void }) {
    const [me, setMe] = useState<Me | null>(null);
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<AccountForm>();

    useEffect(() => {
        api.get<Me>('/me').then(res => setMe(res.data)).catch(e => console.error(e));
    }, []);

    const connect = async ({ mt5_login }: AccountForm) => {
        try {
            await api.put<ClientLicense>(`/me/licenses/${license.id}/account`, { mt5_login: Number(mt5_login) });
            toast.success(`Conta ${mt5_login} conectada`, { description: 'Agora escolha como copiar: hospedado ou no seu computador.' });
            onDone();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível conectar a conta.'));
        }
    };

    if (me?.email_enabled && !me.email_verified) {
        return (
            <Card title="Confirme seu email" icon={<MailCheck />}>
                <div className="space-y-3 text-sm">
                    <p>Falta só isso para conectar sua conta MT5: o link está na sua caixa de entrada.</p>
                    <ResendLinkButton />
                </div>
            </Card>
        );
    }
    return (
        <Card title="Conecte sua conta MT5" description="A conta da corretora que vai copiar este portfólio." icon={<Plug />}>
            <form onSubmit={handleSubmit(connect)} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
                <Field label="Número da conta" htmlFor="connect-login" error={errors.mt5_login?.message} className="flex-1"
                    hint="Aparece no topo do MetaTrader 5, no Navegador em Contas, ou no email da corretora.">
                    <Input
                        {...register('mt5_login', { required: 'Informe a conta', pattern: { value: /^\d{1,12}$/, message: 'Só números' } })}
                        id="connect-login"
                        inputMode="numeric"
                        className="font-mono"
                    />
                </Field>
                <Button className="sm:mt-6" loading={isSubmitting}>Conectar</Button>
            </form>
        </Card>
    );
}
