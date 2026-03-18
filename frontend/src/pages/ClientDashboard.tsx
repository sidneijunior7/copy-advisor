
import { useWebSocket } from '../hooks/useWebSocket';

export default function ClientDashboard() {
    const { status, trades } = useWebSocket();

    return (
        <div className="p-6 bg-gray-900 text-gray-100 min-h-screen flex flex-col items-center">
            <h1 className="text-3xl font-bold mb-2 text-teal-400">Client Dashboard</h1>
            <div className={`mb-6 text-sm font-mono ${status === 'CONNECTED' ? 'text-green-500' : 'text-red-500'}`}>
                Status: {status}
            </div>

            <div className="w-full max-w-4xl bg-gray-800 p-6 rounded-lg shadow-lg">
                <h2 className="text-xl font-semibold mb-4 border-b border-gray-700 pb-2">Your Copy Trading Signals</h2>

                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead>
                            <tr className="bg-gray-700 text-gray-300">
                                <th className="p-3">Ticket</th>
                                <th className="p-3">Symbol</th>
                                <th className="p-3">Type</th>
                                <th className="p-3">Lots</th>
                                <th className="p-3">Open Price</th>
                                <th className="p-3">SL</th>
                                <th className="p-3">TP</th>
                            </tr>
                        </thead>
                        <tbody>
                            {Object.values(trades).map((t: any) => (
                                <tr key={t.ticket} className="border-b border-gray-700 hover:bg-gray-750 transition">
                                    <td className="p-3">{t.ticket}</td>
                                    <td className="p-3 font-bold text-blue-400">{t.symbol}</td>
                                    <td className={`p-3 ${t.type === '0' ? 'text-green-400' : 'text-red-400'}`}>
                                        {t.type === '0' ? 'BUY' : 'SELL'}
                                    </td>
                                    <td className="p-3">{t.volume}</td>
                                    <td className="p-3">{t.price}</td>
                                    <td className="p-3 text-red-300">{t.sl}</td>
                                    <td className="p-3 text-green-300">{t.tp}</td>
                                </tr>
                            ))}
                            {Object.values(trades).length === 0 && (
                                <tr>
                                    <td colSpan={7} className="p-8 text-center text-gray-500 italic">
                                        Waiting for signals...
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
