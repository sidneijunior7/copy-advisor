
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LayoutDashboard, Layers, Briefcase, Users, LogOut } from 'lucide-react';

export default function ManagerLayout() {
    const { logout } = useAuth();
    const location = useLocation();

    const navItems = [
        { path: '/manager', icon: LayoutDashboard, label: 'Overview' },
        { path: '/manager/strategies', icon: Layers, label: 'Strategies' },
        { path: '/manager/portfolios', icon: Briefcase, label: 'Portfolios' },
        { path: '/manager/clients', icon: Users, label: 'Clients' },
    ];

    return (
        <div className="flex h-screen bg-background text-foreground overflow-hidden font-sans">
            {/* Sidebar */}
            <aside className="w-64 bg-background border-r border-border/50 flex flex-col z-20">
                <div className="p-6">
                    <h1 className="text-2xl font-bold font-spartan bg-accent bg-clip-text text-transparent">
                        trademetric.
                    </h1>
                    <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider">Mirror App</p>
                </div>

                <nav className="flex-1 px-4 space-y-2">
                    {navItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = location.pathname === item.path || (item.path !== '/manager' && location.pathname.startsWith(item.path));
                        return (
                            <Link
                                key={item.path}
                                to={item.path}
                                className={`flex items-center px-4 py-3 rounded-lg transition-all transform hover:scale-105 ${isActive
                                    ? 'bg-primary/10 text-background border border-primary/20'
                                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                                    }`}
                            >
                                <Icon size={20} className="mr-3" />
                                <span className="font-medium">{item.label}</span>
                            </Link>
                        )
                    })}
                </nav>

                <div className="p-4 border-t border-border/50">
                    <button
                        onClick={logout}
                        className="flex items-center w-full px-4 py-3 text-red-500 hover:bg-red-950/10 rounded-lg transition"
                    >
                        <LogOut size={20} className="mr-3" />
                        <span>Logout</span>
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-y-auto relative bg-zinc-950">
                {/* Background Pattern */}
                <div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-900/40 via-zinc-950 to-zinc-950 pointer-events-none">
                    <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:20px_20px]" />
                    <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-zinc-950/50" />
                </div>

                <div className="relative z-10 p-8 max-w-7xl mx-auto">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}
