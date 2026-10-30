import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BadgeCheck, Check, CheckCircle2, ChevronDown, Clock, FileText, GraduationCap, HelpCircle, PlayCircle, Search } from 'lucide-react';
import { toast } from 'sonner';
import api, { type EduFaq, type EduLesson, type EduModule, type MyEducation } from '../../api';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import VideoPlayer from '../../components/education/VideoPlayer';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { minutesLabel } from '../../lib/education';
import { apiError, cn } from '../../lib/utils';

type Tab = 'lessons' | 'faq';

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matches = (query: string, ...texts: (string | null | undefined)[]) =>
    !query || texts.some(t => t && normalize(t).includes(query));

// Trademetric's own content, about using the Mirror; the rest is from the managers, about their products
function OfficialBadge({ className }: { className?: string }) {
    return <Badge variant="primary" className={className}><BadgeCheck className="size-3" /> Oficial</Badge>;
}

function ProgressBar({ done, total, className }: { done: number; total: number; className?: string }) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return (
        <div className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)} role="progressbar"
            aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${done} de ${total} aulas concluídas`}>
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
    );
}

function LessonIcon({ lesson }: { lesson: EduLesson }) {
    if (lesson.completed) return <CheckCircle2 className="size-5 shrink-0 text-success" />;
    if (lesson.video) return <PlayCircle className="size-5 shrink-0 text-primary" />;
    return <FileText className="size-5 shrink-0 text-muted-foreground" />;
}

function LessonRow({ lesson, active }: { lesson: EduLesson; active?: boolean }) {
    return (
        <Link to={`/client/education/${lesson.id}`}
            className={cn('flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent', active && 'bg-accent')}>
            <LessonIcon lesson={lesson} />
            <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-medium', lesson.completed && 'text-muted-foreground')}>{lesson.title}</p>
                {lesson.summary && <p className="truncate text-xs text-muted-foreground">{lesson.summary}</p>}
            </div>
            {lesson.minutes && <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{minutesLabel(lesson.minutes)}</span>}
        </Link>
    );
}

function ModuleCard({ module, lessons }: { module: EduModule; lessons: EduLesson[] }) {
    const done = module.lessons.filter(l => l.completed).length;
    return (
        <section className="panel">
            <header className="space-y-3 p-5 pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="font-semibold leading-tight">{module.title}</h2>
                            {module.official && <OfficialBadge />}
                        </div>
                        <p className="text-xs text-muted-foreground">por {module.manager}</p>
                    </div>
                    <span className="text-xs font-medium text-muted-foreground">{done} de {module.lessons.length}</span>
                </div>
                {module.description && <p className="text-sm text-muted-foreground">{module.description}</p>}
                <ProgressBar done={done} total={module.lessons.length} />
            </header>
            <div className="space-y-0.5 px-2 pb-3">
                {lessons.map(l => <LessonRow key={l.id} lesson={l} />)}
            </div>
        </section>
    );
}

function FaqList({ faqs }: { faqs: EduFaq[] }) {
    return (
        <div className="panel divide-y divide-border">
            {faqs.map(f => (
                <details key={f.id} className="group">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
                        <span className="font-medium">{f.question} {f.official && <OfficialBadge className="ml-1 align-middle" />}</span>
                        <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="px-4 pb-4">
                        <p className="whitespace-pre-line text-sm text-muted-foreground">{f.answer}</p>
                        <p className="mt-2 text-xs text-muted-foreground/70">Resposta de {f.manager}</p>
                    </div>
                </details>
            ))}
        </div>
    );
}

function LessonView({ data, lessonId, onProgress }: { data: MyEducation; lessonId: number; onProgress: (lesson: EduLesson, completed: boolean) => void }) {
    const navigate = useNavigate();
    const [saving, setSaving] = useState(false);
    const all = data.modules.flatMap(m => m.lessons);
    const index = all.findIndex(l => l.id === lessonId);
    const lesson = all[index];
    const module = data.modules.find(m => m.id === lesson?.module_id);

    if (!lesson || !module) {
        return (
            <div className="panel">
                <EmptyState icon={<GraduationCap />} title="Aula não encontrada" description="Ela pode ter saído do ar."
                    action={<Link to="/client/education"><Button size="sm" variant="outline"><ArrowLeft /> Ver todas as aulas</Button></Link>} />
            </div>
        );
    }

    const prev = all[index - 1];
    const next = all[index + 1];

    const toggle = async () => {
        setSaving(true);
        const completed = !lesson.completed;
        try {
            await api.put(`/me/education/lessons/${lesson.id}/progress`, { completed });
            onProgress(lesson, completed);
            if (completed && next) {
                toast.success('Aula concluída', { action: { label: 'Próxima', onClick: () => navigate(`/client/education/${next.id}`) } });
            } else if (completed) {
                toast.success('Aula concluída');
            }
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível salvar o seu progresso.'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
            <div className="space-y-5 lg:col-span-2">
                <Link to="/client/education" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="size-4" /> Todas as aulas
                </Link>
                {lesson.video && <VideoPlayer video={lesson.video} title={lesson.title} />}
                <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wider text-primary">{module.title}</p>
                    <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{lesson.title}</h1>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>por {module.manager}</span>
                        {module.official && <OfficialBadge />}
                        {lesson.minutes && <span className="inline-flex items-center gap-1"><Clock className="size-3.5" /> {minutesLabel(lesson.minutes)}</span>}
                    </div>
                    {lesson.summary && <p className="text-sm text-muted-foreground">{lesson.summary}</p>}
                </div>
                {lesson.body && (
                    <div className="panel p-5">
                        <p className="whitespace-pre-line text-sm leading-relaxed">{lesson.body}</p>
                    </div>
                )}
                <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                    <Button variant={lesson.completed ? 'outline' : 'default'} loading={saving} onClick={toggle}>
                        {!saving && (lesson.completed ? <CheckCircle2 className="text-success" /> : <Check />)}
                        {lesson.completed ? 'Concluída' : 'Marcar como concluída'}
                    </Button>
                    <div className="flex gap-2">
                        {prev && <Link to={`/client/education/${prev.id}`} className="flex-1 sm:flex-none"><Button variant="ghost" className="w-full"><ArrowLeft /> Anterior</Button></Link>}
                        {next && <Link to={`/client/education/${next.id}`} className="flex-1 sm:flex-none"><Button variant="outline" className="w-full">Próxima <ArrowRight /></Button></Link>}
                    </div>
                </div>
            </div>
            <Card title={module.title} description={`${module.lessons.filter(l => l.completed).length} de ${module.lessons.length} concluídas`}
                icon={<GraduationCap />} className="lg:sticky lg:top-6">
                <div className="-mx-3 -mt-2 space-y-0.5">
                    {module.lessons.map(l => <LessonRow key={l.id} lesson={l} active={l.id === lesson.id} />)}
                </div>
            </Card>
        </div>
    );
}

// Tutorials in video, step by step, and the FAQ: Trademetric's about using the Mirror first, then the client's
// managers' about their products, and the managers' open to every user
export default function Education() {
    const { lessonId } = useParams();
    const [data, setData] = useState<MyEducation | null>(null);
    const [tab, setTab] = useState<Tab>('lessons');
    const [query, setQuery] = useState('');

    useEffect(() => {
        api.get<MyEducation>('/me/education').then(res => setData(res.data)).catch(e => { console.error(e); setData({ modules: [], faqs: [] }); });
    }, []);

    const onProgress = (lesson: EduLesson, completed: boolean) => setData(current => current && {
        ...current,
        modules: current.modules.map(m => m.id !== lesson.module_id ? m : {
            ...m, lessons: m.lessons.map(l => (l.id === lesson.id ? { ...l, completed } : l)),
        }),
    });

    const q = normalize(query.trim());
    const filtered = useMemo(() => (data?.modules ?? [])
        .map(m => ({ module: m, lessons: matches(q, m.title, m.description) ? m.lessons : m.lessons.filter(l => matches(q, l.title, l.summary, l.body)) }))
        .filter(m => m.lessons.length > 0), [data, q]);
    const faqs = useMemo(() => (data?.faqs ?? []).filter(f => matches(q, f.question, f.answer)), [data, q]);

    if (data && lessonId) return <LessonView data={data} lessonId={Number(lessonId)} onProgress={onProgress} />;

    const all = data?.modules.flatMap(m => m.lessons) ?? [];
    const done = all.filter(l => l.completed).length;
    const resume = all.find(l => !l.completed);
    const empty = data && data.modules.length === 0 && data.faqs.length === 0;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Educacional"
                description="Tutoriais em vídeo, passo a passo e respostas às dúvidas mais comuns."
                icon={<GraduationCap />}
            />

            {data === null ? (
                <p className="text-sm text-muted-foreground">Carregando...</p>
            ) : empty ? (
                <div className="panel">
                    <EmptyState icon={<GraduationCap />} title="Nenhum conteúdo ainda"
                        description="Quando o seu gestor publicar tutoriais e respostas às dúvidas mais comuns, eles aparecem aqui." />
                </div>
            ) : (
                <>
                    {all.length > 0 && (
                        <div className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex-1 space-y-2">
                                <p className="text-sm font-medium">
                                    {done === all.length ? 'Você concluiu todas as aulas' : `${done} de ${all.length} aulas concluídas`}
                                </p>
                                <ProgressBar done={done} total={all.length} className="max-w-md" />
                            </div>
                            {resume && (
                                <Link to={`/client/education/${resume.id}`}>
                                    <Button className="w-full sm:w-auto"><PlayCircle /> {done ? 'Continuar' : 'Começar'}: {resume.title}</Button>
                                </Link>
                            )}
                        </div>
                    )}

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="inline-flex rounded-lg border border-border bg-secondary p-1" role="tablist">
                            {([['lessons', 'Aulas', PlayCircle, all.length], ['faq', 'Dúvidas frequentes', HelpCircle, data.faqs.length]] as const).map(([key, label, Icon, count]) => (
                                <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                                    className={cn('inline-flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:flex-none',
                                        tab === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                                    <Icon className="size-4" /> {label} <span className="text-xs text-muted-foreground">{count}</span>
                                </button>
                            ))}
                        </div>
                        <div className="sm:w-72">
                            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar" icon={<Search />} aria-label="Buscar nas aulas e dúvidas" />
                        </div>
                    </div>

                    {tab === 'lessons' ? (
                        filtered.length === 0 ? (
                            <div className="panel"><EmptyState icon={<Search />} title={q ? 'Nada encontrado' : 'Nenhuma aula ainda'}
                                description={q ? 'Tente outra palavra, ou procure em Dúvidas frequentes.' : undefined} /></div>
                        ) : (
                            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
                                {filtered.map(({ module, lessons }) => <ModuleCard key={module.id} module={module} lessons={lessons} />)}
                            </div>
                        )
                    ) : faqs.length === 0 ? (
                        <div className="panel"><EmptyState icon={<HelpCircle />} title={q ? 'Nada encontrado' : 'Nenhuma dúvida respondida ainda'}
                            description={q ? 'Tente outra palavra, ou procure nas aulas.' : undefined} /></div>
                    ) : (
                        <FaqList faqs={faqs} />
                    )}
                </>
            )}
        </div>
    );
}
