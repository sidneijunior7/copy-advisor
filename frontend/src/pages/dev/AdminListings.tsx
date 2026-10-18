import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, RotateCcw, Store } from 'lucide-react';
import { toast } from 'sonner';
import api, { type AdminListing } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import { apiError, cn, formatDate } from '../../lib/utils';

const STATUS = {
    draft: { label: 'Rascunho', variant: 'muted' },
    published: { label: 'Publicado', variant: 'success' },
    suspended: { label: 'Suspenso', variant: 'destructive' },
} as const;

// Moderation: a suspended listing leaves the marketplace and its manager cannot publish it again
export default function AdminListings() {
    const [rows, setRows] = useState<AdminListing[] | null>(null);
    const [suspending, setSuspending] = useState<{ id: number; reason: string } | null>(null);

    useEffect(() => {
        api.get<AdminListing[]>('/admin/listings').then(res => setRows(res.data)).catch(e => { console.error(e); setRows([]); });
    }, []);

    const update = (listing: AdminListing) => setRows(current => current && current.map(r => (r.id === listing.id ? { ...r, ...listing } : r)));

    const suspend = async () => {
        if (!suspending) return;
        try {
            const res = await api.post<AdminListing>(`/admin/listings/${suspending.id}/suspend`, { reason: suspending.reason.trim() });
            update(res.data);
            setSuspending(null);
            toast.success('Anúncio suspenso');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível suspender (o motivo precisa de 3 caracteres).'));
        }
    };

    const restore = async (row: AdminListing) => {
        try {
            update((await api.post<AdminListing>(`/admin/listings/${row.id}/restore`)).data);
            toast.success('Anúncio liberado', { description: 'Voltou a rascunho: o gestor decide quando publicar.' });
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível liberar.'));
        }
    };

    return (
        <div className="space-y-6">
            <PageHeader title="Marketplace" description="Anúncios de todos os gestores. Suspender tira do ar; as licenças já vendidas continuam." icon={<Store />} />
            <Card flush>
                {rows === null ? (
                    <p className="p-5 text-sm text-muted-foreground">Carregando...</p>
                ) : rows.length === 0 ? (
                    <EmptyState icon={<Store />} title="Nenhum anúncio ainda" />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Anúncio</TableHead>
                                <TableHead>Gestor</TableHead>
                                <TableHead>Situação</TableHead>
                                <TableHead>Publicado em</TableHead>
                                <TableHead className="text-right">Ações</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map(r => (
                                <Fragment key={r.id}>
                                    <TableRow className={cn(suspending?.id === r.id && 'border-b-0')}>
                                        <TableCell>
                                            {r.status === 'published'
                                                ? <Link to={`/marketplace/${r.slug}`} target="_blank" className="font-medium hover:underline">{r.title}</Link>
                                                : <span className="font-medium">{r.title}</span>}
                                            <p className="font-mono text-xs text-muted-foreground">/{r.slug}</p>
                                        </TableCell>
                                        <TableCell className="text-sm">{r.manager}</TableCell>
                                        <TableCell>
                                            <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                                            {r.suspended_reason && <p className="mt-1 text-xs text-muted-foreground">{r.suspended_reason}</p>}
                                        </TableCell>
                                        <TableCell>{r.published_at ? formatDate(r.published_at) : '—'}</TableCell>
                                        <TableCell className="text-right">
                                            {r.status === 'suspended' ? (
                                                <Button size="sm" variant="ghost" onClick={() => restore(r)}><RotateCcw /> Liberar</Button>
                                            ) : suspending?.id !== r.id && (
                                                <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                    onClick={() => setSuspending({ id: r.id, reason: '' })}>
                                                    <Ban /> Suspender
                                                </Button>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                    {suspending?.id === r.id && (
                                        <TableRow className="hover:bg-transparent">
                                            <TableCell colSpan={5} className="whitespace-normal pt-0">
                                                <form onSubmit={e => { e.preventDefault(); suspend(); }}
                                                    className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 sm:flex-row sm:items-center">
                                                    <Input autoFocus value={suspending.reason} maxLength={255} placeholder="Motivo (o gestor vê)"
                                                        onChange={e => setSuspending({ ...suspending, reason: e.target.value })} className="h-9 flex-1" />
                                                    <div className="flex gap-1">
                                                        <Button size="sm" variant="destructive"><Ban /> Suspender</Button>
                                                        <Button type="button" size="sm" variant="ghost" onClick={() => setSuspending(null)}>Cancelar</Button>
                                                    </div>
                                                </form>
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </Fragment>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </Card>
        </div>
    );
}
