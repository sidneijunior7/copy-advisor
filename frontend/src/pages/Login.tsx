import { useForm } from 'react-hook-form';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, Lock, Mail } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';

type LoginForm = { email: string; password: string };

const highlights = [
    { value: 'MT5', label: 'Master e Slave' },
    { value: 'Live', label: 'Sinais em tempo real' },
    { value: '1 : N', label: 'Uma conta, vários clientes' },
];

const loginError = (err: any): string => {
    if (!err.response) return 'Não foi possível conectar ao servidor. Tente novamente.';
    if (err.response.status === 401) return 'Email ou senha inválidos.';
    if (err.response.status === 403) return 'Esta conta está suspensa. Fale com o suporte.';
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
        <div className="flex min-h-screen">
            {/* Left Panel - Branding */}
            <div className="relative hidden flex-col justify-between overflow-hidden bg-card p-12 lg:flex lg:w-1/2">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-transparent" />
                <div className="absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
                <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
                <div
                    className="absolute inset-0 opacity-[0.05]"
                    style={{
                        backgroundImage: 'linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)',
                        backgroundSize: '60px 60px',
                        maskImage: 'linear-gradient(to bottom right, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 60%)',
                        WebkitMaskImage: 'linear-gradient(to bottom right, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 60%)',
                    }}
                />

                <div className="relative z-10 flex items-baseline gap-2">
                    <span className="font-spartan text-3xl font-bold text-foreground">trademetric.</span>
                    <span className="text-xs font-semibold uppercase tracking-widest text-primary">Mirror</span>
                </div>

                <div className="relative z-10 space-y-6">
                    <h2 className="text-4xl font-bold leading-tight">
                        Replique suas<br />
                        <span className="text-gradient">estratégias</span><br />
                        em tempo real
                    </h2>
                    <p className="max-w-md text-muted-foreground">
                        Copytrade entre contas MetaTrader 5, com sinais distribuídos pela nuvem e
                        controle total sobre quem recebe cada portfólio.
                    </p>

                    <div className="grid grid-cols-3 gap-4 pt-6">
                        {highlights.map(h => (
                            <div key={h.value} className="rounded-lg bg-secondary/50 p-4">
                                <p className="font-mono text-2xl font-bold text-primary">{h.value}</p>
                                <p className="text-xs text-muted-foreground">{h.label}</p>
                            </div>
                        ))}
                    </div>
                </div>

                <p className="relative z-10 text-sm text-muted-foreground">
                    © {new Date().getFullYear()} Trademetric. Todos os direitos reservados.
                </p>
            </div>

            {/* Right Panel - Form */}
            <div className="flex w-full items-center justify-center p-8 lg:w-1/2">
                <div className="w-full max-w-md space-y-8">
                    <div className="flex items-baseline justify-center gap-2 lg:hidden">
                        <span className="font-spartan text-2xl font-bold text-foreground">trademetric.</span>
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-primary">Mirror</span>
                    </div>

                    <div className="text-center lg:text-left">
                        <h1 className="text-3xl font-bold">Bem-vindo de volta</h1>
                        <p className="mt-2 text-muted-foreground">Insira suas credenciais para acessar o painel.</p>
                    </div>

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

                    <p className="text-center text-sm text-muted-foreground">
                        Esqueceu a senha? Fale com o administrador da sua conta.
                    </p>
                </div>
            </div>
        </div>
    );
}
