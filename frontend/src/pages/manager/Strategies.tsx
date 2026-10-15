
import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { isAxiosError } from 'axios';
import { Layers, Plus } from 'lucide-react';
import { toast } from 'sonner';
import api, { type Strategy } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import MasterKeys from '../../components/MasterKeys';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';

type StrategyForm = { name: string; magic_number: string };

export default function Strategies() {
    const [strategies, setStrategies] = useState<Strategy[]>([]);
    const [loading, setLoading] = useState(true);
    const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<StrategyForm>();

    const refresh = async () => {
        try {
            const res = await api.get<Strategy[]>('/strategies');
            setStrategies(res.data);
        } catch (e) {
            console.error(e);
            toast.error('Não foi possível carregar as estratégias.');
        } finally {
            setLoading(false);
        }
    };

    const onCreate = async (data: StrategyForm) => {
        try {
            await api.post('/strategies', data);
            reset();
            toast.success(`Estratégia "${data.name}" criada`);
            refresh();
        } catch (err) {
            if (isAxiosError(err) && err.response?.status === 400) {
                setError('magic_number', { message: 'Já existe uma estratégia com este Magic Number.' });
            } else {
                toast.error('Não foi possível criar a estratégia.');
            }
        }
    };

    useEffect(() => { refresh(); }, []);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Estratégias"
                description="Cada estratégia é identificada pelo Magic Number usado no MetaTrader 5."
                icon={<Layers />}
            />

            <MasterKeys />

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
                <Card title="Nova estratégia" icon={<Plus />}>
                    <form onSubmit={handleSubmit(onCreate)} className="space-y-4" noValidate>
                        <Field label="Nome" htmlFor="strategy-name" error={errors.name?.message}>
                            <Input
                                {...register('name', { required: 'Informe um nome' })}
                                id="strategy-name"
                                placeholder="Ex.: Scalper Ouro"
                            />
                        </Field>
                        <Field
                            label="Magic Number"
                            htmlFor="strategy-magic"
                            error={errors.magic_number?.message}
                            hint="O mesmo número configurado no robô que opera a conta Master."
                        >
                            <Input
                                {...register('magic_number', {
                                    required: 'Informe o Magic Number',
                                    // Sent as typed: a ulong magic doesn't fit a JS number
                                    pattern: { value: /^\d+$/, message: 'Use apenas dígitos' },
                                })}
                                id="strategy-magic"
                                inputMode="numeric"
                                className="font-mono"
                                placeholder="Ex.: 123456"
                            />
                        </Field>
                        <Button className="w-full" loading={isSubmitting}>
                            {!isSubmitting && <Plus />} Criar estratégia
                        </Button>
                    </form>
                </Card>

                <Card
                    title="Suas estratégias"
                    description={loading ? undefined : `${strategies.length} ${strategies.length === 1 ? 'cadastrada' : 'cadastradas'}`}
                    icon={<Layers />}
                    className="lg:col-span-2"
                    flush
                >
                    {loading ? (
                        <p className="px-5 pb-5 text-sm text-muted-foreground">Carregando...</p>
                    ) : strategies.length === 0 ? (
                        <EmptyState
                            icon={<Layers />}
                            title="Nenhuma estratégia cadastrada"
                            description="Crie a primeira estratégia para começar a distribuir sinais."
                        />
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Nome</TableHead>
                                    <TableHead>Magic Number</TableHead>
                                    <TableHead className="text-right">Status</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {strategies.map(s => (
                                    <TableRow key={s.id}>
                                        <TableCell className="font-medium">{s.name}</TableCell>
                                        <TableCell className="font-mono text-primary">{s.magic_number}</TableCell>
                                        <TableCell className="text-right">
                                            <Badge variant={s.is_active ? 'success' : 'muted'}>
                                                {s.is_active ? 'Ativa' : 'Inativa'}
                                            </Badge>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </Card>
            </div>
        </div>
    );
}
