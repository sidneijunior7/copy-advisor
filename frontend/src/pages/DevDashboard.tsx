
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import api from '../api';
import { Lock, Unlock, Archive, Plus, ShieldAlert } from 'lucide-react';
import Card from '../components/Card';
import { useAuth } from '../context/AuthContext';


export default function DevDashboard() {
    const { logout } = useAuth();
    const [managers, setManagers] = useState<any[]>([]);
    const { register, handleSubmit, reset } = useForm();
    const [error, setError] = useState('');

    const refresh = async () => {
        try {
            const res = await api.get('/admin/managers');
            setManagers(res.data);
        } catch (e) { console.error(e); }
    };

    useEffect(() => { refresh(); }, []);

    const onCreateManager = async (data: any) => {
        try {
            await api.post('/admin/managers', { ...data, role: 'MANAGER' });
            reset();
            refresh();
            setError('');
        } catch (err: any) {
            setError(err.response?.data?.detail || 'Failed to create manager');
        }
    };

    const updateStatus = async (id: number, status: string) => {
        await api.patch(`/admin/managers/${id}/status?status=${status}`);
        refresh();
    };

    return (
        <div className="min-h-screen bg-background text-foreground font-sans relative overflow-hidden">
            {/* Background Pattern */}
            <div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-900/40 via-zinc-950 to-zinc-950 pointer-events-none">
                <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:20px_20px]" />
                <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-zinc-950/50" />
            </div>

            <div className="relative z-10 p-8 max-w-7xl mx-auto">
                <div className="flex justify-between items-center mb-8 border-b border-border/50 pb-4">
                    <div>
                        <h1 className="text-3xl font-bold bg-accent bg-clip-text text-transparent">Trademetric Mirror | DEV Console</h1>
                        <p className="text-xs text-muted-foreground uppercase tracking-widest">Superuser Access</p>
                    </div>
                    <button onClick={logout} className="transition bg-accent/80 rounded text-background font-bold flex justify-center items-center shadow-lg transform hover:-translate-y-0.5 transition p-4">Logout</button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Create Manager */}
                    <Card title="Add New Manager" className="h-fit border-accent-900/30 shadow-sm">
                        <form onSubmit={handleSubmit(onCreateManager)} className="space-y-4">
                            <div>
                                <label className="text-xs text-muted-foreground uppercase font-semibold">Email</label>
                                <input {...register('email', { required: true })} type="email" className="w-full mt-1 p-3 bg-background border border-input rounded focus:border-red-500 outline-none transition text-foreground placeholder:text-muted-foreground" />
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground uppercase font-semibold">Password</label>
                                <input {...register('password', { required: true })} type="password" className="w-full mt-1 p-3 bg-background border border-input rounded focus:border-red-500 outline-none transition text-foreground placeholder:text-muted-foreground" />
                            </div>
                            {error && <p className="text-red-500 text-sm">{error}</p>}
                            <button className="w-full py-3 bg-accent hover:bg-accent/80 rounded text-background font-bold flex justify-center items-center shadow-lg transform hover:-translate-y-0.5 transition">
                                <Plus size={18} className="mr-2" /> Create Manager
                            </button>
                        </form>
                    </Card>

                    {/* List Managers */}
                    <div className="lg:col-span-2 space-y-4">
                        <h2 className="text-xl font-bold text-foreground mb-4 flex items-center"><ShieldAlert size={20} className="mr-2 text-red-500" /> Manager Accounts</h2>
                        {managers.map(m => (
                            <div key={m.id} className="bg-background border border-border/50 p-4 rounded-lg flex flex-col md:flex-row justify-between items-center hover:border-red-500/30 transition shadow-sm">
                                <div className="mb-4 md:mb-0">
                                    <h3 className="text-lg font-bold text-foreground">{m.email}</h3>
                                    <p className="text-sm text-muted-foreground">ID: {m.id} • Created: {new Date(m.created_at).toLocaleDateString()}</p>
                                </div>

                                <div className="flex items-center space-x-3">
                                    <span className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider ${m.status === 'active' ? 'bg-emerald-900/30 text-emerald-400' :
                                        m.status === 'frozen' ? 'bg-yellow-900/30 text-yellow-400' : 'bg-red-900/30 text-red-400'
                                        }`}>
                                        {m.status}
                                    </span>

                                    <div className="flex space-x-1 bg-muted/30 rounded p-1 border border-border/20">
                                        <button onClick={() => updateStatus(m.id, 'active')} title="Activate" className={`p-2 rounded transition ${m.status === 'active' ? 'bg-emerald-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}><Unlock size={16} /></button>
                                        <button onClick={() => updateStatus(m.id, 'frozen')} title="Freeze" className={`p-2 rounded transition ${m.status === 'frozen' ? 'bg-yellow-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}><Lock size={16} /></button>
                                        <button onClick={() => updateStatus(m.id, 'archived')} title="Archive" className={`p-2 rounded transition ${m.status === 'archived' ? 'bg-red-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}><Archive size={16} /></button>
                                    </div>
                                </div>
                            </div>
                        ))}
                        {managers.length === 0 && <p className="text-muted-foreground">No managers found.</p>}
                    </div>
                </div>
            </div>
        </div>
    );
}
