
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Briefcase, Link as LinkIcon, Plus } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../api';
import Card from '../../components/Card';
import CopyField from '../../components/CopyField';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { apiError } from '../../lib/utils';

type PortfolioForm = { name: string };
type LinkForm = { portfolio_id: string; strategy_id: string };

export default function Portfolios() {
    const [portfolios, setPortfolios] = useState<any[]>([]);
    const [strategies, setStrategies] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const portfolioForm = useForm<PortfolioForm>();
    const linkForm = useForm<LinkForm>();

    const refresh = async () => {
        try {
            const [p, s] = await Promise.all([api.get('/portfolios'), api.get('/strategies')]);
            setPortfolios(p.data);
            setStrategies(s.data);
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

    // Strategies the chosen portfolio already has can't be linked twice
    const selectedPortfolio = portfolios.find(p => String(p.id) === linkForm.watch('portfolio_id'));
    const linkedIds = new Set<number>(selectedPortfolio?.strategies.map((s: any) => s.id) ?? []);
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
                                description="Crie um portfólio e vincule estratégias para liberar a chave de conexão dos clientes."
                            />
                        </div>
                    ) : portfolios.map(p => (
                        <Card key={p.id} className="transition-colors hover:border-primary/30">
                            <div className="flex items-start justify-between gap-4">
                                <h3 className="text-lg font-semibold">{p.name}</h3>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {p.strategies.length} {p.strategies.length === 1 ? 'estratégia' : 'estratégias'}
                                </span>
                            </div>

                            <div className="mt-3 flex flex-wrap gap-2">
                                {p.strategies.length > 0 ? p.strategies.map((s: any) => (
                                    <Badge key={s.id} variant="primary" className="font-medium">
                                        {s.name} <span className="font-mono opacity-70">#{s.magic_number}</span>
                                    </Badge>
                                )) : (
                                    <p className="text-sm text-muted-foreground">
                                        Nenhuma estratégia vinculada: os clientes deste portfólio ainda não recebem sinais.
                                    </p>
                                )}
                            </div>

                            <div className="mt-5 border-t border-border pt-4">
                                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                    Chave de conexão dos clientes
                                </p>
                                <CopyField value={p.public_key} label="Chave de conexão" />
                            </div>
                        </Card>
                    ))}
                </div>
            </div>
        </div>
    );
}
