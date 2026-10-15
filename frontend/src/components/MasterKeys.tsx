import { Fragment, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Ban, KeyRound, Plus } from 'lucide-react';
import { toast } from 'sonner';
import api, { type MasterKey } from '../api';
import Card from './Card';
import EmptyState from './EmptyState';
import InlineConfirm from './InlineConfirm';
import OneTimeKey from './OneTimeKey';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Field, Input } from './ui/Field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/Table';
import { apiError, cn, formatDate, formatDateTime } from '../lib/utils';

type KeyForm = { label: string };

// One key per Master/VPS: revoking one cuts off only the terminals that use it
export default function MasterKeys() {
    const [keys, setKeys] = useState<MasterKey[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    // The plain key lives here, and only until the user closes the notice
    const [created, setCreated] = useState<{ label: string; key: string } | null>(null);
    const [confirmRevoke, setConfirmRevoke] = useState<number | null>(null);
    const [busy, setBusy] = useState<number | null>(null);
    const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<KeyForm>();

    const refresh = async () => {
        try {
            const res = await api.get<MasterKey[]>('/me/master-keys');
            setKeys(res.data);
        } catch (e) {
            console.error(e);
            toast.error('Não foi possível carregar as chaves do Master.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { refresh(); }, []);

    const onCreate = async (data: KeyForm) => {
        try {
            const res = await api.post<MasterKey>('/me/master-keys', { label: data.label.trim() });
            const { key, ...stored } = res.data;
            setKeys(current => [...current, stored]);
            setCreated({ label: stored.label, key: key ?? '' });
            setCreating(false);
            reset();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível criar a chave.'));
        }
    };

    const cancelCreate = () => {
        setCreating(false);
        reset();
    };

    const revoke = async (k: MasterKey) => {
        setBusy(k.id);
        try {
            const res = await api.delete<MasterKey>(`/me/master-keys/${k.id}`);
            setKeys(current => current.map(x => (x.id === k.id ? res.data : x)));
            toast.success(`Chave "${k.label}" revogada`, { description: 'Os Masters que usavam esta chave foram desconectados.' });
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível revogar a chave.'));
        } finally {
            setBusy(null);
            setConfirmRevoke(null);
        }
    };

    // Active keys first, each group in creation order
    const sorted = [...keys].sort((a, b) => Number(a.revoked_at != null) - Number(b.revoked_at != null));
    const activeCount = keys.filter(k => k.revoked_at == null).length;

    return (
        <Card
            title="Chaves do Master"
            description="Cada EA Master se conecta com uma chave. O Magic Number define a estratégia de cada operação."
            icon={<KeyRound />}
            className="border-primary/20"
            action={
                <Button size="sm" onClick={() => setCreating(true)} disabled={creating || created != null}>
                    <Plus /> Nova chave
                </Button>
            }
            flush
        >
            <p className="px-5 text-xs text-muted-foreground">
                As chaves já configuradas nos seus Masters continuam valendo. O ideal é uma chave por Master/VPS,
                para revogar uma sem parar as outras.
            </p>

            {created ? (
                <OneTimeKey
                    title={`Chave "${created.label}" criada`}
                    value={created.key}
                    label="Chave do Master"
                    onClose={() => setCreated(null)}
                    className="mx-5 mt-4"
                >
                    Cole no campo de chave do EA Master. Trate como uma senha: quem tiver esta chave pode enviar sinais em seu nome.
                </OneTimeKey>
            ) : creating && (
                <form
                    onSubmit={handleSubmit(onCreate)}
                    className="mx-5 mt-4 flex flex-col gap-3 rounded-lg border border-border bg-secondary/30 p-4 sm:flex-row sm:items-start"
                    noValidate
                >
                    <Field
                        label="Rótulo"
                        htmlFor="master-key-label"
                        error={errors.label?.message}
                        hint="Onde a chave vai ser usada, para reconhecê-la depois."
                        className="flex-1 sm:max-w-sm"
                    >
                        <Input
                            {...register('label', {
                                validate: v => v.trim().length > 0 || 'Informe um rótulo',
                                maxLength: { value: 64, message: 'Use até 64 caracteres' },
                            })}
                            id="master-key-label"
                            autoFocus
                            maxLength={64}
                            autoComplete="off"
                            placeholder="Ex.: VPS principal"
                            onKeyDown={e => { if (e.key === 'Escape') cancelCreate(); }}
                        />
                    </Field>
                    <div className="flex gap-2 sm:mt-[1.375rem]">
                        <Button loading={isSubmitting}>
                            {!isSubmitting && <KeyRound />} Criar chave
                        </Button>
                        <Button type="button" variant="ghost" disabled={isSubmitting} onClick={cancelCreate}>
                            Cancelar
                        </Button>
                    </div>
                </form>
            )}

            <div className="mt-4">
                {loading ? (
                    <p className="px-5 pb-5 text-sm text-muted-foreground">Carregando...</p>
                ) : keys.length === 0 ? (
                    <EmptyState
                        icon={<KeyRound />}
                        title="Nenhuma chave criada"
                        description="Crie uma chave para conectar seu EA Master."
                    />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Rótulo</TableHead>
                                <TableHead>Prefixo</TableHead>
                                <TableHead>Criada em</TableHead>
                                <TableHead title="Atualizado pelo hub no máximo a cada hora">Último uso</TableHead>
                                <TableHead>Estado</TableHead>
                                <TableHead className="text-right">Ações</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {sorted.map(k => {
                                const revoked = k.revoked_at != null;
                                const confirming = confirmRevoke === k.id;
                                return (
                                    <Fragment key={k.id}>
                                        <TableRow className={cn(confirming && 'border-b-0', revoked && 'text-muted-foreground')}>
                                            <TableCell className={cn('font-medium', !revoked && 'text-foreground')}>{k.label}</TableCell>
                                            <TableCell className="font-mono text-xs">{k.key_prefix}…</TableCell>
                                            <TableCell className="text-muted-foreground">{formatDate(k.created_at)}</TableCell>
                                            <TableCell className="text-muted-foreground">
                                                {k.last_used_at ? formatDateTime(k.last_used_at) : 'Nunca usada'}
                                            </TableCell>
                                            <TableCell>
                                                <Badge
                                                    variant={revoked ? 'muted' : 'success'}
                                                    title={k.revoked_at ? `Revogada em ${formatDateTime(k.revoked_at)}` : undefined}
                                                >
                                                    {revoked ? 'Revogada' : 'Ativa'}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {!revoked && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                        onClick={() => setConfirmRevoke(k.id)}
                                                        disabled={confirming}
                                                        aria-label={`Revogar a chave ${k.label}`}
                                                    >
                                                        <Ban /> Revogar
                                                    </Button>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                        {confirming && (
                                            <TableRow className="hover:bg-transparent">
                                                <TableCell colSpan={6} className="whitespace-normal pt-0">
                                                    <InlineConfirm
                                                        confirmLabel="Revogar chave"
                                                        icon={<Ban />}
                                                        loading={busy === k.id}
                                                        onConfirm={() => revoke(k)}
                                                        onCancel={() => setConfirmRevoke(null)}
                                                    >
                                                        Revogar <strong>{k.label}</strong>? Os Masters que usam esta chave são desconectados
                                                        e param de enviar sinais na hora.
                                                        {activeCount === 1 && ' É a sua única chave ativa: crie outra antes, se ainda for usar um Master.'}
                                                    </InlineConfirm>
                                                </TableCell>
                                            </TableRow>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
            </div>
        </Card>
    );
}
