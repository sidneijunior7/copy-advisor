import { createContext, useContext, useEffect, useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { ArrowDown, ArrowUp, BadgeCheck, Check, Eye, EyeOff, FileText, GraduationCap, HelpCircle, ImageIcon, Info, Pencil, PlayCircle, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import api, { type EduAudience, type EduLesson, type EduManage, type EduManagedFaq, type EduManagedModule } from '../../api';
import EmptyState from '../../components/EmptyState';
import InlineConfirm from '../../components/InlineConfirm';
import PageHeader from '../../components/PageHeader';
import VideoPlayer from '../../components/education/VideoPlayer';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { AUDIENCES, IMAGE_URL, VIDEO_URL, minutesLabel } from '../../lib/education';
import { apiError, cn } from '../../lib/utils';

type Tab = 'lessons' | 'faq';

// Editing Trademetric's own content (an admin): it is always for every client, so there is no audience to choose
const Platform = createContext(false);

// Swaps an item with its neighbour; the API gets the whole new order
const moved = <T,>(items: T[], index: number, step: -1 | 1): T[] => {
    const out = [...items];
    [out[index], out[index + step]] = [out[index + step], out[index]];
    return out;
};

function AudienceBadge({ audience }: { audience: EduAudience }) {
    if (useContext(Platform)) return null;
    return <Badge variant={audience === 'everyone' ? 'primary' : 'muted'}>{AUDIENCES[audience].label}</Badge>;
}

function PublishedBadge({ published }: { published: boolean }) {
    return published ? <Badge variant="success">Publicado</Badge> : <Badge variant="muted">Rascunho</Badge>;
}

function OrderButtons({ index, count, label, onMove }: { index: number; count: number; label: string; onMove: (step: -1 | 1) => void }) {
    return (
        <>
            <Button size="icon" variant="ghost" className="size-8" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Subir ${label}`}><ArrowUp /></Button>
            <Button size="icon" variant="ghost" className="size-8" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Descer ${label}`}><ArrowDown /></Button>
        </>
    );
}

function AudienceField({ id, registration }: { id: string; registration: UseFormRegisterReturn }) {
    if (useContext(Platform)) return null;
    return (
        <Field label="Quem vê" htmlFor={id} hint={`${AUDIENCES.clients.label}: ${AUDIENCES.clients.hint} ${AUDIENCES.everyone.label}: ${AUDIENCES.everyone.hint}`}>
            <Select {...registration} id={id}>
                {Object.entries(AUDIENCES).map(([value, a]) => <option key={value} value={value}>{a.label}</option>)}
            </Select>
        </Field>
    );
}

// --- Modules ---

const imageRule = { validate: (v: string) => !v.trim() || IMAGE_URL.test(v.trim()) || 'Use o link https de uma imagem', maxLength: { value: 500, message: 'Até 500 caracteres' } };

type ModuleFormData = { title: string; description: string; cover_url: string; audience: EduAudience; published: boolean };

function ModuleForm({ module, onSaved, onCancel }: { module: EduManagedModule | null; onSaved: (m: EduManagedModule) => void; onCancel: () => void }) {
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ModuleFormData>({
        defaultValues: {
            title: module?.title ?? '', description: module?.description ?? '', cover_url: module?.cover_url ?? '',
            audience: module?.audience ?? 'clients', published: module?.published ?? false,
        },
    });
    const id = module?.id ?? 'new';
    const save = async (data: ModuleFormData) => {
        const body = {
            title: data.title.trim(), description: data.description.trim() || null, cover_url: data.cover_url.trim() || null,
            audience: data.audience, published: data.published,
        };
        try {
            const res = module ? await api.put<EduManagedModule>(`/education/modules/${module.id}`, body) : await api.post<EduManagedModule>('/education/modules', body);
            onSaved(res.data);
            toast.success(module ? 'Módulo salvo' : 'Módulo criado', { description: module ? undefined : 'Agora adicione as aulas.' });
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível salvar o módulo. Confira os campos.'));
        }
    };
    return (
        <form onSubmit={handleSubmit(save)} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                <Field label="Título do módulo" htmlFor={`module-title-${id}`} error={errors.title?.message} hint="Ex.: Primeiros passos, Instalação, Hospedagem.">
                    <Input {...register('title', { required: 'Informe o título', minLength: { value: 2, message: 'Pelo menos 2 caracteres' }, maxLength: { value: 120, message: 'Até 120 caracteres' } })}
                        id={`module-title-${id}`} />
                </Field>
                <AudienceField id={`module-audience-${id}`} registration={register('audience')} />
            </div>
            <Field label="Descrição (opcional)" htmlFor={`module-description-${id}`} error={errors.description?.message}>
                <Textarea {...register('description', { maxLength: { value: 500, message: 'Até 500 caracteres' } })} id={`module-description-${id}`} rows={2} />
            </Field>
            <Field label="Imagem de capa (opcional)" htmlFor={`module-cover-${id}`} error={errors.cover_url?.message}
                hint="Link https de uma imagem larga (16:9, ex.: 1920×1080), o banner do módulo para o aluno. Sem ela, vale a miniatura da primeira aula.">
                <Input {...register('cover_url', imageRule)} id={`module-cover-${id}`} type="url" icon={<ImageIcon />} placeholder="https://..." />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...register('published')} /> Publicado</label>
                <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancelar</Button>
                    <Button size="sm" loading={isSubmitting}>{!isSubmitting && <Check />} Salvar módulo</Button>
                </div>
            </div>
        </form>
    );
}

// --- Lessons ---

type LessonFormData = { title: string; summary: string; video_url: string; thumbnail_url: string; body: string; minutes: string; published: boolean };

function LessonForm({ moduleId, lesson, onSaved, onCancel }: { moduleId: number; lesson: EduLesson | null; onSaved: (l: EduLesson) => void; onCancel: () => void }) {
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LessonFormData>({
        defaultValues: {
            title: lesson?.title ?? '', summary: lesson?.summary ?? '', video_url: lesson?.video_url ?? '',
            thumbnail_url: lesson?.thumbnail_url ?? '', body: lesson?.body ?? '',
            minutes: lesson?.minutes ? String(lesson.minutes) : '', published: lesson?.published ?? true,
        },
    });
    const id = lesson?.id ?? `new-${moduleId}`;
    const save = async (data: LessonFormData) => {
        const body = {
            title: data.title.trim(), summary: data.summary.trim() || null, video_url: data.video_url.trim() || null,
            thumbnail_url: data.thumbnail_url.trim() || null, body: data.body.trim() || null, minutes: data.minutes ? parseInt(data.minutes) : null, published: data.published,
        };
        try {
            const res = lesson ? await api.put<EduLesson>(`/education/lessons/${lesson.id}`, body) : await api.post<EduLesson>(`/education/modules/${moduleId}/lessons`, body);
            onSaved(res.data);
            toast.success(lesson ? 'Aula salva' : 'Aula criada');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível salvar a aula. Confira o link do vídeo: YouTube, Vimeo ou Panda Video.'));
        }
    };
    return (
        <form onSubmit={handleSubmit(save)} className="space-y-4 rounded-lg border border-border bg-secondary/30 p-4" noValidate>
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[1fr_8rem]">
                <Field label="Título da aula" htmlFor={`lesson-title-${id}`} error={errors.title?.message}>
                    <Input {...register('title', { required: 'Informe o título', minLength: { value: 2, message: 'Pelo menos 2 caracteres' }, maxLength: { value: 120, message: 'Até 120 caracteres' } })}
                        id={`lesson-title-${id}`} />
                </Field>
                <Field label="Duração (min)" htmlFor={`lesson-minutes-${id}`} error={errors.minutes?.message}>
                    <Input {...register('minutes', { validate: v => !v || (parseInt(v) >= 1 && parseInt(v) <= 600) || 'De 1 a 600' })}
                        id={`lesson-minutes-${id}`} type="number" min="1" max="600" className="font-mono" />
                </Field>
            </div>
            <Field label="Resumo (opcional)" htmlFor={`lesson-summary-${id}`} error={errors.summary?.message} hint="Uma frase, embaixo do título na lista de aulas.">
                <Input {...register('summary', { maxLength: { value: 300, message: 'Até 300 caracteres' } })} id={`lesson-summary-${id}`} />
            </Field>
            <Field label="Link do vídeo" htmlFor={`lesson-video-${id}`} error={errors.video_url?.message}
                hint="Do YouTube (pode ser não listado), do Vimeo ou do Panda Video. Em branco, a aula é só texto.">
                <Input {...register('video_url', { validate: v => !v.trim() || VIDEO_URL.test(v.trim()) || 'Use um link https do YouTube, do Vimeo ou do Panda Video' })}
                    id={`lesson-video-${id}`} type="url" icon={<PlayCircle />} placeholder="https://www.youtube.com/watch?v=..." />
            </Field>
            <Field label="Miniatura (opcional)" htmlFor={`lesson-thumbnail-${id}`} error={errors.thumbnail_url?.message}
                hint="Link https de uma imagem 16:9, como a capa do vídeo no Panda Video. Vídeos do YouTube já trazem a deles.">
                <Input {...register('thumbnail_url', imageRule)} id={`lesson-thumbnail-${id}`} type="url" icon={<ImageIcon />} placeholder="https://..." />
            </Field>
            <Field label="Texto da aula" htmlFor={`lesson-body-${id}`} error={errors.body?.message}
                hint="O passo a passo, links e observações. Aparece como escrito, com as quebras de linha.">
                <Textarea {...register('body', { maxLength: { value: 20000, message: 'Até 20.000 caracteres' } })} id={`lesson-body-${id}`} rows={6}
                    placeholder={'1. Abra o MetaTrader 5\n2. ...'} />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...register('published')} /> Publicada</label>
                <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancelar</Button>
                    <Button size="sm" loading={isSubmitting}>{!isSubmitting && <Check />} Salvar aula</Button>
                </div>
            </div>
        </form>
    );
}

function LessonItem({ lesson, index, count, clients, onMove, onSaved, onDeleted }: {
    lesson: EduLesson; index: number; count: number; clients: number;
    onMove: (step: -1 | 1) => void; onSaved: (l: EduLesson) => void; onDeleted: () => void;
}) {
    const [mode, setMode] = useState<'view' | 'preview' | 'edit' | 'delete'>('view');
    const [deleting, setDeleting] = useState(false);
    const remove = async () => {
        setDeleting(true);
        try {
            await api.delete(`/education/lessons/${lesson.id}`);
            onDeleted();
            toast.success('Aula excluída');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível excluir a aula.'));
            setDeleting(false);
        }
    };
    if (mode === 'edit') {
        return <LessonForm moduleId={lesson.module_id} lesson={lesson} onSaved={l => { onSaved(l); setMode('view'); }} onCancel={() => setMode('view')} />;
    }
    return (
        <div className="space-y-3 rounded-lg px-2 py-2 hover:bg-accent/40">
            <div className="flex flex-wrap items-start gap-3">
                {lesson.video ? <PlayCircle className="mt-0.5 size-5 shrink-0 text-primary" /> : <FileText className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{index + 1}. {lesson.title}</p>
                        {!lesson.published && <Badge variant="muted">Rascunho</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {[lesson.video ? `Vídeo do ${{ youtube: 'YouTube', vimeo: 'Vimeo', panda: 'Panda Video' }[lesson.video.provider]}` : 'Só texto',
                          minutesLabel(lesson.minutes),
                          `${lesson.done_by ?? 0} ${lesson.done_by === 1 ? 'concluiu' : 'concluíram'}${clients ? ` de ${clients} ${clients === 1 ? 'cliente' : 'clientes'}` : ''}`].filter(Boolean).join(' · ')}
                    </p>
                </div>
                <div className="flex shrink-0 items-center">
                    <OrderButtons index={index} count={count} label="a aula" onMove={onMove} />
                    <Button size="icon" variant="ghost" className="size-8" onClick={() => setMode(mode === 'preview' ? 'view' : 'preview')}
                        aria-label={mode === 'preview' ? 'Fechar a prévia' : 'Ver como o cliente'} title="Ver como o cliente">
                        {mode === 'preview' ? <EyeOff /> : <Eye />}
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8" onClick={() => setMode('edit')} aria-label="Editar a aula"><Pencil /></Button>
                    <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setMode('delete')} aria-label="Excluir a aula"><Trash2 /></Button>
                </div>
            </div>
            {mode === 'preview' && (
                <div className="max-w-2xl space-y-3 pl-8">
                    {lesson.video && <VideoPlayer video={lesson.video} title={lesson.title} />}
                    {lesson.body && <p className="whitespace-pre-line text-sm leading-relaxed">{lesson.body}</p>}
                </div>
            )}
            {mode === 'delete' && (
                <InlineConfirm confirmLabel="Excluir" icon={<Trash2 />} loading={deleting} onConfirm={remove} onCancel={() => setMode('view')}>
                    Excluir a aula <strong>{lesson.title}</strong>? O progresso dos clientes nela também sai.
                </InlineConfirm>
            )}
        </div>
    );
}

function ModuleItem({ module, index, count, clients, onMove, onChange, onDeleted }: {
    module: EduManagedModule; index: number; count: number; clients: number;
    onMove: (step: -1 | 1) => void; onChange: (m: EduManagedModule) => void; onDeleted: () => void;
}) {
    const platform = useContext(Platform);
    const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
    const [adding, setAdding] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const lessons = module.lessons;

    const remove = async () => {
        setDeleting(true);
        try {
            await api.delete(`/education/modules/${module.id}`);
            onDeleted();
            toast.success('Módulo excluído');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível excluir o módulo.'));
            setDeleting(false);
        }
    };

    const moveLesson = async (i: number, step: -1 | 1) => {
        const next = moved(lessons, i, step);
        onChange({ ...module, lessons: next });
        try {
            await api.put(`/education/modules/${module.id}/lessons/order`, { ids: next.map(l => l.id) });
        } catch (e) {
            onChange({ ...module, lessons });
            toast.error(apiError(e, 'Não foi possível mudar a ordem.'));
        }
    };

    return (
        <section className="panel">
            <div className="space-y-4 p-5">
                {mode === 'edit' ? (
                    <ModuleForm module={module} onSaved={m => { onChange(m); setMode('view'); }} onCancel={() => setMode('view')} />
                ) : (
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h3 className="text-lg font-semibold">{module.title}</h3>
                                <PublishedBadge published={module.published} />
                                <AudienceBadge audience={module.audience} />
                            </div>
                            {module.description && <p className="mt-1 text-sm text-muted-foreground">{module.description}</p>}
                            <p className="mt-1 text-xs text-muted-foreground">{lessons.length} {lessons.length === 1 ? 'aula' : 'aulas'}</p>
                        </div>
                        <div className="flex shrink-0 items-center">
                            <OrderButtons index={index} count={count} label="o módulo" onMove={onMove} />
                            <Button size="sm" variant="ghost" onClick={() => setMode('edit')}><Pencil /> Editar</Button>
                            <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setMode('delete')} aria-label="Excluir o módulo"><Trash2 /></Button>
                        </div>
                    </div>
                )}
                {mode === 'delete' && (
                    <InlineConfirm confirmLabel="Excluir" icon={<Trash2 />} loading={deleting} onConfirm={remove} onCancel={() => setMode('view')}>
                        Excluir o módulo <strong>{module.title}</strong> e as suas {lessons.length} aulas?
                    </InlineConfirm>
                )}
                {!module.published && lessons.some(l => l.published) && (
                    <p className="flex items-center gap-2 text-xs text-warning"><Info className="size-3.5" /> O módulo é rascunho: nenhuma aula dele aparece para os clientes.</p>
                )}

                <div className="space-y-1 border-t border-border pt-3">
                    {lessons.map((l, i) => (
                        <LessonItem key={l.id} lesson={l} index={i} count={lessons.length} clients={platform || module.audience === 'clients' ? clients : 0}
                            onMove={step => moveLesson(i, step)}
                            onSaved={saved => onChange({ ...module, lessons: lessons.map(x => (x.id === saved.id ? saved : x)) })}
                            onDeleted={() => onChange({ ...module, lessons: lessons.filter(x => x.id !== l.id) })} />
                    ))}
                    {lessons.length === 0 && !adding && <p className="px-2 py-3 text-sm text-muted-foreground">Nenhuma aula ainda.</p>}
                    {adding ? (
                        <LessonForm moduleId={module.id} lesson={null} onCancel={() => setAdding(false)}
                            onSaved={l => { onChange({ ...module, lessons: [...lessons, l] }); setAdding(false); }} />
                    ) : (
                        <Button size="sm" variant="outline" className="mt-2" onClick={() => setAdding(true)}><Plus /> Nova aula</Button>
                    )}
                </div>
            </div>
        </section>
    );
}

// --- FAQ ---

type FaqFormData = { question: string; answer: string; audience: EduAudience; published: boolean };

function FaqForm({ faq, onSaved, onCancel }: { faq: EduManagedFaq | null; onSaved: (f: EduManagedFaq) => void; onCancel: () => void }) {
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FaqFormData>({
        defaultValues: { question: faq?.question ?? '', answer: faq?.answer ?? '', audience: faq?.audience ?? 'clients', published: faq?.published ?? true },
    });
    const id = faq?.id ?? 'new';
    const save = async (data: FaqFormData) => {
        const body = { question: data.question.trim(), answer: data.answer.trim(), audience: data.audience, published: data.published };
        try {
            const res = faq ? await api.put<EduManagedFaq>(`/education/faqs/${faq.id}`, body) : await api.post<EduManagedFaq>('/education/faqs', body);
            onSaved(res.data);
            toast.success(faq ? 'Pergunta salva' : 'Pergunta criada');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível salvar a pergunta. Confira os campos.'));
        }
    };
    return (
        <form onSubmit={handleSubmit(save)} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                <Field label="Pergunta" htmlFor={`faq-question-${id}`} error={errors.question?.message}>
                    <Input {...register('question', { required: 'Informe a pergunta', minLength: { value: 3, message: 'Pelo menos 3 caracteres' }, maxLength: { value: 300, message: 'Até 300 caracteres' } })}
                        id={`faq-question-${id}`} placeholder="Preciso deixar o computador ligado?" />
                </Field>
                <AudienceField id={`faq-audience-${id}`} registration={register('audience')} />
            </div>
            <Field label="Resposta" htmlFor={`faq-answer-${id}`} error={errors.answer?.message} hint="Aparece como escrita, com as quebras de linha.">
                <Textarea {...register('answer', { required: 'Escreva a resposta', maxLength: { value: 10000, message: 'Até 10.000 caracteres' } })} id={`faq-answer-${id}`} rows={4} />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...register('published')} /> Publicada</label>
                <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancelar</Button>
                    <Button size="sm" loading={isSubmitting}>{!isSubmitting && <Check />} Salvar pergunta</Button>
                </div>
            </div>
        </form>
    );
}

function FaqItem({ faq, index, count, onMove, onSaved, onDeleted }: {
    faq: EduManagedFaq; index: number; count: number; onMove: (step: -1 | 1) => void; onSaved: (f: EduManagedFaq) => void; onDeleted: () => void;
}) {
    const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
    const [deleting, setDeleting] = useState(false);
    const remove = async () => {
        setDeleting(true);
        try {
            await api.delete(`/education/faqs/${faq.id}`);
            onDeleted();
            toast.success('Pergunta excluída');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível excluir a pergunta.'));
            setDeleting(false);
        }
    };
    return (
        <div className="space-y-3 p-4">
            {mode === 'edit' ? (
                <FaqForm faq={faq} onSaved={f => { onSaved(f); setMode('view'); }} onCancel={() => setMode('view')} />
            ) : (
                <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{faq.question}</p>
                            {!faq.published && <Badge variant="muted">Rascunho</Badge>}
                            <AudienceBadge audience={faq.audience} />
                        </div>
                        <p className="line-clamp-2 whitespace-pre-line text-sm text-muted-foreground">{faq.answer}</p>
                    </div>
                    <div className="flex shrink-0 items-center">
                        <OrderButtons index={index} count={count} label="a pergunta" onMove={onMove} />
                        <Button size="icon" variant="ghost" className="size-8" onClick={() => setMode('edit')} aria-label="Editar a pergunta"><Pencil /></Button>
                        <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setMode('delete')} aria-label="Excluir a pergunta"><Trash2 /></Button>
                    </div>
                </div>
            )}
            {mode === 'delete' && (
                <InlineConfirm confirmLabel="Excluir" icon={<Trash2 />} loading={deleting} onConfirm={remove} onCancel={() => setMode('view')}>
                    Excluir esta pergunta?
                </InlineConfirm>
            )}
        </div>
    );
}

// What Trademetric already teaches the manager's clients: the manager records only what is about its own product
function OfficialOutline({ modules }: { modules: NonNullable<EduManage['official']> }) {
    return (
        <details className="panel group">
            <summary className="flex cursor-pointer list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
                <BadgeCheck className="size-5 shrink-0 text-primary" />
                <span className="flex-1 text-sm">
                    <strong>Seus clientes já veem os tutoriais oficiais da Trademetric</strong> sobre como usar o Mirror
                    ({modules.reduce((n, m) => n + m.lessons.length, 0)} aulas). Aqui, foque no seu produto: a estratégia, o risco, a rotina.
                </span>
                <span className="text-xs text-primary group-open:hidden">Ver</span>
            </summary>
            <div className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
                {modules.map(m => (
                    <div key={m.title}>
                        <p className="text-sm font-medium">{m.title}</p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                            {m.lessons.map(l => <li key={l}>{l}</li>)}
                        </ul>
                    </div>
                ))}
            </div>
        </details>
    );
}

// The educational area's editing: a manager's own modules of video lessons and FAQ, for its clients (or every user);
// for an admin (/dev/education), Trademetric's official ones about using the Mirror, which every client sees
export default function Education() {
    const [data, setData] = useState<EduManage | null>(null);
    const [tab, setTab] = useState<Tab>('lessons');
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        api.get<EduManage>('/education/manage').then(res => setData(res.data)).catch(e => { console.error(e); setData({ modules: [], faqs: [], clients: 0, platform: false }); });
    }, []);

    const setModules = (modules: EduManagedModule[]) => setData(d => d && { ...d, modules });
    const setFaqs = (faqs: EduManagedFaq[]) => setData(d => d && { ...d, faqs });

    const moveModule = async (i: number, step: -1 | 1) => {
        if (!data) return;
        const before = data.modules;
        const next = moved(before, i, step);
        setModules(next);
        try {
            await api.put('/education/modules/order', { ids: next.map(m => m.id) });
        } catch (e) {
            setModules(before);
            toast.error(apiError(e, 'Não foi possível mudar a ordem.'));
        }
    };

    const moveFaq = async (i: number, step: -1 | 1) => {
        if (!data) return;
        const before = data.faqs;
        const next = moved(before, i, step);
        setFaqs(next);
        try {
            await api.put('/education/faqs/order', { ids: next.map(f => f.id) });
        } catch (e) {
            setFaqs(before);
            toast.error(apiError(e, 'Não foi possível mudar a ordem.'));
        }
    };

    const lessons = data?.modules.reduce((n, m) => n + m.lessons.length, 0) ?? 0;

    return (
        <Platform.Provider value={data?.platform ?? false}>
            <div className="space-y-6">
                <PageHeader
                    title={data?.platform ? 'Educacional oficial' : 'Educacional'}
                    description={data?.platform
                        ? 'Os tutoriais da Trademetric sobre como usar o Mirror. Aparecem para todos os clientes, antes do conteúdo dos gestores, com o selo Oficial.'
                        : 'Tutoriais em vídeo, passo a passo e dúvidas frequentes sobre o seu produto, em Educacional no painel dos seus clientes.'}
                    icon={<GraduationCap />}
                >
                    {data && (
                        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Users className="size-4" /> {data.clients} {data.clients === 1 ? 'cliente' : 'clientes'}
                        </span>
                    )}
                </PageHeader>

                <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
                    <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                    <p className="text-muted-foreground">
                        Suba o vídeo no <strong className="text-foreground">YouTube</strong> (como não listado, se não quiser que apareça no seu canal),
                        no <strong className="text-foreground">Vimeo</strong> ou no <strong className="text-foreground">Panda Video</strong> e cole o link na aula.
                        No Panda Video, use o link do player (player-vz-...pandavideo.com.br/embed/?v=...) e, se o vídeo tiver domínios permitidos,
                        inclua o endereço do Mirror. O cliente assiste dentro do painel e marca cada aula como concluída; aqui você vê quantos concluíram.
                    </p>
                </div>

                {data?.official && data.official.length > 0 && <OfficialOutline modules={data.official} />}

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="inline-flex rounded-lg border border-border bg-secondary p-1" role="tablist">
                        {([['lessons', 'Módulos e aulas', PlayCircle, lessons], ['faq', 'Dúvidas frequentes', HelpCircle, data?.faqs.length ?? 0]] as const).map(([key, label, Icon, n]) => (
                            <button key={key} role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setCreating(false); }}
                                className={cn('inline-flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:flex-none',
                                    tab === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                                <Icon className="size-4" /> {label} <span className="text-xs text-muted-foreground">{n}</span>
                            </button>
                        ))}
                    </div>
                    {!creating && data && (
                        <Button size="sm" onClick={() => setCreating(true)}><Plus /> {tab === 'lessons' ? 'Novo módulo' : 'Nova pergunta'}</Button>
                    )}
                </div>

                {data === null ? (
                    <p className="text-sm text-muted-foreground">Carregando...</p>
                ) : tab === 'lessons' ? (
                    <div className="space-y-4">
                        {creating && (
                            <section className="panel p-5">
                                <ModuleForm module={null} onCancel={() => setCreating(false)} onSaved={m => { setModules([...data.modules, m]); setCreating(false); }} />
                            </section>
                        )}
                        {data.modules.length === 0 && !creating ? (
                            <div className="panel">
                                <EmptyState icon={<GraduationCap />} title="Nenhum módulo ainda"
                                    description="Um módulo agrupa aulas em ordem, por exemplo: Primeiros passos, Instalação do EA, Hospedagem na nuvem."
                                    action={<Button size="sm" onClick={() => setCreating(true)}><Plus /> Criar o primeiro módulo</Button>} />
                            </div>
                        ) : data.modules.map((m, i) => (
                            <ModuleItem key={m.id} module={m} index={i} count={data.modules.length} clients={data.clients}
                                onMove={step => moveModule(i, step)}
                                onChange={changed => setModules(data.modules.map(x => (x.id === changed.id ? changed : x)))}
                                onDeleted={() => setModules(data.modules.filter(x => x.id !== m.id))} />
                        ))}
                    </div>
                ) : (
                    <div className="space-y-4">
                        {creating && (
                            <section className="panel p-5">
                                <FaqForm faq={null} onCancel={() => setCreating(false)} onSaved={f => { setFaqs([...data.faqs, f]); setCreating(false); }} />
                            </section>
                        )}
                        {data.faqs.length === 0 && !creating ? (
                            <div className="panel">
                                <EmptyState icon={<HelpCircle />} title="Nenhuma pergunta ainda"
                                    description="Responda uma vez as dúvidas que mais chegam: os clientes encontram aqui antes de chamar o suporte."
                                    action={<Button size="sm" onClick={() => setCreating(true)}><Plus /> Criar a primeira pergunta</Button>} />
                            </div>
                        ) : data.faqs.length > 0 && (
                            <div className="panel divide-y divide-border">
                                {data.faqs.map((f, i) => (
                                    <FaqItem key={f.id} faq={f} index={i} count={data.faqs.length} onMove={step => moveFaq(i, step)}
                                        onSaved={saved => setFaqs(data.faqs.map(x => (x.id === saved.id ? saved : x)))}
                                        onDeleted={() => setFaqs(data.faqs.filter(x => x.id !== f.id))} />
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Platform.Provider>
    );
}
