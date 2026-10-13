
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router-dom';
import { Ban, Check, Pencil, RotateCcw, Search, ShieldCheck, Users, X } from 'lucide-react';
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
type LicenseChanges = { max_lots?: number; is_active?: boolean };

const formatLots = (value: number) => Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// The Slave EA rechecks its license hourly
const EA_DELAY = 'O EA aplica a mudança em até 1 hora.';

export default function Clients() {
    const [licenses, setLicenses] = useState<any[]>([]);
    const [portfolios, setPortfolios] = useState<any[]>([]);
    const [strategies, setStrategies] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('');
    // Portfolio filter lives in the URL so the Portfolios page can link to its clients
    const [searchParams, setSearchParams] = useSearchParams();
    const portfolioFilter = searchParams.get('portfolio') ?? '';
    const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
    const [confirmRevoke, setConfirmRevoke] = useState<number | null>(null);
    const [busy, setBusy] = useState<number | null>(null);
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

    const updateLicense = async (l: any, changes: LicenseChanges, message: string, detail: string) => {
        setBusy(l.id);
        try {
            const res = await api.patch(`/licenses/${l.id}`, changes);
            setLicenses(current => current.map(x => (x.id === l.id ? res.data : x)));
            toast.success(message, { description: detail });
            return true;
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível alterar a licença.'));
            return false;
        } finally {
            setBusy(null);
        }
    };

    const saveLimit = async (l: any) => {
        const value = parseFloat(editing?.value ?? '');
        if (!(value > 0)) {
            toast.error('O limite deve ser maior que zero.');
            return;
        }
        if (await updateLicense(l, { max_lots: value }, `Conta ${l.client_mt5_login}: limite de ${formatLots(value)} lotes`, EA_DELAY)) {
            setEditing(null);
        }
    };

    const revoke = async (l: any) => {
        await updateLicense(l, { is_active: false }, `Conta ${l.client_mt5_login} revogada`,
            'Em até 1 hora o EA para de abrir posições. As que estiverem abertas seguem até fecharem no master.');
        setConfirmRevoke(null);
    };

    const reactivate = (l: any) =>
        updateLicense(l, { is_active: true }, `Conta ${l.client_mt5_login} reativada`, EA_DELAY);

    const startEditing = (l: any) => {
        setConfirmRevoke(null);
        setEditing({ id: l.id, value: String(l.max_lots) });
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
        (!portfolioFilter || String(l.portfolio_id) === portfolioFilter) &&
        (String(l.client_mt5_login).includes(query) || accessOf(l).name.toLowerCase().includes(query)),
    );
    const activeCount = licenses.filter(l => l.is_active).length;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Clientes"
                description="Autorize contas MT5 a copiar seus portfólios e defina o limite de cada uma. Alterações chegam ao EA em até 1 hora."
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
                description={loading ? undefined : `${licenses.length} ${licenses.length === 1 ? 'conta' : 'contas'}, ${activeCount} ${activeCount === 1 ? 'ativa' : 'ativas'}`}
                icon={<Users />}
                action={
                    <div className="flex w-full max-w-lg flex-col gap-2 sm:flex-row">
                        <Select
                            value={portfolioFilter}
                            onChange={e => setSearchParams(e.target.value ? { portfolio: e.target.value } : {}, { replace: true })}
                            className="h-9 sm:w-48"
                            aria-label="Filtrar por portfólio"
                        >
                            <option value="">Todos os portfólios</option>
                            {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                        <div className="flex-1">
                            <Input
                                value={filter}
                                onChange={e => setFilter(e.target.value)}
                                icon={<Search />}
                                className="h-9"
                                placeholder="Buscar por login ou portfólio"
                                aria-label="Buscar por login ou portfólio"
                            />
                        </div>
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
                    <EmptyState
                        icon={<Search />}
                        title="Nenhum resultado"
                        description={filter ? `Nada encontrado para "${filter}".` : 'Nenhuma conta autorizada neste portfólio.'}
                    />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Login MT5</TableHead>
                                <TableHead>Acesso</TableHead>
                                <TableHead className="text-right">Limite de lotes</TableHead>
                                <TableHead>Autorizada em</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="text-right">Ações</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredLicenses.map(l => {
                                const access = accessOf(l);
                                const isBusy = busy === l.id;
                                return (
                                    <TableRow key={l.id}>
                                        <TableCell className="font-mono font-semibold">{l.client_mt5_login}</TableCell>
                                        <TableCell>
                                            <span className="text-muted-foreground">{access.kind}</span> {access.name}
                                        </TableCell>
                                        <TableCell className="text-right font-mono tabular-nums">
                                            {editing && editing.id === l.id ? (
                                                <form
                                                    onSubmit={e => { e.preventDefault(); saveLimit(l); }}
                                                    className="flex items-center justify-end gap-1"
                                                >
                                                    <Input
                                                        autoFocus
                                                        type="number"
                                                        step="0.01"
                                                        min="0.01"
                                                        value={editing.value}
                                                        onChange={e => setEditing({ id: l.id, value: e.target.value })}
                                                        onKeyDown={e => { if (e.key === 'Escape') setEditing(null); }}
                                                        className="h-8 w-24 text-right font-mono"
                                                        aria-label={`Limite de lotes da conta ${l.client_mt5_login}`}
                                                    />
                                                    <Button size="icon" variant="ghost" className="size-8" loading={isBusy} aria-label="Salvar limite">
                                                        {!isBusy && <Check />}
                                                    </Button>
                                                    <Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => setEditing(null)} aria-label="Cancelar edição">
                                                        <X />
                                                    </Button>
                                                </form>
                                            ) : formatLots(l.max_lots)}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">{formatDate(l.created_at)}</TableCell>
                                        <TableCell>
                                            <Badge variant={l.is_active ? 'success' : 'muted'}>{l.is_active ? 'Ativa' : 'Revogada'}</Badge>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex justify-end gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => startEditing(l)}
                                                    disabled={editing?.id === l.id}
                                                    aria-label={`Editar limite da conta ${l.client_mt5_login}`}
                                                >
                                                    <Pencil /> Limite
                                                </Button>
                                                {!l.is_active ? (
                                                    <Button variant="ghost" size="sm" loading={isBusy} onClick={() => reactivate(l)}>
                                                        {!isBusy && <RotateCcw />} Reativar
                                                    </Button>
                                                ) : confirmRevoke === l.id ? (
                                                    <>
                                                        <Button variant="destructive" size="sm" loading={isBusy} onClick={() => revoke(l)}>
                                                            {!isBusy && <Ban />} Confirmar
                                                        </Button>
                                                        <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => setConfirmRevoke(null)}>
                                                            Cancelar
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                        onClick={() => { setEditing(null); setConfirmRevoke(l.id); }}
                                                        aria-label={`Revogar a conta ${l.client_mt5_login}`}
                                                    >
                                                        <Ban /> Revogar
                                                    </Button>
                                                )}
                                            </div>
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
