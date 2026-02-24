
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import api from '../../api';
import Card from '../../components/Card';
import { ShieldCheck, Search } from 'lucide-react';

export default function Clients() {
    const [licenses, setLicenses] = useState<any[]>([]);
    const [portfolios, setPortfolios] = useState<any[]>([]); // To populate select
    const { register, handleSubmit, reset } = useForm();
    const [filter, setFilter] = useState('');

    const refresh = async () => {
        try {
            const [l, p] = await Promise.all([api.get('/licenses'), api.get('/portfolios')]);
            setLicenses(l.data);
            setPortfolios(p.data);
        } catch (e) { console.error(e); }
    };

    useEffect(() => { refresh(); }, []);

    const onCreateLicense = async (data: any) => {
        const payload = {
            portfolio_id: parseInt(data.portfolio_id),
            client_mt5_login: parseInt(data.client_mt5_login),
            max_lots: parseFloat(data.max_lots)
        };
        await api.post('/licenses', payload);
        reset();
        refresh();
    };

    const filteredLicenses = licenses.filter(l => l.client_mt5_login.toString().includes(filter));

    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold text-foreground">Client Management</h1>
            <p className="text-muted-foreground">Whitelist MT5 accounts and manage access permissions.</p>

            {/* Create License Bar */}
            <Card className="bg-gradient-to-r from-background to-muted/20 border-l-4 border-l-emerald-500">
                <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center"><ShieldCheck size={20} className="mr-2 text-accent" /> New Authorization</h3>
                <form onSubmit={handleSubmit(onCreateLicense)} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                    <div>
                        <label className="text-xs text-muted-foreground uppercase font-semibold">Portfolio Access</label>
                        <select {...register('portfolio_id', { required: true })} className="w-full mt-1 p-3 bg-background border border-input rounded-lg text-foreground focus:border-primary outline-none transition">
                            {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="text-xs text-muted-foreground uppercase font-semibold">MT5 Login ID</label>
                        <input {...register('client_mt5_login', { required: true })} type="number" className="w-full mt-1 p-3 bg-background border border-input rounded-lg text-foreground focus:border-primary outline-none transition" placeholder="e.g. 5002441" />
                    </div>
                    <div>
                        <label className="text-xs text-muted-foreground uppercase font-semibold">Max Lots Limit</label>
                        <input {...register('max_lots', { required: true })} type="number" step="0.01" className="w-full mt-1 p-3 bg-background border border-input rounded-lg text-foreground focus:border-primary outline-none transition" placeholder="1.0" />
                    </div>
                    <button className="bg-accent hover:bg-accent/80 h-12 rounded-lg text-background font-bold transition shadow-lg shadow-emerald-900/20">
                        Authorize Client
                    </button>
                </form>
            </Card>

            {/* Filter */}
            <div className="relative">
                <Search className="absolute left-3 top-3 text-muted-foreground" size={20} />
                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="w-full p-3 pl-10 bg-background rounded-lg border border-input text-foreground focus:border-primary outline-none transition"
                    placeholder="Search by MT5 Login ID..."
                />
            </div>

            {/* List */}
            <div className="overflow-hidden rounded-xl border border-border/50 bg-background/50 backdrop-blur-sm">
                <table className="w-full text-left text-sm">
                    <thead className="bg-muted/50 text-muted-foreground uppercase font-semibold">
                        <tr>
                            <th className="p-4">MT5 Login</th>
                            <th className="p-4">Portfolio Context</th>
                            <th className="p-4">Max Lots</th>
                            <th className="p-4">Date Added</th>
                            <th className="p-4">Status</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                        {filteredLicenses.map(l => (
                            <tr key={l.id} className="hover:bg-muted/30 transition">
                                <td className="p-4 font-mono text-foreground text-base">{l.client_mt5_login}</td>
                                <td className="p-4 text-primary">Portfolio #{l.portfolio_id}</td>
                                <td className="p-4 text-muted-foreground">{l.max_lots}</td>
                                <td className="p-4 text-muted-foreground">{new Date(l.created_at).toLocaleDateString()}</td>
                                <td className="p-4">
                                    <span className={`px-2 py-1 rounded text-xs font-bold ${l.is_active ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-900/50' : 'bg-red-900/30 text-red-400 border border-red-900/50'}`}>
                                        {l.is_active ? 'ACTIVE' : 'INACTIVE'}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filteredLicenses.length === 0 && <div className="p-8 text-center text-muted-foreground">No licenses found matching your search.</div>}
            </div>
        </div>
    );
}
