import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { CheckCircle2, Mail, Send, XCircle } from 'lucide-react';
import api from '../api';
import Card from './Card';
import { Button } from './ui/Button';
import { Field, Input } from './ui/Field';
import { apiError } from '../lib/utils';

type Result = {
    ok: boolean;
    error: string | null;
    host: string | null;
    port: number;
    sender: string | null;
    queued: number; // Messages waiting for the background sender
    worker_alive: boolean;
};

// One message now, outside the queue: what the SMTP server answered, to find why an email does not arrive
export default function EmailTest() {
    const [result, setResult] = useState<Result | null>(null);
    const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<{ to: string }>();

    const send = async ({ to }: { to: string }) => {
        setResult(null);
        try {
            const res = await api.post<Result>('/admin/email-test', { to: to.trim() });
            setResult(res.data);
        } catch (e) {
            setError('to', { message: apiError(e, 'Não foi possível fazer o teste.') });
        }
    };

    return (
        <Card title="Teste de email" description="Envia uma mensagem agora, fora da fila, e mostra o que o servidor SMTP respondeu." icon={<Mail />}>
            <form onSubmit={handleSubmit(send)} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
                <Field label="Enviar para" htmlFor="email-test-to" error={errors.to?.message} className="flex-1">
                    <Input {...register('to', { required: 'Informe o email' })} id="email-test-to" type="email" placeholder="voce@exemplo.com" />
                </Field>
                <Button className="sm:mt-[1.375rem]" loading={isSubmitting}>{!isSubmitting && <Send />} Enviar teste</Button>
            </form>
            {result && (
                <div className="mt-4 space-y-2 rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                    <p className="flex items-start gap-2 font-medium">
                        {result.ok
                            ? <><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> O servidor aceitou a mensagem. Se não chegar, veja o spam e o DMARC do domínio.</>
                            : <><XCircle className="mt-0.5 size-4 shrink-0 text-destructive" /> O envio falhou.</>}
                    </p>
                    {result.error && <p className="break-all font-mono text-xs text-destructive">{result.error}</p>}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">Servidor</dt><dd className="font-mono">{result.host ?? '—'}:{result.port}</dd>
                        <dt className="text-muted-foreground">Remetente</dt><dd className="break-all font-mono">{result.sender ?? '—'}</dd>
                        <dt className="text-muted-foreground">Fila</dt>
                        <dd>
                            {result.queued} {result.queued === 1 ? 'mensagem esperando' : 'mensagens esperando'},{' '}
                            {result.worker_alive ? 'envio em segundo plano ativo' : 'envio em segundo plano parado'}
                            {result.queued > 0 && !result.worker_alive && <span className="text-destructive"> (nada sai da fila)</span>}
                        </dd>
                    </dl>
                </div>
            )}
        </Card>
    );
}
