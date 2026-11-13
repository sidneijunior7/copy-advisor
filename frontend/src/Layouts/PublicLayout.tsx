import { Link, Outlet, useMatch } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ThemeToggle } from '../components/ThemeToggle';
import CompanyLine from '../components/CompanyLine';
import { Button } from '../components/ui/Button';
import { PRIVACY_PATH, TERMS_PATH } from '../components/TermsNotice';
import { cn } from '../lib/utils';

// Pages anyone can open: the marketplace and the links sent by email
export default function PublicLayout() {
    const { user } = useAuth();
    // A portfolio's page uses the whole screen: its charts and tables breathe and the text runs in fewer lines. The
    // catalog and the legal pages keep the narrower column, better for reading
    const wide = useMatch('/marketplace/:slug') != null;
    const width = wide ? 'max-w-[1760px] sm:px-6 lg:px-10' : 'max-w-6xl';
    return (
        <div className="flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
            <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
                <div className={cn('mx-auto flex h-16 items-center justify-between gap-2 px-4 sm:gap-4', width)}>
                    <Link to="/marketplace" className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                        <span className="font-spartan text-xl font-bold leading-none sm:leading-normal">trademetric.</span>
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-primary">Portfólios</span>
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
            <main className={cn('mx-auto w-full flex-1 px-4 py-6 sm:py-8', width)}>
                <Outlet />
            </main>
            <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted-foreground">
                <p>Resultados passados não garantem resultados futuros. Operar no mercado envolve risco de perda.</p>
                <CompanyLine className="mt-1" />
                <p className="mt-1">© {new Date().getFullYear()} Trademetric. Todos os direitos reservados.</p>
                <p className="mt-1 space-x-3">
                    <Link to={TERMS_PATH} className="hover:text-foreground">Termos de Uso</Link>
                    <Link to={PRIVACY_PATH} className="hover:text-foreground">Privacidade</Link>
                </p>
            </footer>
        </div>
    );
}
