
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Archive, Lock, Mail, Plus, ShieldCheck, Unlock, UserCheck, Users, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import api from '../api';
import Card from '../components/Card';
import EmptyState from '../components/EmptyState';
import KPICard from '../components/KPICard';
import PageHeader from '../components/PageHeader';
import { Badge, type BadgeProps } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table';
import { apiError, cn, formatDate } from '../lib/utils';

type ManagerForm = { email: string; password: string };
type ManagerStatus = 'active' | 'frozen' | 'archived';

const statuses: Record<ManagerStatus, { label: string; action: string; badge: BadgeProps['variant']; icon: LucideIcon }> = {
    active: { label: 'Ativo', action: 'Ativar', badge: 'success', icon: Unlock },
    frozen: { label: 'Congelado', action: 'Congelar', badge: 'warning', icon: Lock },
    archived: { label: 'Arquivado', action: 'Arquivar', badge: 'destructive', icon: Archive },
};

export default function DevDashboard() {
    const [managers, setManagers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<ManagerForm>();

    const refresh = async () => {
        try {
            const res = await api.get('/admin/managers');
            setManagers(res.data);
        } catch (e) {
            console.error(e);
            toast.error('Não foi possível carregar os gestores.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { refresh(); }, []);

    const onCreateManager = async (data: ManagerForm) => {
        try {
            await api.post('/admin/managers', { ...data, role: 'MANAGER' });
            reset();
            toast.success(`Gestor ${data.email} criado`);
            refresh();
        } catch (err: any) {
            setError('root', { message: apiError(err, 'Não foi possível criar o gestor.') });
        }
    };

    const updateStatus = async (manager: any, status: ManagerStatus) => {
        if (manager.status === status) return;
        try {
            await api.patch(`/admin/managers/${manager.id}/status?status=${status}`);
            toast.success(`${manager.email}: ${statuses[status].label.toLowerCase()}`);
            refresh();
        } catch (e) {
            console.error(e);
            toast.error('Não foi possível alterar o status.');
        }
    };

    const activeCount = managers.filter(m => m.status === 'active').length;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Gestores"
                description="Crie contas de gestor e controle quem pode operar na plataforma."
                icon={<ShieldCheck />}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <KPICard label="Gestores" value={managers.length} subValue="Contas cadastradas" icon={<Users />} />
                <KPICard label="Ativos" value={activeCount} subValue="Com acesso liberado" icon={<UserCheck />} valueClassName="text-success" />
                <KPICard label="Bloqueados" value={managers.length - activeCount} subValue="Congelados ou arquivados" icon={<Lock />} />
            </div>

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
                <Card title="Novo gestor" icon={<Plus />}>
                    <form onSubmit={handleSubmit(onCreateManager)} className="space-y-4" noValidate>
                        <Field label="Email" htmlFor="manager-email" error={errors.email?.message}>
                            <Input
                                {...register('email', { required: 'Informe o email' })}
                                id="manager-email"
                                type="email"
                                autoComplete="off"
                                icon={<Mail />}
                                placeholder="gestor@exemplo.com"
                            />
                        </Field>
                        <Field label="Senha inicial" htmlFor="manager-password" error={errors.password?.message}>
                            <Input
                                {...register('password', { required: 'Informe uma senha' })}
                                id="manager-password"
                                type="password"
                                autoComplete="new-password"
                                icon={<Lock />}
                            />
                        </Field>
                        {errors.root && (
                            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                                {errors.root.message}
                            </div>
                        )}
                        <Button className="w-full" loading={isSubmitting}>
                            {!isSubmitting && <Plus />} Criar gestor
                        </Button>
                    </form>
                </Card>

                <Card title="Contas de gestor" icon={<Users />} className="lg:col-span-2" flush>
                    {loading ? (
                        <p className="px-5 pb-5 text-sm text-muted-foreground">Carregando...</p>
                    ) : managers.length === 0 ? (
                        <EmptyState icon={<Users />} title="Nenhum gestor cadastrado" description="Crie a primeira conta de gestor ao lado." />
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Gestor</TableHead>
                                    <TableHead>Criado em</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead className="text-right">Acesso</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {managers.map(m => {
                                    const current = statuses[m.status as ManagerStatus];
                                    return (
                                        <TableRow key={m.id}>
                                            <TableCell>
                                                <p className="font-medium">{m.email}</p>
                                                <p className="font-mono text-xs text-muted-foreground">ID {m.id}</p>
                                            </TableCell>
                                            <TableCell className="text-muted-foreground">{formatDate(m.created_at)}</TableCell>
                                            <TableCell>
                                                <Badge variant={current?.badge}>{current?.label ?? m.status}</Badge>
                                            </TableCell>
                                            <TableCell>
                                                <div className="ml-auto flex w-fit rounded-lg border border-border/40 bg-secondary/40 p-0.5">
                                                    {(Object.keys(statuses) as ManagerStatus[]).map(status => {
                                                        const { action, icon: Icon } = statuses[status];
                                                        const selected = m.status === status;
                                                        return (
                                                            <button
                                                                key={status}
                                                                onClick={() => updateStatus(m, status)}
                                                                title={action}
                                                                aria-label={`${action} ${m.email}`}
                                                                aria-pressed={selected}
                                                                className={cn(
                                                                    'rounded-md p-2 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                                                    selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                                                                )}
                                                            >
                                                                <Icon className="size-4" />
                                                            </button>
                                                        );
                                                    })}
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
        </div>
    );
}
