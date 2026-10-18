import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Lock, Mail, XCircle } from 'lucide-react';
import api from '../api';
import AuthShell from '../components/AuthShell';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';
import { apiError } from '../lib/utils';

const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

// The confirmation link of the sign-up email
export function VerifyEmail() {
    const [params] = useSearchParams();
    const [state, setState] = useState<'checking' | 'ok' | 'failed'>('checking');
    const [message, setMessage] = useState('');
    const sent = useRef(false); // The link works once: StrictMode runs effects twice in development

    useEffect(() => {
        if (sent.current) return;
        sent.current = true;
        api.post('/email/verify', { token: params.get('token') ?? '' })
            .then(() => setState('ok'))
            .catch(e => { setMessage(apiError(e, 'Não foi possível confirmar o email.')); setState('failed'); });
    }, [params]);

    return (
        <AuthShell title="Confirmação de email" subtitle={state === 'checking' ? 'Confirmando...' : ''}>
            {state === 'ok' && (
                <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
                    Email confirmado. <Link to="/dashboard" className={linkClass}>Ir para o painel</Link></p>
            )}
            {state === 'failed' && (
                <p className="flex items-start gap-2"><XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
                    {message} No painel, use "Reenviar link".</p>
            )}
        </AuthShell>
    );
}

export function ForgotPassword() {
    const [sent, setSent] = useState(false);
    const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<{ email: string }>();

    const submit = async ({ email }: { email: string }) => {
        try {
            await api.post('/password/forgot', { email: email.trim() });
            setSent(true);
        } catch (e) {
            setError('root', { message: apiError(e, 'Não foi possível enviar o link. Tente de novo.') });
        }
    };

    return (
        <AuthShell title="Esqueceu a senha?" subtitle="Enviamos um link para criar uma nova.">
            {sent ? (
                <p className="flex items-start gap-2"><Mail className="mt-0.5 size-5 shrink-0 text-primary" />
                    Se houver uma conta com este email, o link chega em instantes. Ele vale por 1 hora.</p>
            ) : (
                <form onSubmit={handleSubmit(submit)} className="space-y-5" noValidate>
                    <Field label="Email" htmlFor="email" error={errors.email?.message}>
                        <Input {...register('email', { required: 'Informe seu email' })} id="email" type="email" autoComplete="email"
                            icon={<Mail />} className="h-12" />
                    </Field>
                    {errors.root && <p role="alert" className="text-sm text-destructive">{errors.root.message}</p>}
                    <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Enviar link</Button>
                </form>
            )}
            <p className="text-center text-sm text-muted-foreground"><Link to="/login" className={linkClass}>Voltar para o login</Link></p>
        </AuthShell>
    );
}

export function ResetPassword() {
    const [params] = useSearchParams();
    const [done, setDone] = useState(false);
    const { register, handleSubmit, watch, setError, formState: { errors, isSubmitting } } =
        useForm<{ password: string; confirm: string }>();

    const submit = async ({ password }: { password: string }) => {
        try {
            await api.post('/password/reset', { token: params.get('token') ?? '', password });
            setDone(true);
        } catch (e) {
            setError('root', { message: apiError(e, 'Não foi possível redefinir a senha.') });
        }
    };

    return (
        <AuthShell title="Nova senha" subtitle="As sessões abertas com a senha antiga terminam.">
            {done ? (
                <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
                    Senha redefinida. <Link to="/login" className={linkClass}>Entrar</Link></p>
            ) : (
                <form onSubmit={handleSubmit(submit)} className="space-y-5" noValidate>
                    <Field label="Nova senha" htmlFor="password" error={errors.password?.message} hint="Pelo menos 8 caracteres.">
                        <Input {...register('password', { required: 'Crie uma senha', minLength: { value: 8, message: 'Use pelo menos 8 caracteres' } })}
                            id="password" type="password" autoComplete="new-password" icon={<Lock />} className="h-12" />
                    </Field>
                    <Field label="Repita a senha" htmlFor="confirm" error={errors.confirm?.message}>
                        <Input {...register('confirm', { validate: v => v === watch('password') || 'As senhas não conferem' })}
                            id="confirm" type="password" autoComplete="new-password" icon={<Lock />} className="h-12" />
                    </Field>
                    {errors.root && <p role="alert" className="text-sm text-destructive">{errors.root.message}</p>}
                    <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Salvar senha</Button>
                </form>
            )}
        </AuthShell>
    );
}
