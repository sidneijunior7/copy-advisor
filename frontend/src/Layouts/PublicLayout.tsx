import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ThemeToggle } from '../components/ThemeToggle';
import { Button } from '../components/ui/Button';

// Pages anyone can open: the marketplace and the links sent by email
export default function PublicLayout() {
    const { user } = useAuth();
    return (
        <div className="flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
            <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
                <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:gap-4">
                    <Link to="/marketplace" className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                        <span className="font-spartan text-xl font-bold leading-none sm:leading-normal">trademetric.</span>
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-primary">Marketplace</span>
                    </Link>
                    <nav className="flex shrink-0 items-center gap-1 sm:gap-2">
                        <ThemeToggle />
                        {user ? (
                            <Link to="/dashboard"><Button size="sm" variant="secondary">Meu painel</Button></Link>
                        ) : (
                            <>
                                <Link to="/login"><Button size="sm" variant="ghost">Entrar</Button></Link>
                                <Link to="/cadastro"><Button size="sm">Criar conta</Button></Link>
                            </>
                        )}
                    </nav>
                </div>
            </header>
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
                <Outlet />
            </main>
            <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted-foreground">
                <p>Resultados passados não garantem resultados futuros. Operar no mercado envolve risco de perda.</p>
                <p className="mt-1">© {new Date().getFullYear()} Trademetric. Todos os direitos reservados.</p>
            </footer>
        </div>
    );
}
