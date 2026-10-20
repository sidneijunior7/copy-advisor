import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpDown, Filter, Store } from 'lucide-react';
import api, { MARKETS, type PublicListing } from '../../api';
import Sparkline from '../../components/charts/Sparkline';
import EmptyState from '../../components/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { IconSelect, Select } from '../../components/ui/Field';
import { priceLabel } from '../../lib/money';
import { cn } from '../../lib/utils';

const SORTS = {
    return: { label: 'Maior retorno', key: (l: PublicListing) => -(l.stats.return_pct ?? -Infinity) },
    drawdown: { label: 'Menor queda', key: (l: PublicListing) => l.stats.max_drawdown_pct ?? Infinity },
    trades: { label: 'Mais operações', key: (l: PublicListing) => -l.stats.trades },
    recent: { label: 'Mais recentes', key: (l: PublicListing) => -new Date(l.published_at ?? 0).getTime() },
} as const;
type Sort = keyof typeof SORTS;

const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

export default function Catalog() {
    const [listings, setListings] = useState<PublicListing[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [market, setMarket] = useState('');
    const [sort, setSort] = useState<Sort>('return');

    useEffect(() => {
        api.get<PublicListing[]>('/api/marketplace')
            .then(res => setListings(res.data))
            .catch(e => { console.error(e); setFailed(true); });
    }, []);

    const shown = (listings ?? [])
        .filter(l => !market || l.markets.includes(market as PublicListing['markets'][number]))
        .sort((a, b) => SORTS[sort].key(a) - SORTS[sort].key(b));

    return (
        <div className="space-y-6 sm:space-y-8">
            <div className="space-y-2">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Estratégias para copiar</h1>
                <p className="max-w-2xl text-muted-foreground">
                    Portfólios de gestores com o desempenho real das contas que operam, atualizado a cada operação fechada.
                    Assine, informe sua conta MetaTrader 5 e copie com o EA no seu computador ou hospedado com a gente.
                </p>
            </div>

            <div className="flex items-center justify-between gap-3 sm:hidden">
                <p className="min-w-0 truncate text-sm text-muted-foreground">
                    {market || 'Todos os mercados'} · {SORTS[sort].label}
                </p>
                <div className="flex gap-2">
                    <IconSelect icon={<Filter />} label="Mercado" active={!!market} value={market} onChange={e => setMarket(e.target.value)}>
                        <option value="">Todos os mercados</option>
                        {MARKETS.map(m => <option key={m} value={m}>{m}</option>)}
                    </IconSelect>
                    <IconSelect icon={<ArrowUpDown />} label="Ordenar" value={sort} onChange={e => setSort(e.target.value as Sort)}>
                        {(Object.keys(SORTS) as Sort[]).map(s => <option key={s} value={s}>{SORTS[s].label}</option>)}
                    </IconSelect>
                </div>
            </div>
            <div className="hidden flex-wrap gap-2 sm:flex">
                <Select value={market} onChange={e => setMarket(e.target.value)} className="h-9 w-52" aria-label="Mercado">
                    <option value="">Todos os mercados</option>
                    {MARKETS.map(m => <option key={m} value={m}>{m}</option>)}
                </Select>
                <Select value={sort} onChange={e => setSort(e.target.value as Sort)} className="h-9 w-44" aria-label="Ordenar">
                    {(Object.keys(SORTS) as Sort[]).map(s => <option key={s} value={s}>{SORTS[s].label}</option>)}
                </Select>
            </div>

            {listings === null ? (
                <p className="text-sm text-muted-foreground">{failed ? 'Não foi possível carregar o marketplace.' : 'Carregando...'}</p>
            ) : shown.length === 0 ? (
                <div className="panel">
                    <EmptyState icon={<Store />} title="Nenhum portfólio aqui ainda" description="Volte em breve: novos gestores publicam portfólios com frequência." />
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {shown.map(l => (
                        <Link key={l.slug} to={`/marketplace/${l.slug}`} className="panel group flex flex-col p-5 transition-colors hover:border-primary/40">
                            <div className="flex flex-wrap gap-1">
                                {l.markets.map(m => <Badge key={m} variant="primary">{m}</Badge>)}
                            </div>
                            <h2 className="mt-3 text-lg font-semibold leading-tight">{l.title}</h2>
                            <p className="text-xs text-muted-foreground">por {l.manager.name}</p>
                            {l.summary && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{l.summary}</p>}
                            <div className="mt-4 flex items-end justify-between gap-3">
                                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Retorno 90 dias</dt>
                                        <dd className={cn('font-semibold', (l.stats.return_pct ?? 0) > 0 && 'text-success', (l.stats.return_pct ?? 0) < 0 && 'text-destructive')}>
                                            {pct(l.stats.return_pct)}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Maior queda</dt>
                                        <dd className="font-semibold">{l.stats.max_drawdown_pct == null ? '—' : pct(-l.stats.max_drawdown_pct)}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Acerto</dt>
                                        <dd>{l.stats.win_rate == null ? '—' : `${l.stats.win_rate.toLocaleString('pt-BR')}%`}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-muted-foreground">Operações</dt>
                                        <dd>{l.stats.trades}</dd>
                                    </div>
                                </dl>
                                <Sparkline values={l.stats.curve} label={`Resultado acumulado de ${l.title} em 90 dias`} width={110} height={44} />
                            </div>
                            <p className="mt-4 border-t border-border pt-3 text-sm font-medium">{priceLabel(l)}</p>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}
