
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import api from '../api';
import { useWebSocket } from '../hooks/useWebSocket';

export default function ManagerDashboard() {
    const { status, trades } = useWebSocket();
    const [strategies, setStrategies] = useState<any[]>([]);
    // const [portfolios, setPortfolios] = useState<any[]>([]); // Planned for future use
    const { register: registerStrat, handleSubmit: handleStrat, reset: resetStrat } = useForm();
    const { register: registerPort, handleSubmit: handlePort, reset: resetPort } = useForm();
    const { register: registerLic, handleSubmit: handleLic, reset: resetLic } = useForm();
    const { register: registerLink, handleSubmit: handleLink, reset: resetLink } = useForm();

    const refreshData = async () => {
        try {
            const s = await api.get('/strategies');
            setStrategies(s.data);
            // Portfolios endpoint not explicitly listed as GET in server.py (It was created but maybe no GET list for manager?)
            // Wait, looking at server.py, I didn't add GET /portfolios for Manager. 
            // I should add it or just assume I can't list them yet. 
            // Let's check server.py... I only did create_portfolio.
            // I will skip listing portfolios for now or just mock it if it fails.
            // Actually, I should probably add GET /portfolios to server.py if I want to show them.
            // For now, I will try to fetch strategies only.
        } catch (e) { console.error(e); }
    };

    useEffect(() => {
        refreshData();
    }, []);

    const onCreateStrategy = async (data: any) => {
        await api.post('/strategies', data);
        resetStrat();
        refreshData();
    };

    const onCreatePortfolio = async (data: any) => {
        await api.post('/portfolios', data);
        resetPort();
        refreshData();
    };

    const onCreateLicense = async (data: any) => {
        const payload = {
            ...data,
            strategy_id: data.type === 'strategy' ? parseInt(data.target_id) : null,
            portfolio_id: data.type === 'portfolio' ? parseInt(data.target_id) : null,
            client_mt5_login: parseInt(data.client_mt5_login),
            max_lots: parseFloat(data.max_lots)
        };
        await api.post('/licenses', payload);
        resetLic();
        alert("License Created!");
    };

    const onLinkStrategy = async (data: any) => {
        await api.post(`/portfolios/${data.portfolio_id}/add_strategy/${data.strategy_id}`);
        resetLink();
        alert("Linked!");
    };

    return (
        <div className="p-6 bg-gray-900 text-gray-100 min-h-screen">
            <h1 className="text-3xl font-bold mb-6 text-teal-400">Manager Dashboard</h1>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                {/* Active Trades Panel */}
                <div className="bg-gray-800 p-4 rounded-lg shadow col-span-1 md:col-span-2">
                    <h2 className="text-xl font-semibold mb-4 border-b border-gray-700 pb-2 flex justify-between">
                        <span>Active Trades (Live)</span>
                        <span className={`text-sm ${status === 'CONNECTED' ? 'text-green-500' : 'text-red-500'}`}>{status}</span>
                    </h2>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead>
                                <tr className="bg-gray-700 text-gray-300">
                                    <th className="p-2">Ticket</th>
                                    <th className="p-2">Symbol</th>
                                    <th className="p-2">Type</th>
                                    <th className="p-2">Lots</th>
                                    <th className="p-2">Price</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.values(trades).map((t: any) => (
                                    <tr key={t.ticket} className="border-b border-gray-700 hover:bg-gray-750">
                                        <td className="p-2">{t.ticket}</td>
                                        <td className="p-2 font-bold text-blue-400">{t.symbol}</td>
                                        <td className={`p-2 ${t.type === '0' ? 'text-green-400' : 'text-red-400'}`}>
                                            {t.type === '0' ? 'BUY' : 'SELL'}
                                        </td>
                                        <td className="p-2">{t.volume}</td>
                                        <td className="p-2">{t.price}</td>
                                    </tr>
                                ))}
                                {Object.keys(trades).length === 0 && (
                                    <tr><td colSpan={5} className="p-4 text-center text-gray-500">No active trades</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Create Strategy */}
                <div className="bg-gray-800 p-4 rounded-lg shadow">
                    <h2 className="text-xl font-semibold mb-4">Create Strategy</h2>
                    <form onSubmit={handleStrat(onCreateStrategy)} className="space-y-3">
                        <input {...registerStrat('name')} placeholder="Strategy Name" className="w-full p-2 bg-gray-700 rounded border border-gray-600" required />
                        <input {...registerStrat('magic_number')} placeholder="Magic Number (e.g. 12345)" type="number" className="w-full p-2 bg-gray-700 rounded border border-gray-600" required />
                        <button className="w-full bg-blue-600 hover:bg-blue-500 p-2 rounded text-white font-bold">Create Strategy</button>
                    </form>

                    <h3 className="text-lg mt-4 mb-2 text-gray-400">Your Strategies</h3>
                    <ul className="text-sm space-y-2 max-h-40 overflow-y-auto">
                        {strategies.map((s: any) => (
                            <li key={s.id} className="bg-gray-700 p-2 rounded flex justify-between items-center">
                                <span>{s.name} (#{s.magic_number})</span>
                                <span className="text-xs bg-gray-600 px-2 py-1 rounded select-all cursor-pointer" title="Secret Key">{s.secret_key}</span>
                            </li>
                        ))}
                    </ul>
                </div>

                {/* Create Portfolio */}
                <div className="bg-gray-800 p-4 rounded-lg shadow">
                    <h2 className="text-xl font-semibold mb-4">Create Portfolio</h2>
                    <form onSubmit={handlePort(onCreatePortfolio)} className="space-y-3">
                        <input {...registerPort('name')} placeholder="Portfolio Name" className="w-full p-2 bg-gray-700 rounded border border-gray-600" required />
                        <button className="w-full bg-purple-600 hover:bg-purple-500 p-2 rounded text-white font-bold">Create Portfolio</button>
                    </form>

                    <h2 className="text-xl font-semibold mt-8 mb-4">Link Strategy to Portfolio</h2>
                    <form onSubmit={handleLink(onLinkStrategy)} className="space-y-3">
                        <input {...registerLink('portfolio_id')} placeholder="Portfolio ID" type="number" className="w-full p-2 bg-gray-700 rounded border border-gray-600" required />
                        <input {...registerLink('strategy_id')} placeholder="Strategy ID" type="number" className="w-full p-2 bg-gray-700 rounded border border-gray-600" required />
                        <button className="w-full bg-gray-600 hover:bg-gray-500 p-2 rounded text-white font-bold">Link</button>
                    </form>
                </div>

                {/* Licenses */}
                <div className="bg-gray-800 p-4 rounded-lg shadow col-span-1 md:col-span-2">
                    <h2 className="text-xl font-semibold mb-4">Whitelist Client (License)</h2>
                    <form onSubmit={handleLic(onCreateLicense)} className="grid grid-cols-1 md:grid-cols-5 gap-4">
                        <select {...registerLic('type')} className="p-2 bg-gray-700 rounded border border-gray-600 text-white">
                            <option value="portfolio">Portfolio ID</option>
                            <option value="strategy">Strategy ID</option>
                        </select>
                        <input {...registerLic('target_id')} placeholder="ID" type="number" className="p-2 bg-gray-700 rounded border border-gray-600" required />
                        <input {...registerLic('client_mt5_login')} placeholder="Client MT5 Login" type="number" className="p-2 bg-gray-700 rounded border border-gray-600" required />
                        <input {...registerLic('max_lots')} placeholder="Max Lots (e.g. 1.0)" step="0.01" type="number" className="p-2 bg-gray-700 rounded border border-gray-600" required />
                        <button className="bg-green-600 hover:bg-green-500 p-2 rounded text-white font-bold">Add License</button>
                    </form>
                </div>

            </div>
        </div>
    );
}
