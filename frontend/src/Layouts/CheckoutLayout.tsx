import { Link, Outlet } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { ThemeToggle } from '../components/ThemeToggle';

// The checkout's own frame: no "Entrar" or "Criar conta" to pull the visitor out of the flow, which signs in and
// signs up by itself. The logo still leads back to the marketplace. The page below uses the whole width: the steps on
// one side and the order on the other, each to its edge (CheckoutPage)
export default function CheckoutLayout() {
    return (
        <div className="flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
            <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
                <div className="flex h-14 items-center justify-between gap-2 px-4 sm:px-6 lg:px-12">
                    <Link to="/marketplace" className="flex min-w-0 items-baseline gap-2">
                        <span className="font-spartan text-lg font-bold">trademetric.</span>
                        <span className="hidden text-[10px] font-semibold uppercase tracking-widest text-primary sm:inline">Portfólios</span>
                    </Link>
                    <div className="flex shrink-0 items-center gap-3">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <Lock className="size-3.5 text-success" /> Compra segura
                        </span>
                        <ThemeToggle />
                    </div>
                </div>
            </header>
            <main className="flex w-full flex-1 flex-col">
                <Outlet />
            </main>
        </div>
    );
}
