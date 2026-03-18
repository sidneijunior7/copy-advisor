
import { useWebSocket } from '../../hooks/useWebSocket';
import Card from '../../components/Card';
import { Activity, TrendingUp } from 'lucide-react';

export default function ManagerOverview() {
    const { status, trades } = useWebSocket();
    const activeTrades = Object.values(trades);

    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold text-foreground mb-2">Dashboard Overview</h1>
            <p className="text-muted-foreground">Real-time monitoring of active operations.</p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card className="flex items-center space-x-4 from-emerald-900/20 via-background to-background bg-gradient-to-br">
                    <div className="p-3 bg-accent/2 rounded-xl text-accent"><Activity size={24} /></div>
                    <div>
                        <p className="text-muted-foreground text-sm">System Status</p>
                        <p className={`text-xl font-bold ${status === 'CONNECTED' ? 'text-primary' : 'text-red-400'}`}>{status}</p>
                    </div>
                </Card>
                <Card className="flex items-center space-x-4 from-emerald-900/20 via-background to-background bg-gradient-to-br">
                    <div className="p-3 bg-accent/2 rounded-xl text-accent"><TrendingUp size={24} /></div>
                    <div>
                        <p className="text-muted-foreground text-sm">Active Trades</p>
                        <p className="text-xl font-bold text-foreground">{activeTrades.length}</p>
                    </div>
                </Card>
            </div>

            <Card title="Live Feed">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead>
                            <tr className="bg-muted/50 text-muted-foreground uppercase tracking-wider">
                                <th className="p-3 rounded-tl-lg">Ticket</th>
                                <th className="p-3">Symbol</th>
                                <th className="p-3">Type</th>
                                <th className="p-3">Lots</th>
                                <th className="p-3">Price</th>
                                <th className="p-3 rounded-tr-lg">Time</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                            {activeTrades.map((t: any) => (
                                <tr key={t.ticket} className="hover:bg-muted/30 transition-colors">
                                    <td className="p-3 font-mono text-foreground">{t.ticket}</td>
                                    <td className="p-3 font-bold text-blue-400">{t.symbol}</td>
                                    <td className="p-3">
                                        <span className={`px-2 py-1 rounded text-xs font-bold ${t.type === '0' ? 'bg-emerald-900/30 text-emerald-400' : 'bg-red-900/30 text-red-400'}`}>
                                            {t.type === '0' ? 'BUY' : 'SELL'}
                                        </span>
                                    </td>
                                    <td className="p-3 text-foreground">{t.volume}</td>
                                    <td className="p-3 text-foreground">{t.price}</td>
                                    <td className="p-3 text-muted-foreground text-xs">{new Date(t.timestamp * 1000).toLocaleTimeString()}</td>
                                </tr>
                            ))}
                            {activeTrades.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="p-8 text-center text-gray-500 italic">No active trades at the moment.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}
