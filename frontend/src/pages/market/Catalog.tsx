import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpDown, ChevronLeft, ChevronRight, Filter, Store } from 'lucide-react';
import api, { MARKETS, type PublicListing } from '../../api';
import Sparkline from '../../components/charts/Sparkline';
import EmptyState from '../../components/EmptyState';
import SlideRow from '../../components/SlideRow';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { IconSelect, Select } from '../../components/ui/Field';
import { priceLabel } from '../../lib/money';
import { cn } from '../../lib/utils';

// From this many portfolios on screen, the catalog turns into one row per market
const SHELF_MIN = 8;

const SORTS = {
    return: { label: 'Maior retorno', key: (l: PublicListing) => -(l.stats.return_pct ?? -Infinity) },
    drawdown: { label: 'Menor queda', key: (l: PublicListing) => l.stats.max_drawdown_pct ?? Infinity },
    trades: { label: 'Mais operações', key: (l: PublicListing) => -l.stats.trades },
    recent: { label: 'Mais recentes', key: (l: PublicListing) => -new Date(l.published_at ?? 0).getTime() },
} as const;
type Sort = keyof typeof SORTS;

const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

function ListingCard({ l }: { l: PublicListing }) {
    return (
        <Link to={`/marketplace/${l.slug}`} className="panel group flex flex-col p-5 transition-colors hover:border-primary/40">
            <div className="flex flex-wrap gap-1">
                {l.markets.map(m => <Badge key={m} variant="primary">{m}</Badge>)}
            </div>
            <h3 className="mt-3 text-lg font-semibold leading-tight">{l.title}</h3>
            <p className="text-xs text-muted-foreground">por {l.manager.name}</p>
            {l.summary && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{l.summary}</p>}
            <div className="mb-4 mt-4 space-y-3">
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
                <Sparkline values={l.stats.curve} label={`Resultado acumulado de ${l.title} em 90 dias`} height={56} />
            </div>
            <p className="mt-auto border-t border-border pt-3 text-sm font-medium">{priceLabel(l)}</p>
        </Link>
    );
}

// A row of one market that slides sideways at any width; arrows from md up, where not everyone swipes
function Shelf({ title, count, children }: { title: string; count: number; children: ReactNode }) {
    const row = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ start: true, end: false });
    const update = () => {
        const el = row.current;
        if (el) setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
    };
    // Again when the width changes: a rotated phone or a resized window shows more or fewer cards
    useEffect(() => {
        const el = row.current;
        if (!el) return;
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, [count]);
    const scroll = (direction: number) => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.9, behavior: 'smooth' });
    return (
        <section className="space-y-3" aria-label={title}>
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">
                    {title} <span className="text-sm font-normal text-muted-foreground">{count}</span>
                </h2>
                <div className="hidden gap-1 md:flex">
                    <Button type="button" size="icon" variant="outline" disabled={edges.start} onClick={() => scroll(-1)} aria-label={`Voltar em ${title}`}>
                        <ChevronLeft />
                    </Button>
                    <Button type="button" size="icon" variant="outline" disabled={edges.end} onClick={() => scroll(1)} aria-label={`Avançar em ${title}`}>
                        <ChevronRight />
                    </Button>
                </div>
            </div>
            <div
                ref={row}
                onScroll={update}
                className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 py-1 scrollbar-none [&>*]:shrink-0 [&>*]:snap-start [&>*]:w-[85%] sm:[&>*]:w-[45%] md:[&>*]:w-[31%] xl:[&>*]:w-[23.5%]"
            >
                {children}
            </div>
        </section>
    );
}

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
    // Enough portfolios, in more than one market: one row per market, as in a streaming catalog. A portfolio
    // in two markets shows in both. Filtering a market goes back to the plain list
    const byMarket = MARKETS.map(m => ({ market: m, items: shown.filter(l => l.markets.includes(m)) })).filter(s => s.items.length > 0);
    const shelves = !market && shown.length >= SHELF_MIN && byMarket.length > 1 ? byMarket : [];

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
            ) : shelves.length > 1 ? (
                <div className="space-y-8">
                    {shelves.map(shelf => (
                        <Shelf key={shelf.market} title={shelf.market} count={shelf.items.length}>
                            {shelf.items.map(l => <ListingCard key={l.slug} l={l} />)}
                        </Shelf>
                    ))}
                </div>
            ) : (
                // A few portfolios: they slide on phones, a grid from md up
                <SlideRow wide className="md:grid-cols-2 md:gap-4 lg:grid-cols-3 xl:grid-cols-4">
                    {shown.map(l => <ListingCard key={l.slug} l={l} />)}
                </SlideRow>
            )}
        </div>
    );
}
