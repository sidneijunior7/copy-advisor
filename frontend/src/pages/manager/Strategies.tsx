
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import api from '../../api';
import Card from '../../components/Card';
import { Plus, Copy } from 'lucide-react';

export default function Strategies() {
    const [strategies, setStrategies] = useState<any[]>([]);
    const [manager, setManager] = useState<any>(null);
    const { register, handleSubmit, reset } = useForm();
    const [error, setError] = useState('');

    const refresh = async () => {
        try {
            const res = await api.get('/strategies');
            setStrategies(res.data);
            const me = await api.get('/me/manager');
            setManager(me.data);
        } catch (e) { console.error(e); }
    };

    const onCreate = async (data: any) => {
        try {
            await api.post('/strategies', data);
            reset();
            refresh();
            setError('');
        } catch (err: any) {
            setError(err.response?.data?.detail || 'Failed to create strategy');
        }
    };

    useEffect(() => { refresh(); }, []);

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        alert('Key copied!');
    };

    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold text-foreground">Strategies</h1>
            <p className="text-muted-foreground">Define your trading strategies by Magic Number.</p>

            {/* Master Key Card */}
            {manager && (
                <div className="bg-gradient-to-r from-emerald-950/40 to-background p-6 rounded-xl shadow-lg border border-emerald-500/20 backdrop-blur-sm">
                    <h2 className="text-xl font-bold text-foreground mb-2"> Your Master Key</h2>
                    <p className="text-muted-foreground text-sm mb-4">Use this single key in your Master EA. The server will route trades based on the Magic Number.</p>
                    <div className="flex items-center space-x-4 bg-background/50 p-3 rounded-lg border border-border/50">
                        <code className="text-emerald-400 font-mono text-lg flex-1 overflow-hidden overflow-ellipsis">{manager.master_key}</code>
                        <button onClick={() => copyToClipboard(manager.master_key)} className="text-foreground hover:text-emerald-400 transition"><Copy /></button>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title="New Strategy">
                    <form onSubmit={handleSubmit(onCreate)} className="space-y-4">
                        <div>
                            <label className="text-xs text-muted-foreground uppercase font-semibold">Strategy Name</label>
                            <input {...register('name', { required: true })} className="w-full mt-1 p-3 bg-background border border-input rounded focus:border-primary outline-none transition text-foreground placeholder:text-muted-foreground" placeholder="e.g. Scalper Gold" />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground uppercase font-semibold">Magic Number</label>
                            <input {...register('magic_number', { required: true })} type="number" className="w-full mt-1 p-3 bg-background border border-input rounded focus:border-primary outline-none transition text-foreground placeholder:text-muted-foreground" placeholder="e.g. 123456" />
                        </div>
                        {error && <p className="text-red-500 text-sm">{error}</p>}
                        <button className="w-full py-3 bg-accent hover:bg-accent/80 rounded text-background font-bold flex items-center justify-center shadow-lg transform hover:-translate-y-0.5 transition">
                            <Plus size={18} className="mr-2" /> Create Strategy
                        </button>
                    </form>
                </Card>

                <div className="space-y-4">
                    {strategies.map(s => (
                        <Card key={s.id} className="border-l-4 border-l-emerald-500">
                            <div className="flex justify-between items-start">
                                <div>
                                    <h3 className="text-xl font-bold text-foreground">{s.name}</h3>
                                    <p className="text-sm text-muted-foreground">Magic Number: <span className="font-mono text-primary font-bold">{s.magic_number}</span></p>
                                </div>
                                <div className={`px-2 py-1 rounded text-xs font-bold uppercase ${s.is_active ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-900/50' : 'bg-red-900/30 text-red-400 border border-red-900/50'}`}>
                                    {s.is_active ? 'Active' : 'Inactive'}
                                </div>
                            </div>
                        </Card>
                    ))}
                    {strategies.length === 0 && <p className="text-muted-foreground italic">No strategies yet.</p>}
                </div>
            </div>
        </div>
    );
}
