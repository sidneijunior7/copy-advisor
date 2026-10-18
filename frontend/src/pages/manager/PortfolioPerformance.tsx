import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, TrendingUp } from 'lucide-react';
import api, { type BacktestView, type FollowerStats, type Portfolio, type PortfolioPerformance as Performance } from '../../api';
import BacktestSection from '../../components/BacktestSection';
import FollowerStatsView from '../../components/FollowerStatsView';
import PageHeader from '../../components/PageHeader';
import PerformanceView from '../../components/PerformanceView';
import { Select } from '../../components/ui/Field';
import { PERIODS } from '../../lib/labels';
import { cn } from '../../lib/utils';

// What the portfolio's strategies realized, from the deals the Master reports (Master 4.01+)
export default function PortfolioPerformance() {
    const { id } = useParams();
    const [days, setDays] = useState(90);
    const [name, setName] = useState<string | null>(null);
    const [data, setData] = useState<Performance | null>(null);
    const [followers, setFollowers] = useState<FollowerStats | null>(null);
    const [backtestView, setBacktestView] = useState<BacktestView | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        api.get<Portfolio[]>('/portfolios')
            .then(res => setName(res.data.find(p => String(p.id) === id)?.name ?? null))
            .catch(e => console.error(e));
    }, [id]);

    const changeDays = (value: number) => {
        setLoading(true);
        setDays(value);
    };

    useEffect(() => {
        let cancelled = false;
        api.get<Performance>(`/portfolios/${id}/performance`, { params: { days } })
            .then(res => { if (!cancelled) { setData(res.data); setFailed(false); } })
            .catch(e => { console.error(e); if (!cancelled) setFailed(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        api.get<FollowerStats>(`/portfolios/${id}/followers`, { params: { days } })
            .then(res => { if (!cancelled) setFollowers(res.data); })
            .catch(e => console.error(e));
        api.get<BacktestView>(`/portfolios/${id}/backtest`, { params: { days } })
            .then(res => { if (!cancelled) setBacktestView(res.data); })
            .catch(e => console.error(e));
        return () => { cancelled = true; };
    }, [id, days]);

    return (
        <div className="space-y-6">
            <Link to="/manager/portfolios" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" /> Portfólios
            </Link>
            <PageHeader
                title={name ? `Desempenho de ${name}` : 'Desempenho'}
                description="As operações fechadas das estratégias do portfólio, na conta do Master. Vem do EA Master 4.01 ou mais novo."
                icon={<TrendingUp />}
            />
            <div className="w-48">{/* The chevron sits at the wrapper's edge: the wrapper takes the width */}
                <Select value={days} onChange={e => changeDays(Number(e.target.value))} className="h-9" aria-label="Período">
                    {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
                </Select>
            </div>
            {data === null ? (
                <p className="text-sm text-muted-foreground">{failed ? 'Não foi possível carregar o desempenho.' : 'Carregando...'}</p>
            ) : (
                <div className={cn('transition-opacity', loading && 'opacity-60')}>
                    <PerformanceView
                        stats={data}
                        emptyTitle="Nenhuma operação fechada no período"
                        emptyDescription="O desempenho aparece quando as operações fecham na conta do Master, com o EA Master 4.01 ou mais novo."
                    />
                </div>
            )}
            {backtestView?.available && (
                <section className={cn('space-y-4 transition-opacity', loading && 'opacity-60')}>
                    <div>
                        <h2 className="text-xl font-semibold">Backtest do Dash e resultado ao vivo</h2>
                        <p className="text-sm text-muted-foreground">
                            Do portfólio vinculado ao Trademetric Dash. No marketplace, só aparece se o anúncio marcar "Mostrar o backtest do Trademetric Dash".
                        </p>
                    </div>
                    <BacktestSection view={backtestView} />
                </section>
            )}
            {followers && (
                <section className={cn('space-y-4 transition-opacity', loading && 'opacity-60')}>
                    <div>
                        <h2 className="text-xl font-semibold">Como os seguidores copiaram</h2>
                        <p className="text-sm text-muted-foreground">
                            O que as contas dos clientes conseguiram nas mesmas operações. No marketplace, só aparece a partir de um mínimo de seguidores.
                        </p>
                    </div>
                    <FollowerStatsView stats={followers} />
                </section>
            )}
        </div>
    );
}
