import { type ReactNode } from 'react';

const highlights = [
    { value: 'MT5', label: 'Master e Slave' },
    { value: 'Live', label: 'Sinais em tempo real' },
    { value: '1 : N', label: 'Uma conta, vários clientes' },
];

interface AuthShellProps {
    title: string;
    subtitle: string;
    children: ReactNode;
}

// The branding panel and the centered form column of the login and sign-up pages
export default function AuthShell({ title, subtitle, children }: AuthShellProps) {
    return (
        <div className="flex min-h-screen">
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

            <div className="flex w-full items-center justify-center p-8 lg:w-1/2">
                <div className="w-full max-w-md space-y-8">
                    <div className="flex items-baseline justify-center gap-2 lg:hidden">
                        <span className="font-spartan text-2xl font-bold text-foreground">trademetric.</span>
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-primary">Mirror</span>
                    </div>

                    <div className="text-center lg:text-left">
                        <h1 className="text-3xl font-bold">{title}</h1>
                        <p className="mt-2 text-muted-foreground">{subtitle}</p>
                    </div>

                    {children}
                </div>
            </div>
        </div>
    );
}
