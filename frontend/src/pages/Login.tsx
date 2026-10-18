import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, Lock, Mail } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import AuthShell from '../components/AuthShell';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';

type LoginForm = { email: string; password: string };

const loginError = (err: any): string => {
    if (!err.response) return 'Não foi possível conectar ao servidor. Tente novamente.';
    if (err.response.status === 401) return 'Email ou senha inválidos.';
    if (err.response.status === 403) return 'Esta conta está suspensa. Fale com o suporte.';
    if (err.response.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    return 'Não foi possível entrar. Tente novamente.';
};

export default function Login() {
    const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<LoginForm>();
    const { login, token } = useAuth();
    const navigate = useNavigate();

    const onSubmit = async (data: LoginForm) => {
        try {
            const formData = new URLSearchParams();
            formData.append('username', data.email);
            formData.append('password', data.password);

            const res = await api.post('/token', formData);
            login(res.data.access_token);
            navigate('/dashboard');
        } catch (err: any) {
            setError('root', { message: loginError(err) });
        }
    };

    if (token) return <Navigate to="/dashboard" replace />;

    return (
        <AuthShell title="Bem-vindo de volta" subtitle="Insira suas credenciais para acessar o painel.">
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
                <Field label="Email" htmlFor="email" error={errors.email?.message}>
                    <Input
                        {...register('email', { required: 'Informe seu email' })}
                        id="email"
                        type="email"
                        autoComplete="username"
                        placeholder="email@exemplo.com"
                        icon={<Mail />}
                        className="h-12"
                    />
                </Field>
                <Field label="Senha" htmlFor="password" error={errors.password?.message}>
                    <Input
                        {...register('password', { required: 'Informe sua senha' })}
                        id="password"
                        type="password"
                        autoComplete="current-password"
                        placeholder="••••••••"
                        icon={<Lock />}
                        className="h-12"
                    />
                </Field>

                {errors.root && (
                    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-center text-sm text-destructive">
                        {errors.root.message}
                    </div>
                )}

                <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
                    Entrar
                    {!isSubmitting && <ArrowRight />}
                </Button>
            </form>

            <div className="space-y-2 text-center text-sm text-muted-foreground">
                <p>
                    Ainda não tem conta?{' '}
                    <Link to="/cadastro" className="font-medium text-primary underline-offset-4 hover:underline">Cadastre-se</Link>
                </p>
                <p>Esqueceu a senha? Fale com o suporte.</p>
            </div>
        </AuthShell>
    );
}
