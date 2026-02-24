import { useForm } from 'react-hook-form';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { Activity, TrendingUp, Users } from 'lucide-react';
import imageFx from '../assets/image_fx.png';

export default function Login() {
    const { register, handleSubmit, setError, formState: { errors } } = useForm();
    const { login } = useAuth();
    const navigate = useNavigate();

    const onSubmit = async (data: any) => {
        try {
            const formData = new URLSearchParams();
            formData.append('username', data.email);
            formData.append('password', data.password);

            const res = await api.post('/token', formData);
            login(res.data.access_token);
            navigate('/dashboard');
        } catch (err: any) {
            setError('root', {
                message: err.response?.data?.detail || 'Login failed'
            });
        }
    };

    return (
        <div className="flex min-h-screen w-full bg-background font-sans">
            {/* Visual Side (Left on Desktop) */}
            <div className="hidden lg:flex lg:w-1/2 relative bg-zinc-950 items-center justify-center p-12 overflow-hidden">
                <div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-900/40 via-zinc-950 to-zinc-950">
                    <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:20px_20px]" />
                    <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-zinc-950/50" />
                </div>

                <div className="relative z-10 w-full max-w-2xl space-y-12">
                    <div className="space-y-4">
                        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white">
                            Trademetric Mirror
                        </h1>
                        <p className="text-xl text-zinc-400">
                            Orquestre seus investimentos com inteligência e precisão.
                        </p>
                    </div>

                    <div className="flex gap-4 w-full">
                        <div className="flex-1 bg-background p-4 rounded-xl flex flex-col gap-3 shadow-lg hover:shadow-xl transition-shadow border border-border/50">
                            <div className="h-10 w-10 flex items-center justify-center bg-primary/1 rounded-lg text-primary ">
                                <TrendingUp size={20} />
                            </div>
                            <div>
                                <p className="text-xs font-medium text-muted-foreground">Total Profit</p>
                                <p className="text-lg font-bold text-foreground">+124.5%</p>
                            </div>
                        </div>

                        <div className="flex-1 bg-background p-4 rounded-xl flex flex-col gap-3 shadow-lg hover:shadow-xl transition-shadow border border-border/50">
                            <div className="h-10 w-10 flex items-center justify-center bg-primary/1 rounded-lg text-emerald-500">
                                <Activity size={20} />
                            </div>
                            <div>
                                <p className="text-xs font-medium text-muted-foreground">Win Rate</p>
                                <p className="text-lg font-bold text-foreground">68.2%</p>
                            </div>
                        </div>

                        <div className="flex-1 bg-background p-4 rounded-xl flex flex-col gap-3 shadow-lg hover:shadow-xl transition-shadow border border-border/50">
                            <div className="h-10 w-10 flex items-center justify-center bg-primary/1 rounded-lg text-teal-400">
                                <Users size={20} />
                            </div>
                            <div>
                                <p className="text-xs font-medium text-muted-foreground">Active Investors</p>
                                <p className="text-lg font-bold text-foreground">1,240+</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Form Side (Right on Desktop) */}
            <div className="flex-1 flex items-center justify-center p-8 bg-background relative">
                {/* Mobile Background Fallback */}
                <div className="absolute inset-0 lg:hidden z-0">
                    <img
                        src={imageFx}
                        alt="Background"
                        className="w-full h-full object-cover opacity-2"
                    />
                </div>

                <div className="w-full max-w-md space-y-8 relative z-10">
                    <div className="text-center lg:text-left">
                        <h1 className="font-spartan font-semibold text-foreground text-4xl">trademetric.</h1>
                        <p className="mt-2 text-muted-foreground">
                            Entre com suas credenciais para acessar o painel administrativo.
                        </p>
                    </div>

                    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-sm font-medium leading-none text-foreground" htmlFor="email">
                                Email
                            </label>
                            <input
                                {...register('email', { required: true })}
                                id="email"
                                type="email"
                                autoComplete="username"
                                placeholder="nome@empresa.com"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 focus:border-primary/50"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium leading-none text-foreground" htmlFor="password">
                                Senha
                            </label>
                            <input
                                {...register('password', { required: true })}
                                id="password"
                                type="password"
                                autoComplete="current-password"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 focus:border-primary/50"
                            />
                        </div>

                        {errors.root && (
                            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm text-center border border-destructive/50 bg-red-950/10 text-red-500">
                                {errors.root.message as string}
                            </div>
                        )}

                        <button
                            type="submit"
                            className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-11 px-8 w-full shadow-lg hover:shadow-primary/25"
                        >
                            Entrar
                        </button>
                    </form>

                    <div className="text-center text-sm text-muted-foreground">
                        <p>Esqueceu sua senha? <a href="#" className="font-medium text-primary hover:underline underline-offset-4">Recuperar acesso</a></p>
                    </div>
                </div>
            </div>
        </div>
    );
}
