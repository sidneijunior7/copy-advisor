
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import api from '../../api';
import Card from '../../components/Card';
import { Link as LinkIcon, Plus, Copy, Check } from 'lucide-react';

export default function Portfolios() {
    const [portfolios, setPortfolios] = useState<any[]>([]);
    const [strategies, setStrategies] = useState<any[]>([]);
    const { register: regPort, handleSubmit: subPort, reset: resPort } = useForm();
    const { register: regLink, handleSubmit: subLink, reset: resLink } = useForm();
    const [copied, setCopied] = useState<string | null>(null);

    const refresh = async () => {
        try {
            const [p, s] = await Promise.all([api.get('/portfolios'), api.get('/strategies')]);
            setPortfolios(p.data);
            setStrategies(s.data);
        } catch (e) { console.error(e); }
    };

    useEffect(() => { refresh(); }, []);

    const onCreatePortfolio = async (data: any) => {
        try {
            console.log("Creating portfolio with data:", data);
            await api.post('/portfolios', data);
            resPort();
            refresh();
        } catch (e) {
            console.error("Failed to create portfolio:", e);
            alert("Failed to create portfolio. Check console.");
        }
    };

    const onLink = async (data: any) => {
        if (!data.portfolio_id || !data.strategy_id) {
            alert("Please select both a Portfolio and a Strategy.");
            return;
        }
        try {
            await api.post(`/portfolios/${data.portfolio_id}/add_strategy/${data.strategy_id}`);
            resLink();
            refresh();
        } catch (e: any) {
            console.error(e);
            alert(e.response?.data?.detail || "Failed to link strategy.");
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(text);
        setTimeout(() => setCopied(null), 2000);
    };

    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold text-foreground">Portfolios</h1>
            <p className="text-muted-foreground">Bundle strategies into portfolios for clients to follow.</p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* Creation Forms */}
                <div className="space-y-6">
                    <Card title="Create Portfolio">
                        <form onSubmit={subPort(onCreatePortfolio)} className="flex gap-2">
                            <input {...regPort('name', { required: true })} className="flex-1 p-3 bg-background border border-input rounded-lg focus:border-primary outline-none text-foreground placeholder:text-muted-foreground transition" placeholder="Portfolio Name" />
                            <button className="bg-primary hover:bg-primary/90 px-6 rounded-lg text-primary-foreground font-bold shadow-lg shadow-primary/20 transition"><Plus /></button>
                        </form>
                    </Card>

                    <Card title="Link Strategy to Portfolio">
                        <form onSubmit={subLink(onLink)} className="space-y-4">
                            <div>
                                <label className="text-xs text-muted-foreground uppercase font-semibold">Portfolio</label>
                                <select {...regLink('portfolio_id', { required: true })} className="w-full mt-1 p-3 bg-background border border-input rounded-lg text-foreground focus:border-primary outline-none transition">
                                    <option value="">Select Portfolio...</option>
                                    {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground uppercase font-semibold">Strategy</label>
                                <select {...regLink('strategy_id', { required: true })} className="w-full mt-1 p-3 bg-background border border-input rounded-lg text-foreground focus:border-primary outline-none transition">
                                    <option value="">Select Strategy...</option>
                                    {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                            </div>
                            <button className="w-full py-3 bg-muted hover:bg-muted/80 rounded-lg text-foreground font-bold flex items-center justify-center transition border border-border/50">
                                <LinkIcon size={18} className="mr-2" /> Link Strategy
                            </button>
                        </form>
                    </Card>
                </div>

                {/* List */}
                <div className="space-y-4">
                    {portfolios.map(p => (
                        <Card key={p.id} className="border-l-4 border-l-primary hover:border-primary/80 transition shadow-sm">
                            <h3 className="text-xl font-bold text-foreground mb-2">{p.name}</h3>
                            <div className="mb-4">
                                <h4 className="text-xs text-muted-foreground uppercase font-semibold mb-2">Linked Strategies:</h4>
                                {p.strategies && p.strategies.length > 0 ? (
                                    <div className="flex flex-wrap gap-2">
                                        {p.strategies.map((s: any) => (
                                            <span key={s.id} className="bg-primary/10 text-primary px-2 py-1 rounded text-sm border border-primary/20">
                                                {s.name} (#{s.magic_number})
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-sm text-muted-foreground italic">No strategies linked yet.</p>
                                )}
                            </div>

                            <div className="bg-muted/30 p-3 rounded border border-border/50">
                                <label className="text-xs text-muted-foreground uppercase block mb-1">Public Connection Key (For Clients)</label>
                                <div
                                    onClick={() => copyToClipboard(p.public_key)}
                                    className="flex items-center justify-between cursor-pointer"
                                >
                                    <code className="text-primary font-mono text-sm">{p.public_key}</code>
                                    {copied === p.public_key ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} className="text-muted-foreground hover:text-foreground transition" />}
                                </div>
                            </div>
                        </Card>
                    ))}
                    {portfolios.length === 0 && <p className="text-muted-foreground">No portfolios created.</p>}
                </div>
            </div>
        </div>
    );
}
