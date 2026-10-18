
import { Fragment, useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router-dom';
import { Ban, CalendarX, Check, KeyRound, Pencil, RefreshCw, RotateCcw, Search, Server, ShieldCheck, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import api, { type HostedTerminal, type HostingList, type License, type Portfolio, type Strategy } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import HostingPanel, { HostingBadge } from '../../components/HostingPanel';
import InlineConfirm from '../../components/InlineConfirm';
import OneTimeKey from '../../components/OneTimeKey';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import { apiError, cn, formatDate, formatDateTime, isPast, licenseIsValid, parseUtc } from '../../lib/utils';

type LicenseForm = { portfolio_id: string; client_mt5_login: string; max_lots: string; expires_on: string };
type LicenseChanges = { max_lots?: number; is_active?: boolean; expires_at?: string | null };
// One inline action at a time across the list: the limit is edited in its cell, the rest in a panel under the row
type RowAction =
    | { kind: 'limit' | 'expiry'; id: number; value: string }
    | { kind: 'revoke' | 'rotate' | 'hosting'; id: number };

const formatLots = (value: number) => Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// The hub tells the connected Slave within seconds
const EA_DELAY = 'O EA aplica em segundos.';
// What a revoked or expired license still does, after "O EA"
const MANAGE_ONLY = 'não abre posições novas e continua gerindo as abertas até fecharem no Master.';

const editButton = 'size-7 text-muted-foreground hover:text-foreground [&_svg]:size-3.5';

// <input type="date"> works in local days: a license stays valid through the whole day chosen
const toDayInput = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const endOfDay = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d, 23, 59, 59).toISOString();
};
const todayInput = () => toDayInput(new Date());

const HOSTING_POLL_MS = 15_000; // Hosted terminals change state on their own (starting, running, login refused)

export default function Clients() {
    const [licenses, setLicenses] = useState<License[]>([]);
    const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
    const [strategies, setStrategies] = useState<Strategy[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('');
    // Portfolio filter lives in the URL so the Portfolios page can link to its clients
    const [searchParams, setSearchParams] = useSearchParams();
    const portfolioFilter = searchParams.get('portfolio') ?? '';
    const [action, setAction] = useState<RowAction | null>(null);
    const [busy, setBusy] = useState<number | null>(null);
    // Plain Slave keys live here, and only until the user closes the notice
    const [created, setCreated] = useState<{ login: number; key: string } | null>(null);
    const [rotated, setRotated] = useState<{ id: number; key: string; replaced: boolean } | null>(null);
    const [hosting, setHosting] = useState<HostingList | null>(null);
    const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<LicenseForm>({
        defaultValues: { max_lots: '1.00', expires_on: '' },
    });

    const refresh = async () => {
        try {
            const [l, p, s] = await Promise.all([
                api.get<License[]>('/licenses'),
                api.get<Portfolio[]>('/portfolios'),
                api.get<Strategy[]>('/strategies'),
            ]);
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

    useEffect(() => {
        const refreshHosting = () =>
            api.get<HostingList>('/hosting').then(res => setHosting(res.data)).catch(e => console.error(e));
        refreshHosting();
        const timer = window.setInterval(refreshHosting, HOSTING_POLL_MS);
        return () => window.clearInterval(timer);
    }, []);

    const hostedOf = (l: License) => hosting?.terminals.find(t => t.license_id === l.id);

    const onHostingChange = (l: License, terminal: HostedTerminal | null) =>
        setHosting(current => current && {
            ...current,
            terminals: [...current.terminals.filter(t => t.license_id !== l.id), ...(terminal ? [terminal] : [])],
        });

    const onCreateLicense = async (data: LicenseForm) => {
        try {
            const res = await api.post<License>('/licenses', {
                portfolio_id: parseInt(data.portfolio_id),
                client_mt5_login: parseInt(data.client_mt5_login),
                max_lots: parseFloat(data.max_lots),
                expires_at: data.expires_on ? endOfDay(data.expires_on) : null,
            });
            reset();
            setCreated({ login: res.data.client_mt5_login, key: res.data.license_key ?? '' });
            toast.success(`Conta ${data.client_mt5_login} autorizada`);
            refresh();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível autorizar a conta.'));
        }
    };

    const updateLicense = async (l: License, changes: LicenseChanges, message: string, detail: string) => {
        setBusy(l.id);
        try {
            const res = await api.patch<License>(`/licenses/${l.id}`, changes);
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

    const saveLimit = async (l: License, raw: string) => {
        const value = parseFloat(raw);
        if (!(value > 0)) {
            toast.error('O limite deve ser maior que zero.');
            return;
        }
        if (await updateLicense(l, { max_lots: value }, `Conta ${l.client_mt5_login}: limite de ${formatLots(value)} lotes`, EA_DELAY)) {
            setAction(null);
        }
    };

    // An empty day removes the expiry
    const saveExpiry = async (l: License, day: string) => {
        if (!day && !l.expires_at) {
            setAction(null);
            return;
        }
        if (day && day < todayInput()) {
            toast.error('Escolha hoje ou uma data futura. Para cortar a conta agora, use Revogar.');
            return;
        }
        const message = day
            ? `Conta ${l.client_mt5_login}: válida até ${formatDate(endOfDay(day))}`
            : `Conta ${l.client_mt5_login}: sem validade`;
        if (await updateLicense(l, { expires_at: day ? endOfDay(day) : null }, message, EA_DELAY)) {
            setAction(null);
        }
    };

    const revoke = async (l: License) => {
        await updateLicense(l, { is_active: false }, `Conta ${l.client_mt5_login} revogada`, `O EA ${MANAGE_ONLY} ${EA_DELAY}`);
        setAction(null);
    };

    const reactivate = (l: License) =>
        updateLicense(l, { is_active: true }, `Conta ${l.client_mt5_login} reativada`, EA_DELAY);

    // The previous key, if any, stops working at once and the hub drops the terminal using it
    const rotateKey = async (l: License) => {
        setBusy(l.id);
        try {
            const res = await api.post<License>(`/licenses/${l.id}/key`);
            const { license_key, ...stored } = res.data;
            setLicenses(current => current.map(x => (x.id === l.id ? stored : x)));
            if (hostedOf(l)) {
                toast.success(`Conta ${l.client_mt5_login}: nova chave`, { description: 'O terminal hospedado a recebe e reinicia sozinho.' });
            } else {
                setRotated({ id: l.id, key: license_key ?? '', replaced: l.has_key });
            }
            setAction(null);
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível gerar a chave.'));
        } finally {
            setBusy(null);
        }
    };

    const startExpiry = (l: License) =>
        setAction({ kind: 'expiry', id: l.id, value: l.expires_at ? toDayInput(parseUtc(l.expires_at)) : '' });

    // A license grants either a whole portfolio or (older ones) a single strategy
    const accessOf = (l: License) => {
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
    const activeCount = licenses.filter(licenseIsValid).length;
    const today = todayInput();

    return (
        <div className="space-y-6">
            <PageHeader
                title="Clientes"
                description="Autorize contas MT5 a copiar seus portfólios e defina o limite e a validade de cada uma. Alterações chegam ao EA em segundos."
                icon={<Users />}
            />

            <Card
                title="Nova autorização"
                description="A conta só recebe sinais depois de autorizada aqui. Cada autorização gera a chave que o cliente usa no EA Slave v4."
                icon={<ShieldCheck />}
            >
                {created ? (
                    <OneTimeKey
                        title={`Conta ${created.login} autorizada: esta é a chave da licença`}
                        value={created.key}
                        label="Chave da licença"
                        onClose={() => setCreated(null)}
                    >
                        Cole no EA Slave v4 instalado na conta {created.login}. Se ela se perder, use "Nova chave" na lista abaixo.
                    </OneTimeKey>
                ) : (
                    <form onSubmit={handleSubmit(onCreateLicense)} className="grid grid-cols-1 items-start gap-4 md:grid-cols-3 xl:grid-cols-5" noValidate>
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
                        <Field
                            label="Limite de lotes"
                            htmlFor="license-lots"
                            hint="Soma das cópias abertas na conta. Baixar o limite não fecha posições já abertas."
                            error={errors.max_lots?.message}
                        >
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
                        <Field
                            label="Validade (opcional)"
                            htmlFor="license-expiry"
                            error={errors.expires_on?.message}
                            hint="Último dia de cópia. Em branco, não expira."
                        >
                            <Input
                                {...register('expires_on', {
                                    validate: v => !v || v >= todayInput() || 'Escolha hoje ou uma data futura',
                                })}
                                id="license-expiry"
                                type="date"
                                min={today}
                            />
                        </Field>
                        <Button className="md:mt-[1.375rem]" loading={isSubmitting} disabled={portfolios.length === 0}>
                            {!isSubmitting && <ShieldCheck />} Autorizar conta
                        </Button>
                    </form>
                )}
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
                    <>
                        {licenses.some(l => !licenseIsValid(l)) && (
                            <p className="px-5 pb-3 text-xs text-muted-foreground">
                                Contas revogadas ou expiradas ficam em <strong className="font-medium text-foreground">só gestão</strong>: o EA {MANAGE_ONLY}
                            </p>
                        )}
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Conta</TableHead>
                                    <TableHead className="text-right">Limite de lotes</TableHead>
                                    <TableHead>Chave (EA v4)</TableHead>
                                    <TableHead>Validade</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead className="text-right">Ações</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredLicenses.map(l => {
                                    const access = accessOf(l);
                                    const isBusy = busy === l.id;
                                    const mine = action?.id === l.id ? action : null;
                                    const expired = l.expires_at != null && isPast(l.expires_at);
                                    const status = !l.is_active ? 'Revogada' : expired ? 'Expirada' : 'Ativa';
                                    // Strategy licenses predate the hub: they can't get a Slave key
                                    const canHaveKey = l.portfolio_id != null;
                                    const panel = mine && mine.kind !== 'limit' ? mine : null;
                                    const shownKey = !panel && rotated?.id === l.id ? rotated : null;
                                    const hosted = hostedOf(l);
                                    return (
                                        <Fragment key={l.id}>
                                            <TableRow className={cn((panel || shownKey) && 'border-b-0')}>
                                                <TableCell>
                                                    <p className="font-mono font-semibold">{l.client_mt5_login}</p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {access.kind} <span className="text-foreground/80">{access.name}</span>
                                                    </p>
                                                </TableCell>
                                                <TableCell className="text-right font-mono tabular-nums">
                                                    {mine?.kind === 'limit' ? (
                                                        <form
                                                            onSubmit={e => { e.preventDefault(); saveLimit(l, mine.value); }}
                                                            className="flex items-center justify-end gap-1"
                                                        >
                                                            <Input
                                                                autoFocus
                                                                type="number"
                                                                step="0.01"
                                                                min="0.01"
                                                                value={mine.value}
                                                                onChange={e => setAction({ ...mine, value: e.target.value })}
                                                                onKeyDown={e => { if (e.key === 'Escape') setAction(null); }}
                                                                className="h-8 w-24 text-right font-mono"
                                                                aria-label={`Limite de lotes da conta ${l.client_mt5_login}`}
                                                            />
                                                            <Button size="icon" variant="ghost" className="size-8" loading={isBusy} aria-label="Salvar limite">
                                                                {!isBusy && <Check />}
                                                            </Button>
                                                            <Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => setAction(null)} aria-label="Cancelar edição">
                                                                <X />
                                                            </Button>
                                                        </form>
                                                    ) : (
                                                        <div className="flex items-center justify-end gap-1">
                                                            {formatLots(l.max_lots)}
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className={editButton}
                                                                onClick={() => setAction({ kind: 'limit', id: l.id, value: String(l.max_lots) })}
                                                                title="Editar limite"
                                                                aria-label={`Editar limite da conta ${l.client_mt5_login}`}
                                                            >
                                                                <Pencil />
                                                            </Button>
                                                        </div>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-2">
                                                        {l.has_key ? (
                                                            <>
                                                                <code className="font-mono text-xs">{l.key_prefix}…</code>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    className="h-7 px-2 text-xs"
                                                                    onClick={() => setAction({ kind: 'rotate', id: l.id })}
                                                                    disabled={mine?.kind === 'rotate'}
                                                                    aria-label={`Gerar nova chave para a conta ${l.client_mt5_login}`}
                                                                >
                                                                    <RefreshCw /> Nova chave
                                                                </Button>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <span className="text-muted-foreground">sem chave</span>
                                                                {canHaveKey && (
                                                                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" loading={isBusy} onClick={() => rotateKey(l)}>
                                                                        {!isBusy && <KeyRound />} Gerar chave
                                                                    </Button>
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-1">
                                                        {!l.expires_at ? (
                                                            <span className="text-muted-foreground">Sem validade</span>
                                                        ) : expired ? (
                                                            <span className="font-medium text-warning" title={`Expirou em ${formatDateTime(l.expires_at)}`}>Expirada</span>
                                                        ) : (
                                                            <span title={`Até ${formatDateTime(l.expires_at)}`}>Expira em {formatDate(l.expires_at)}</span>
                                                        )}
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className={editButton}
                                                            onClick={() => startExpiry(l)}
                                                            disabled={mine?.kind === 'expiry'}
                                                            title="Editar validade"
                                                            aria-label={`Editar validade da conta ${l.client_mt5_login}`}
                                                        >
                                                            <Pencil />
                                                        </Button>
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">Autorizada em {formatDate(l.created_at)}</p>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant={status === 'Ativa' ? 'success' : status === 'Expirada' ? 'warning' : 'muted'}>{status}</Badge>
                                                    {status !== 'Ativa' && (
                                                        <p className="mt-1 text-xs text-muted-foreground" title={`O EA ${MANAGE_ONLY}`}>Só gestão</p>
                                                    )}
                                                    {hosted && (
                                                        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" title={hosted.detail ?? undefined}>
                                                            <Server className="size-3" /> Hospedada <HostingBadge terminal={hosted} />
                                                        </div>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    {canHaveKey && (hosting?.available || hosted) && (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => setAction({ kind: 'hosting', id: l.id })}
                                                            disabled={mine?.kind === 'hosting'}
                                                            aria-label={`${hosted ? 'Editar a hospedagem' : 'Hospedar o terminal'} da conta ${l.client_mt5_login}`}
                                                        >
                                                            <Server /> {hosted ? 'Hospedagem' : 'Hospedar'}
                                                        </Button>
                                                    )}
                                                    {!l.is_active ? (
                                                        <Button variant="ghost" size="sm" loading={isBusy} onClick={() => reactivate(l)}>
                                                            {!isBusy && <RotateCcw />} Reativar
                                                        </Button>
                                                    ) : (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                            onClick={() => setAction({ kind: 'revoke', id: l.id })}
                                                            disabled={mine?.kind === 'revoke'}
                                                            aria-label={`Revogar a conta ${l.client_mt5_login}`}
                                                        >
                                                            <Ban /> Revogar
                                                        </Button>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                            {(panel || shownKey) && (
                                                <TableRow className="hover:bg-transparent">
                                                    <TableCell colSpan={6} className="whitespace-normal pt-0">
                                                        {panel?.kind === 'expiry' ? (
                                                            <form
                                                                onSubmit={e => { e.preventDefault(); saveExpiry(l, panel.value); }}
                                                                className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/30 p-3 sm:flex-row sm:items-center"
                                                            >
                                                                <label htmlFor={`expiry-${l.id}`} className="text-sm">
                                                                    Último dia de cópia da conta <strong>{l.client_mt5_login}</strong>
                                                                </label>
                                                                <Input
                                                                    id={`expiry-${l.id}`}
                                                                    autoFocus
                                                                    type="date"
                                                                    min={today}
                                                                    value={panel.value}
                                                                    onChange={e => setAction({ ...panel, value: e.target.value })}
                                                                    onKeyDown={e => { if (e.key === 'Escape') setAction(null); }}
                                                                    className="h-9 w-44"
                                                                />
                                                                <div className="flex shrink-0 justify-end gap-1 sm:ml-auto">
                                                                    <Button size="sm" loading={isBusy}>
                                                                        {!isBusy && <Check />} Salvar
                                                                    </Button>
                                                                    {l.expires_at && (
                                                                        <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={() => saveExpiry(l, '')}>
                                                                            <CalendarX /> Remover validade
                                                                        </Button>
                                                                    )}
                                                                    <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={() => setAction(null)}>
                                                                        Cancelar
                                                                    </Button>
                                                                </div>
                                                            </form>
                                                        ) : panel?.kind === 'hosting' ? (
                                                            <HostingPanel
                                                                license={l}
                                                                terminal={hosted}
                                                                servers={hosting?.servers ?? []}
                                                                onChange={t => onHostingChange(l, t)}
                                                                onClose={() => setAction(null)}
                                                            />
                                                        ) : panel?.kind === 'revoke' ? (
                                                            <InlineConfirm
                                                                confirmLabel="Revogar conta"
                                                                icon={<Ban />}
                                                                loading={isBusy}
                                                                onConfirm={() => revoke(l)}
                                                                onCancel={() => setAction(null)}
                                                            >
                                                                Revogar a conta <strong>{l.client_mt5_login}</strong>? O EA {MANAGE_ONLY}
                                                            </InlineConfirm>
                                                        ) : panel?.kind === 'rotate' ? (
                                                            <InlineConfirm
                                                                confirmLabel="Gerar nova chave"
                                                                icon={<RefreshCw />}
                                                                loading={isBusy}
                                                                onConfirm={() => rotateKey(l)}
                                                                onCancel={() => setAction(null)}
                                                            >
                                                                Gerar uma nova chave para a conta <strong>{l.client_mt5_login}</strong>? A chave atual
                                                                para de funcionar e o terminal conectado com ela é desconectado.
                                                            </InlineConfirm>
                                                        ) : shownKey && (
                                                            <OneTimeKey
                                                                title={`${shownKey.replaced ? 'Nova chave' : 'Chave'} da conta ${l.client_mt5_login}`}
                                                                value={shownKey.key}
                                                                label="Chave da licença"
                                                                onClose={() => setRotated(null)}
                                                            >
                                                                Cole no EA Slave v4 instalado nesta conta.
                                                                {shownKey.replaced && ' A chave anterior já não funciona.'}
                                                            </OneTimeKey>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            )}
                                        </Fragment>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </>
                )}
            </Card>
        </div>
    );
}
