
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Search, ShieldCheck, Users } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import { apiError, formatDate } from '../../lib/utils';

type LicenseForm = { portfolio_id: string; client_mt5_login: string; max_lots: string };

export default function Clients() {
    const [licenses, setLicenses] = useState<any[]>([]);
    const [portfolios, setPortfolios] = useState<any[]>([]);
    const [strategies, setStrategies] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('');
    const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<LicenseForm>({
        defaultValues: { max_lots: '1.00' },
    });

    const refresh = async () => {
        try {
            const [l, p, s] = await Promise.all([api.get('/licenses'), api.get('/portfolios'), api.get('/strategies')]);
            setLicenses(l.data);
            setPortfolios(p.data);
            setStrategies(s.data);
        } catch (e) {
            console.error(e);
            toast.error('Não foi possível carregar os clientes.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { refresh(); }, []);

    const onCreateLicense = async (data: LicenseForm) => {
        try {
            await api.post('/licenses', {
                portfolio_id: parseInt(data.portfolio_id),
                client_mt5_login: parseInt(data.client_mt5_login),
                max_lots: parseFloat(data.max_lots),
            });
            reset();
            toast.success(`Conta ${data.client_mt5_login} autorizada`);
            refresh();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível autorizar a conta.'));
        }
    };

    // A license grants either a whole portfolio or (older ones) a single strategy
    const accessOf = (l: any) => {
        if (l.portfolio_id != null) {
            return { kind: 'Portfólio', name: portfolios.find(p => p.id === l.portfolio_id)?.name ?? `#${l.portfolio_id}` };
        }
        return { kind: 'Estratégia', name: strategies.find(s => s.id === l.strategy_id)?.name ?? `#${l.strategy_id}` };
    };

    const query = filter.trim().toLowerCase();
    const filteredLicenses = licenses.filter(l =>
        String(l.client_mt5_login).includes(query) || accessOf(l).name.toLowerCase().includes(query),
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title="Clientes"
                description="Autorize contas MT5 a copiar seus portfólios e defina o limite de cada uma."
                icon={<Users />}
            />

            <Card
                title="Nova autorização"
                description="A conta só recebe sinais depois de autorizada aqui."
                icon={<ShieldCheck />}
            >
                <form onSubmit={handleSubmit(onCreateLicense)} className="grid grid-cols-1 items-start gap-4 md:grid-cols-4" noValidate>
                    <Field label="Portfólio" htmlFor="license-portfolio" error={errors.portfolio_id?.message}>
                        <Select
                            {...register('portfolio_id', { required: 'Selecione um portfólio' })}
                            id="license-portfolio"
                            disabled={portfolios.length === 0}
                        >
                            <option value="">{portfolios.length === 0 && !loading ? 'Crie um portfólio primeiro' : 'Selecione...'}</option>
                            {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                    </Field>
                    <Field label="Login MT5" htmlFor="license-login" error={errors.client_mt5_login?.message}>
                        <Input
                            {...register('client_mt5_login', {
                                required: 'Informe o login',
                                pattern: { value: /^\d+$/, message: 'Use apenas dígitos' },
                            })}
                            id="license-login"
                            inputMode="numeric"
                            className="font-mono"
                            placeholder="Ex.: 5002441"
                        />
                    </Field>
                    <Field label="Limite de lotes" htmlFor="license-lots" error={errors.max_lots?.message}>
                        <Input
                            {...register('max_lots', {
                                required: 'Informe o limite',
                                validate: v => parseFloat(v) > 0 || 'Deve ser maior que zero',
                            })}
                            id="license-lots"
                            type="number"
                            step="0.01"
                            min="0.01"
                            className="font-mono"
                            placeholder="1.00"
                        />
                    </Field>
                    <Button className="md:mt-[1.375rem]" loading={isSubmitting} disabled={portfolios.length === 0}>
                        {!isSubmitting && <ShieldCheck />} Autorizar conta
                    </Button>
                </form>
            </Card>

            <Card
                title="Contas autorizadas"
                description={loading ? undefined : `${licenses.length} ${licenses.length === 1 ? 'conta' : 'contas'}`}
                icon={<Users />}
                action={
                    <div className="w-full max-w-xs">
                        <Input
                            value={filter}
                            onChange={e => setFilter(e.target.value)}
                            icon={<Search />}
                            className="h-9"
                            placeholder="Buscar por login ou portfólio"
                            aria-label="Buscar por login ou portfólio"
                        />
                    </div>
                }
                flush
            >
                {loading ? (
                    <p className="px-5 pb-5 text-sm text-muted-foreground">Carregando...</p>
                ) : licenses.length === 0 ? (
                    <EmptyState
                        icon={<Users />}
                        title="Nenhuma conta autorizada"
                        description="Autorize o login MT5 de um cliente para que ele comece a copiar um portfólio."
                    />
                ) : filteredLicenses.length === 0 ? (
                    <EmptyState icon={<Search />} title="Nenhum resultado" description={`Nada encontrado para "${filter}".`} />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Login MT5</TableHead>
                                <TableHead>Acesso</TableHead>
                                <TableHead className="text-right">Limite de lotes</TableHead>
                                <TableHead>Autorizada em</TableHead>
                                <TableHead className="text-right">Status</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredLicenses.map(l => {
                                const access = accessOf(l);
                                return (
                                    <TableRow key={l.id}>
                                        <TableCell className="font-mono font-semibold">{l.client_mt5_login}</TableCell>
                                        <TableCell>
                                            <span className="text-muted-foreground">{access.kind}</span> {access.name}
                                        </TableCell>
                                        <TableCell className="text-right font-mono tabular-nums">{Number(l.max_lots).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</TableCell>
                                        <TableCell className="text-muted-foreground">{formatDate(l.created_at)}</TableCell>
                                        <TableCell className="text-right">
                                            <Badge variant={l.is_active ? 'success' : 'muted'}>{l.is_active ? 'Ativa' : 'Inativa'}</Badge>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
            </Card>
        </div>
    );
}
