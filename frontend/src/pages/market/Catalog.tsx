import { useEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, Filter, Store } from 'lucide-react';
import api, { MARKETS, type PublicListing } from '../../api';
import Sparkline from '../../components/charts/Sparkline';
import EmptyState from '../../components/EmptyState';
import SlideRow from '../../components/SlideRow';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Faq, HowItWorks } from '../../components/market/HowItWorks';
import { useAuth } from '../../context/AuthContext';
import { riskOf } from '../../lib/risk';
import { IconSelect } from '../../components/ui/Field';
import { formatMoney, priceLabel } from '../../lib/money';
import { cn } from '../../lib/utils';

// From this many portfolios on screen, the catalog turns into one row per market
const SHELF_MIN = 8;
// The rows by asset that go last, in this order: what has no result per lot to compare yet
const NO_ASSET = 'Ativo não informado';
const NO_TRADES = 'Sem operações ainda';
const LAST = [NO_ASSET, NO_TRADES];

const SORTS = {
    // Return for each point of the biggest fall: the top is not the one that risked the most
    recommended: {
        label: 'Recomendados',
        key: (l: PublicListing) => (l.stats.return_pct == null ? Infinity : -(l.stats.return_pct / Math.max(l.stats.max_drawdown_pct ?? 0, 5))),
    },
    return: { label: 'Maior retorno', key: (l: PublicListing) => -(l.stats.return_pct ?? -Infinity) },
    drawdown: { label: 'Menor queda', key: (l: PublicListing) => l.stats.max_drawdown_pct ?? Infinity },
    perLot: { label: 'Maior lucro por lote', key: (l: PublicListing) => -(l.stats.per_lot ?? -Infinity) },
    trades: { label: 'Mais operações', key: (l: PublicListing) => -l.stats.trades },
    recent: { label: 'Mais recentes', key: (l: PublicListing) => -new Date(l.published_at ?? 0).getTime() },
} as const;
type Sort = keyof typeof SORTS;

const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

function ListingCard({ l, perLot = false }: { l: PublicListing; perLot?: boolean }) {
    const risk = riskOf(l.stats.max_drawdown_pct);
    return (
        <Link to={`/marketplace/${l.slug}`} className="panel group flex flex-col p-5 transition-colors hover:border-primary/40">
            <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                    {l.markets.map(m => <Badge key={m} variant="primary">{m}</Badge>)}
                </div>
                {l.stats.assets.length > 0 && (
                    <span className="truncate font-mono text-xs text-muted-foreground" title="Os ativos das cópias nos últimos 90 dias">
                        {l.stats.assets.join(' + ')}
                    </span>
                )}
            </div>
            <h3 className="mt-3 text-lg font-semibold leading-tight">{l.title}</h3>
            <p className="text-xs text-muted-foreground">por {l.manager.name}</p>
            {l.summary && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{l.summary}</p>}
            <div className="mb-4 mt-4 space-y-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                        <dt className="text-xs text-muted-foreground">Retorno 90 dias</dt>
                        <dd className={cn('text-lg font-semibold', (l.stats.return_pct ?? 0) > 0 && 'text-success', (l.stats.return_pct ?? 0) < 0 && 'text-destructive')}>
                            {pct(l.stats.return_pct)}
                        </dd>
                    </div>
                    <div title="O quanto a conta do gestor já caiu do topo nesse período">
                        <dt className="text-xs text-muted-foreground">Maior queda</dt>
                        <dd className="text-lg font-semibold">{l.stats.max_drawdown_pct == null ? '—' : pct(-l.stats.max_drawdown_pct)}</dd>
                    </div>
                    {perLot && (
                        <div title="O resultado médio de cada lote fechado: quanto maior, mais folga para slippage e custos" className="col-span-2">
                            <dt className="text-xs text-muted-foreground">Lucro por lote</dt>
                            <dd className={cn((l.stats.per_lot ?? 0) > 0 && 'text-success', (l.stats.per_lot ?? 0) < 0 && 'text-destructive')}>
                                {l.stats.per_lot == null ? '—' : formatMoney(l.stats.per_lot, l.stats.currency)}
                            </dd>
                        </div>
                    )}
                </dl>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {risk && <Badge variant={risk.variant} title={risk.hint}>Risco {risk.label.toLowerCase()}</Badge>}
                    <span>{l.stats.trades} operações</span>
                </div>
                <Sparkline values={l.stats.curve} label={`Resultado acumulado de ${l.title} em 90 dias`} height={56} />
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
                <p className="text-sm font-medium">{priceLabel(l)}</p>
                <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary group-hover:underline">
                    Ver e copiar <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
            </div>
        </Link>
    );
}

// A filter as a quiet pill beside the title: the icon says what it does, the native picker opens over it,
// and it takes the primary color while it narrows the list
function PillSelect({ icon, label, active, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { icon: ReactNode; label: string; active?: boolean }) {
    return (
        <label
            title={label}
            className={cn(
                'relative flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border bg-card pl-3.5 pr-8 text-sm font-medium text-foreground shadow-sm transition-colors hover:border-primary/40 focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
                active && 'border-primary/50 bg-primary/5 text-primary [&>svg]:text-primary',
            )}
        >
            {icon}
            <select aria-label={label} className="cursor-pointer appearance-none bg-transparent pr-0.5 outline-none [field-sizing:content]" {...props}>
                {children}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3" />
        </label>
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
    const [sort, setSort] = useState<Sort>('recommended');
    const { user } = useAuth();

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
    const byMarket = MARKETS.map(m => ({ title: m as string, items: shown.filter(l => l.markets.includes(m)) })).filter(s => s.items.length > 0);
    // The result per lot only compares within an asset (a lot of WIN is not one of WDO): sorted by it, one row per
    // main asset, at any count. A portfolio goes in the row of the asset it traded the most lots of
    const assetRows = new Map<string, PublicListing[]>();
    for (const l of shown) {
        const title = l.stats.per_lot == null ? NO_TRADES : l.stats.assets[0] ?? NO_ASSET;
        assetRows.set(title, [...(assetRows.get(title) ?? []), l]);
    }
    const byAsset = [...assetRows].map(([title, items]) => ({ title, items }))
        .sort((a, b) => LAST.indexOf(a.title) - LAST.indexOf(b.title) || b.items.length - a.items.length || a.title.localeCompare(b.title));
    const shelves = sort === 'perLot'
        ? (byAsset.length > 1 ? byAsset : [])
        : !market && shown.length >= SHELF_MIN && byMarket.length > 1 ? byMarket : [];

    return (
        <div className="space-y-6 sm:space-y-8">
            {!user && <HowItWorks />}
            <div id="gestores" className="flex scroll-mt-24 items-center justify-between gap-3">
                {user
                    ? <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Gestores para copiar</h1>
                    : <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Gestores para copiar</h2>}
                <div className="flex shrink-0 gap-2 sm:hidden">
                    <IconSelect icon={<Filter />} label="Mercado" active={!!market} value={market} onChange={e => setMarket(e.target.value)}>
                        <option value="">Todos os mercados</option>
                        {MARKETS.map(m => <option key={m} value={m}>{m}</option>)}
                    </IconSelect>
                    <IconSelect icon={<ArrowUpDown />} label="Ordenar" value={sort} onChange={e => setSort(e.target.value as Sort)}>
                        {(Object.keys(SORTS) as Sort[]).map(s => <option key={s} value={s}>{SORTS[s].label}</option>)}
                    </IconSelect>
                </div>
                <div className="hidden shrink-0 gap-2 sm:flex">
                    <PillSelect icon={<Filter />} label="Mercado" active={!!market} value={market} onChange={e => setMarket(e.target.value)}>
                        <option value="">Todos os mercados</option>
                        {MARKETS.map(m => <option key={m} value={m}>{m}</option>)}
                    </PillSelect>
                    <PillSelect icon={<ArrowUpDown />} label="Ordenar" value={sort} onChange={e => setSort(e.target.value as Sort)}>
                        {(Object.keys(SORTS) as Sort[]).map(s => <option key={s} value={s}>{SORTS[s].label}</option>)}
                    </PillSelect>
                </div>
            </div>

            {sort === 'perLot' && (
                <p className="-mt-3 text-xs text-muted-foreground sm:-mt-5">
                    Lucro por lote comparado dentro de cada ativo: um lote de WIN não tem o tamanho de um de WDO, nem de um de EURUSD.
                </p>
            )}

            {listings === null ? (
                <p className="text-sm text-muted-foreground">{failed ? 'Não foi possível carregar o marketplace.' : 'Carregando...'}</p>
            ) : shown.length === 0 ? (
                <div className="panel">
                    <EmptyState icon={<Store />} title="Nenhum portfólio aqui ainda" description="Volte em breve: novos gestores publicam portfólios com frequência." />
                </div>
            ) : shelves.length > 1 ? (
                <div className="space-y-8">
                    {shelves.map(shelf => (
                        <Shelf key={shelf.title} title={shelf.title} count={shelf.items.length}>
                            {shelf.items.map(l => <ListingCard key={l.slug} l={l} perLot={sort === 'perLot'} />)}
                        </Shelf>
                    ))}
                </div>
            ) : (
                // A few portfolios: they slide on phones, a grid from md up
                <SlideRow wide className="md:grid-cols-2 md:gap-4 lg:grid-cols-3 xl:grid-cols-4">
                    {shown.map(l => <ListingCard key={l.slug} l={l} perLot={sort === 'perLot'} />)}
                </SlideRow>
            )}

            {!user && <Faq />}
        </div>
    );
}
