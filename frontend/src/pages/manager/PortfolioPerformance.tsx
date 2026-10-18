import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, TrendingUp } from 'lucide-react';
import api, { type Portfolio, type PortfolioPerformance as Performance } from '../../api';
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
            <Select value={days} onChange={e => changeDays(Number(e.target.value))} className="h-9 w-48" aria-label="Período">
                {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
            </Select>
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
        </div>
    );
}
