
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { Briefcase, Check, Link as LinkIcon, Plus, TrendingUp, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import api, { type License, type MasterAccount, type Portfolio, type Strategy } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import DashLinkPanel from '../../components/DashLinkPanel';
import PageHeader from '../../components/PageHeader';
import PortfolioLimits from '../../components/PortfolioLimits';
import PortfolioOrigin from '../../components/PortfolioOrigin';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { apiError, licenseIsValid } from '../../lib/utils';

type PortfolioForm = { name: string };
type LinkForm = { portfolio_id: string; strategy_id: string };

export default function Portfolios() {
    const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
    const [strategies, setStrategies] = useState<Strategy[]>([]);
    const [licenses, setLicenses] = useState<License[]>([]);
    const [accounts, setAccounts] = useState<MasterAccount[]>([]);
    const [loading, setLoading] = useState(true);
    // "<portfolio_id>:<strategy_id>" of the link waiting for confirmation / being removed
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);
    const portfolioForm = useForm<PortfolioForm>();
    const linkForm = useForm<LinkForm>();

    const refresh = async () => {
        try {
            const [p, s, l, a] = await Promise.all([
                api.get<Portfolio[]>('/portfolios'),
                api.get<Strategy[]>('/strategies'),
                api.get<License[]>('/licenses'),
                api.get<MasterAccount[]>('/me/master-accounts'),
            ]);
            setPortfolios(p.data);
            setStrategies(s.data);
            setLicenses(l.data);
            setAccounts(a.data);
        } catch (e) {
            console.error(e);
            toast.error('Não foi possível carregar os portfólios.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { refresh(); }, []);

    const onCreatePortfolio = async (data: PortfolioForm) => {
        try {
            await api.post('/portfolios', data);
            portfolioForm.reset();
            toast.success(`Portfólio "${data.name}" criado`);
            refresh();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível criar o portfólio.'));
        }
    };

    const onLink = async (data: LinkForm) => {
        try {
            await api.post(`/portfolios/${data.portfolio_id}/add_strategy/${data.strategy_id}`);
            linkForm.reset();
            toast.success('Estratégia vinculada ao portfólio');
            refresh();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível vincular a estratégia.'));
        }
    };

    // The API refuses while the strategy has open positions: removing it would close the clients' copies
    const onRemove = async (portfolio: Portfolio, strategy: Portfolio['strategies'][number]) => {
        setRemoving(`${portfolio.id}:${strategy.id}`);
        try {
            await api.delete(`/portfolios/${portfolio.id}/strategies/${strategy.id}`);
            toast.success(`${strategy.name} removida de ${portfolio.name}`);
            refresh();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível remover a estratégia.'));
        } finally {
            setRemoving(null);
            setConfirmRemove(null);
        }
    };

    // Strategies the chosen portfolio already has can't be linked twice
    const selectedPortfolio = portfolios.find(p => String(p.id) === linkForm.watch('portfolio_id'));
    const linkedIds = new Set<number>(selectedPortfolio?.strategies.map(s => s.id) ?? []);
    const canLink = portfolios.length > 0 && strategies.length > 0;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Portfólios"
                description="Agrupe estratégias em portfólios que seus clientes podem copiar."
                icon={<Briefcase />}
            />

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
                <div className="space-y-6">
                    <Card title="Novo portfólio" icon={<Plus />}>
                        <form onSubmit={portfolioForm.handleSubmit(onCreatePortfolio)} className="space-y-4" noValidate>
                            <Field label="Nome" htmlFor="portfolio-name" error={portfolioForm.formState.errors.name?.message}>
                                <Input
                                    {...portfolioForm.register('name', { required: 'Informe um nome' })}
                                    id="portfolio-name"
                                    placeholder="Ex.: Carteira Conservadora"
                                />
                            </Field>
                            <Button className="w-full" loading={portfolioForm.formState.isSubmitting}>
                                {!portfolioForm.formState.isSubmitting && <Plus />} Criar portfólio
                            </Button>
                        </form>
                    </Card>

                    <Card
                        title="Vincular estratégia"
                        description="Os sinais da estratégia passam a ser enviados a quem copia o portfólio."
                        icon={<LinkIcon />}
                    >
                        <form onSubmit={linkForm.handleSubmit(onLink)} className="space-y-4" noValidate>
                            <Field label="Portfólio" htmlFor="link-portfolio" error={linkForm.formState.errors.portfolio_id?.message}>
                                <Select
                                    {...linkForm.register('portfolio_id', { required: 'Selecione um portfólio' })}
                                    id="link-portfolio"
                                    disabled={!canLink}
                                >
                                    <option value="">Selecione...</option>
                                    {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </Select>
                            </Field>
                            <Field label="Estratégia" htmlFor="link-strategy" error={linkForm.formState.errors.strategy_id?.message}>
                                <Select
                                    {...linkForm.register('strategy_id', { required: 'Selecione uma estratégia' })}
                                    id="link-strategy"
                                    disabled={!canLink}
                                >
                                    <option value="">Selecione...</option>
                                    {strategies.map(s => (
                                        <option key={s.id} value={s.id} disabled={linkedIds.has(s.id)}>
                                            {s.name} (#{s.magic_number}){linkedIds.has(s.id) ? ' — já vinculada' : ''}
                                        </option>
                                    ))}
                                </Select>
                            </Field>
                            <Button variant="secondary" className="w-full" disabled={!canLink} loading={linkForm.formState.isSubmitting}>
                                {!linkForm.formState.isSubmitting && <LinkIcon />} Vincular
                            </Button>
                            {!loading && !canLink && (
                                <p className="text-xs text-muted-foreground">
                                    Crie ao menos um portfólio e uma estratégia para fazer o vínculo.
                                </p>
                            )}
                        </form>
                    </Card>
                </div>

                <div className="space-y-4 lg:col-span-2">
                    {loading ? (
                        <p className="text-sm text-muted-foreground">Carregando...</p>
                    ) : portfolios.length === 0 ? (
                        <div className="panel">
                            <EmptyState
                                icon={<Briefcase />}
                                title="Nenhum portfólio criado"
                                description="Crie um portfólio e vincule estratégias para que seus clientes possam copiá-lo."
                            />
                        </div>
                    ) : portfolios.map(p => {
                        const activeClients = licenses.filter(l => l.portfolio_id === p.id && licenseIsValid(l)).length;
                        return (
                            <Card key={p.id} className="transition-colors hover:border-primary/30">
                                <div className="flex items-start justify-between gap-4">
                                    <h3 className="text-lg font-semibold">{p.name}</h3>
                                    <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                                        <span>{p.strategies.length} {p.strategies.length === 1 ? 'estratégia' : 'estratégias'}</span>
                                        <Link
                                            to={`/manager/portfolios/${p.id}/performance`}
                                            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                                        >
                                            <TrendingUp className="size-3.5" /> Desempenho
                                        </Link>
                                        <Link
                                            to={`/manager/clients?portfolio=${p.id}`}
                                            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                                        >
                                            <Users className="size-3.5" />
                                            {activeClients} {activeClients === 1 ? 'cliente ativo' : 'clientes ativos'}
                                        </Link>
                                    </div>
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2">
                                    {p.strategies.length > 0 ? p.strategies.map(s => {
                                        const key = `${p.id}:${s.id}`;
                                        return confirmRemove === key ? (
                                            <Badge key={s.id} variant="destructive" className="font-medium">
                                                Remover {s.name}?
                                                <button
                                                    onClick={() => onRemove(p, s)}
                                                    disabled={removing === key}
                                                    aria-label={`Confirmar remoção de ${s.name}`}
                                                    className="rounded-full p-0.5 transition-colors hover:bg-destructive/20 disabled:opacity-50"
                                                >
                                                    <Check className="size-3" />
                                                </button>
                                                <button
                                                    onClick={() => setConfirmRemove(null)}
                                                    disabled={removing === key}
                                                    aria-label="Cancelar remoção"
                                                    className="-mr-1 rounded-full p-0.5 transition-colors hover:bg-destructive/20 disabled:opacity-50"
                                                >
                                                    <X className="size-3" />
                                                </button>
                                            </Badge>
                                        ) : (
                                            <Badge key={s.id} variant="primary" className="font-medium">
                                                {s.name} <span className="font-mono opacity-70">#{s.magic_number}</span>
                                                <button
                                                    onClick={() => setConfirmRemove(key)}
                                                    title="Remover do portfólio"
                                                    aria-label={`Remover ${s.name} de ${p.name}`}
                                                    className="-mr-1 rounded-full p-0.5 opacity-60 transition hover:bg-primary/20 hover:opacity-100"
                                                >
                                                    <X className="size-3" />
                                                </button>
                                            </Badge>
                                        );
                                    }) : (
                                        <p className="text-sm text-muted-foreground">
                                            Nenhuma estratégia vinculada: os clientes deste portfólio ainda não recebem sinais.
                                        </p>
                                    )}
                                </div>

                                <PortfolioLimits
                                    portfolio={p}
                                    onSaved={limits => setPortfolios(current => current.map(x => (x.id === p.id ? { ...x, client_limits: limits } : x)))}
                                />
                                <PortfolioOrigin
                                    portfolio={p}
                                    accounts={accounts}
                                    onSaved={origin => setPortfolios(current => current.map(x => (x.id === p.id ? { ...x, ...origin } : x)))}
                                />
                                <DashLinkPanel portfolioId={p.id} portfolioName={p.name} />
                            </Card>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
