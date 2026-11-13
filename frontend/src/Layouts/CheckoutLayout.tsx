import { Link, Outlet } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { ThemeToggle } from '../components/ThemeToggle';
import { PRIVACY_PATH, TERMS_PATH } from '../components/TermsNotice';

// The checkout's own frame: no "Entrar" or "Criar conta" to pull the visitor out of the flow, which signs in and
// signs up by itself. The logo still leads back to the marketplace
export default function CheckoutLayout() {
    return (
        <div className="flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
            <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
                <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4">
                    <Link to="/marketplace" className="flex min-w-0 items-baseline gap-2">
                        <span className="font-spartan text-lg font-bold">trademetric.</span>
                        <span className="hidden text-[10px] font-semibold uppercase tracking-widest text-primary sm:inline">Marketplace</span>
                    </Link>
                    <div className="flex shrink-0 items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                            <Lock className="size-3.5" /> Compra segura
                        </span>
                        <ThemeToggle />
                    </div>
                </div>
            </header>
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
                <Outlet />
            </main>
            <footer className="border-t border-border px-4 py-6 pb-24 text-center text-xs text-muted-foreground sm:pb-6">
                <p>Resultados passados não garantem resultados futuros. Operar no mercado envolve risco de perda.</p>
                <p className="mt-1 space-x-3">
                    <a href={TERMS_PATH} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Termos de Uso</a>
                    <a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Privacidade</a>
                </p>
            </footer>
        </div>
    );
}
