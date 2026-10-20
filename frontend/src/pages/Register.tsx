import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import AuthShell from '../components/AuthShell';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';
import { apiError, safeNext } from '../lib/utils';

type RegisterForm = { email: string; password: string };

const PASSWORD_MIN = 8;

// Open sign-up: the account starts empty, and each license comes with an access code from whoever sold it
export default function Register() {
    const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<RegisterForm>();
    const [showPassword, setShowPassword] = useState(false);
    const { login, token } = useAuth();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const next = safeNext(params.get('next'), '/client');

    const onSubmit = async (data: RegisterForm) => {
        try {
            const res = await api.post('/register', { email: data.email.trim(), password: data.password });
            login(res.data.access_token);
            navigate(next);
        } catch (err) {
            setError('root', { message: apiError(err, 'Não foi possível criar a conta. Tente novamente.') });
        }
    };

    if (token) return <Navigate to={next} replace />;

    return (
        <AuthShell title="Crie sua conta" subtitle="Leva 10 segundos: só email e senha.">
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
                <Field label="Email" htmlFor="email" error={errors.email?.message}>
                    <Input
                        {...register('email', {
                            required: 'Informe seu email',
                            pattern: { value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, message: 'Email inválido' },
                        })}
                        id="email"
                        type="email"
                        autoComplete="email"
                        placeholder="email@exemplo.com"
                        icon={<Mail />}
                        className="h-12"
                    />
                </Field>
                <Field label="Senha" htmlFor="password" error={errors.password?.message} hint={`Pelo menos ${PASSWORD_MIN} caracteres.`}>
                <div className="relative">
                    <Input
                        {...register('password', {
                            required: 'Crie uma senha',
                            minLength: { value: PASSWORD_MIN, message: `Use pelo menos ${PASSWORD_MIN} caracteres` },
                        })}
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        icon={<Lock />}
                        className="h-12 pr-12"
                    />
                    <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Esconder a senha' : 'Mostrar a senha'}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground [&_svg]:size-4">
                        {showPassword ? <EyeOff /> : <Eye />}
                    </button>
                </div>
                </Field>
                {errors.root && (
                    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-center text-sm text-destructive">
                        {errors.root.message}
                    </div>
                )}

                <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
                    Criar conta
                    {!isSubmitting && <ArrowRight />}
                </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground">
                Já tem conta?{' '}
                <Link to={`/login${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-primary underline-offset-4 hover:underline">Entrar</Link>
            </p>
        </AuthShell>
    );
}
