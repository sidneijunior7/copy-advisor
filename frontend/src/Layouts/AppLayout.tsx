
import { useEffect, useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { Briefcase, Layers, LayoutDashboard, LogOut, Menu, Radio, ShieldCheck, Users, X, type LucideIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ThemeToggle } from '../components/ThemeToggle';
import { cn } from '../lib/utils';

type NavItem = { path: string; label: string; icon: LucideIcon; end?: boolean };
type NavSection = { title: string; items: NavItem[] };

const navByRole: Record<string, NavSection[]> = {
    MANAGER: [
        { title: 'Operação', items: [{ path: '/manager', label: 'Visão Geral', icon: LayoutDashboard, end: true }] },
        {
            title: 'Configuração',
            items: [
                { path: '/manager/strategies', label: 'Estratégias', icon: Layers },
                { path: '/manager/portfolios', label: 'Portfólios', icon: Briefcase },
                { path: '/manager/clients', label: 'Clientes', icon: Users },
            ],
        },
    ],
    TDM_DEV: [{ title: 'Administração', items: [{ path: '/dev', label: 'Gestores', icon: ShieldCheck, end: true }] }],
    CLIENT: [{ title: 'Conta', items: [{ path: '/client', label: 'Meus Sinais', icon: Radio, end: true }] }],
};

const roleLabels: Record<string, string> = {
    MANAGER: 'Gestor',
    TDM_DEV: 'Administrador',
    CLIENT: 'Cliente',
};

const navLink = 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200';
const navIdle = 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground';

function Logo({ className }: { className?: string }) {
    return (
        <div className={cn('flex items-baseline gap-2', className)}>
            <span className="font-spartan text-xl font-bold text-sidebar-foreground">trademetric.</span>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-primary">Mirror</span>
        </div>
    );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
    const { user, logout } = useAuth();
    const sections = navByRole[user?.role ?? ''] ?? [];

    return (
        <div className="flex h-full flex-col">
            <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-6">
                <Logo />
            </div>

            <nav className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
                {sections.map((section, i) => (
                    <div key={section.title} className={cn(i > 0 && 'border-t border-sidebar-border pt-6')}>
                        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-sidebar-foreground/50">
                            {section.title}
                        </p>
                        <div className="space-y-1">
                            {section.items.map(item => (
                                <NavLink
                                    key={item.path}
                                    to={item.path}
                                    end={item.end}
                                    onClick={onNavigate}
                                    className={({ isActive }) =>
                                        cn(navLink, isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground' : navIdle)
                                    }
                                >
                                    {({ isActive }) => (
                                        <>
                                            <item.icon className={cn('h-4 w-4', isActive && 'text-primary')} />
                                            {item.label}
                                        </>
                                    )}
                                </NavLink>
                            ))}
                        </div>
                    </div>
                ))}
            </nav>

            <div className="mt-auto space-y-2 border-t border-sidebar-border p-4">
                {user && (
                    <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 px-3 py-1">
                            <p className="truncate text-xs text-sidebar-foreground/80" title={user.sub}>{user.sub}</p>
                            <p className="text-[11px] text-sidebar-foreground/50">{roleLabels[user.role] ?? user.role}</p>
                        </div>
                        <ThemeToggle />
                    </div>
                )}
                <button onClick={logout} className={cn(navLink, navIdle, 'w-full')}>
                    <LogOut className="h-4 w-4" />
                    Sair
                </button>
            </div>
        </div>
    );
}

export default function AppLayout() {
    const location = useLocation();
    const [isMobileOpen, setIsMobileOpen] = useState(false);

    useEffect(() => {
        if (!isMobileOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsMobileOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isMobileOpen]);

    return (
        <div className="min-h-screen bg-background text-foreground">
            {/* Desktop Sidebar */}
            <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col border-r border-sidebar-border bg-sidebar md:flex">
                <SidebarContent />
            </aside>

            {/* Mobile Header */}
            <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
                <Logo />
                <button
                    onClick={() => setIsMobileOpen(true)}
                    className="rounded-lg p-2 text-foreground transition-colors hover:bg-accent"
                    aria-label="Abrir menu"
                >
                    <Menu className="h-6 w-6" />
                </button>
            </header>

            {/* Mobile Drawer */}
            <div className={cn('fixed inset-0 z-50 md:hidden', !isMobileOpen && 'pointer-events-none')} aria-hidden={!isMobileOpen}>
                <div
                    className={cn('absolute inset-0 bg-black/60 transition-opacity duration-300', isMobileOpen ? 'opacity-100' : 'opacity-0')}
                    onClick={() => setIsMobileOpen(false)}
                />
                <aside
                    className={cn(
                        'absolute left-0 top-0 h-full w-64 border-r border-sidebar-border bg-sidebar transition-[transform,visibility] duration-300 ease-in-out',
                        isMobileOpen ? 'translate-x-0' : 'invisible -translate-x-full',
                    )}
                >
                    <button
                        onClick={() => setIsMobileOpen(false)}
                        className="absolute right-3 top-4 rounded-lg p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                        aria-label="Fechar menu"
                    >
                        <X className="h-5 w-5" />
                    </button>
                    <SidebarContent onNavigate={() => setIsMobileOpen(false)} />
                </aside>
            </div>

            {/* Main Content */}
            <main className="flex min-h-[calc(100vh-57px)] flex-col p-4 md:ml-64 md:min-h-screen md:p-6">
                <div className="flex-1 animate-fade-in" key={location.pathname}>
                    <Outlet />
                </div>
                <footer className="mt-8 border-t border-border pt-6 text-center text-sm text-muted-foreground">
                    © {new Date().getFullYear()} Trademetric. Todos os direitos reservados.
                </footer>
            </main>
        </div>
    );
}
