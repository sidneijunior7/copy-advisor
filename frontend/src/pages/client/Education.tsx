import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BadgeCheck, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock, GraduationCap, HelpCircle, Info, Play, PlayCircle, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import api, { type EduFaq, type EduLesson, type EduModule, type MyEducation } from '../../api';
import EmptyState from '../../components/EmptyState';
import Poster from '../../components/education/Poster';
import VideoPlayer from '../../components/education/VideoPlayer';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { drawnBackground, minutesLabel } from '../../lib/education';
import { apiError, cn } from '../../lib/utils';

type Tab = 'lessons' | 'faq';

// A lesson with its module and its number in it
type Item = { lesson: EduLesson; module: EduModule; number: number };

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matches = (query: string, ...texts: (string | null | undefined)[]) =>
    !query || texts.some(t => t && normalize(t).includes(query));

const itemsOf = (module: EduModule): Item[] => module.lessons.map((lesson, i) => ({ lesson, module, number: i + 1 }));
const doneIn = (module: EduModule) => module.lessons.filter(l => l.completed).length;
// The module's next lesson to watch, or its first once all are done
const nextIn = (module: EduModule): Item => itemsOf(module).find(i => !i.lesson.completed) ?? itemsOf(module)[0];
const lessonsLabel = (n: number) => `${n} ${n === 1 ? 'aula' : 'aulas'}`;

// Trademetric's own content, about using the Mirror; the rest is from the managers, about their products
function OfficialBadge({ className }: { className?: string }) {
    return <Badge variant="primary" className={className}><BadgeCheck className="size-3" /> Oficial</Badge>;
}

function ProgressBar({ done, total, className }: { done: number; total: number; className?: string }) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return (
        <div className={cn('h-1 w-full overflow-hidden rounded-full bg-white/20', className)} role="progressbar"
            aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${done} de ${total} aulas concluídas`}>
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
    );
}

// --- The home: a featured module over its banner, then a row of lessons per module, as in a streaming app ---

// Two and a bit per row on phones, up to five and a bit on wide screens
const IN_ROW = 'w-[46%] shrink-0 snap-start sm:w-[31%] lg:w-[23.5%] 2xl:w-[18.8%]';

function LessonCard({ item, showModule, progress, className }: { item: Item; showModule?: boolean; progress?: [number, number]; className?: string }) {
    const { lesson, module, number } = item;
    return (
        <Link to={`/client/education/${lesson.id}`} className={cn('group block', className)}
            aria-label={`Aula ${number}: ${lesson.title}${lesson.completed ? ', concluída' : ''}`}>
            <Poster src={lesson.thumbnail} seed={module.id} number={number} title={lesson.thumbnail ? undefined : lesson.title}
                className="ring-primary/70 transition-shadow group-hover:ring-2 group-focus-visible:ring-2">
                <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="flex size-11 items-center justify-center rounded-full bg-white/90 text-black shadow-lg"><Play className="size-5 translate-x-px fill-current" /></span>
                </span>
                {lesson.completed && (
                    <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[0.65rem] font-medium text-white">
                        <CheckCircle2 className="size-3 text-primary" /> Concluída
                    </span>
                )}
                {lesson.minutes && (
                    <span className="absolute bottom-2 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[0.65rem] font-medium text-white">{minutesLabel(lesson.minutes)}</span>
                )}
                {progress ? <ProgressBar done={progress[0]} total={progress[1]} className="absolute inset-x-0 bottom-0 rounded-none bg-black/50" />
                    : lesson.completed && <span className="absolute inset-x-0 bottom-0 h-1 bg-primary" />}
            </Poster>
            <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-snug sm:text-sm">
                <span className="text-muted-foreground">{number}.</span> {lesson.title}
            </p>
            {showModule && <p className="truncate text-[0.7rem] text-muted-foreground sm:text-xs">{module.title}</p>}
        </Link>
    );
}

// A row sliding sideways under its title: swiped on touch, arrows over its edges from md up
function Row({ heading, children }: { heading: ReactNode; children: ReactNode }) {
    const track = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ start: true, end: true });
    const measure = () => {
        const t = track.current;
        if (!t) return;
        const start = t.scrollLeft <= 4, end = t.scrollLeft + t.clientWidth >= t.scrollWidth - 4;
        setEdges(e => (e.start === start && e.end === end ? e : { start, end }));
    };
    useEffect(() => {
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [children]);
    const slide = (step: -1 | 1) => track.current?.scrollBy({ left: step * track.current.clientWidth * 0.85, behavior: 'smooth' });
    const arrow = 'absolute inset-y-0 z-10 hidden w-10 items-center justify-center text-white opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 md:flex [&_svg]:size-8';
    return (
        <section className="group/row space-y-2">
            {heading}
            <div className="relative">
                <div ref={track} onScroll={measure}
                    className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:gap-3 md:-mx-6 md:scroll-px-6 md:px-6">
                    {children}
                </div>
                {!edges.start && <button type="button" onClick={() => slide(-1)} aria-label="Voltar" className={cn(arrow, '-left-6 bg-gradient-to-r from-background to-transparent')}><ChevronLeft /></button>}
                {!edges.end && <button type="button" onClick={() => slide(1)} aria-label="Mais aulas" className={cn(arrow, '-right-6 bg-gradient-to-l from-background to-transparent')}><ChevronRight /></button>}
            </div>
        </section>
    );
}

function ModuleRow({ module, onInfo }: { module: EduModule; onInfo: () => void }) {
    const done = doneIn(module);
    return (
        <Row heading={
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <button type="button" onClick={onInfo} className="group/title inline-flex items-center gap-1 text-left">
                    <h2 className="text-base font-semibold leading-tight sm:text-lg">{module.title}</h2>
                    <ChevronRight className="size-4 text-primary transition-transform group-hover/title:translate-x-0.5" />
                </button>
                {module.official && <OfficialBadge />}
                <span className="text-xs text-muted-foreground">
                    por {module.manager} · {done ? `${done} de ${module.lessons.length}` : lessonsLabel(module.lessons.length)}
                </span>
            </div>
        }>
            {itemsOf(module).map(i => <LessonCard key={i.lesson.id} item={i} className={IN_ROW} />)}
        </Row>
    );
}

function Hero({ module, toolbar, onInfo }: { module: EduModule; toolbar: ReactNode; onInfo: () => void }) {
    const done = doneIn(module);
    const next = nextIn(module);
    const image = module.cover ?? module.lessons.find(l => l.thumbnail)?.thumbnail;
    const [broken, setBroken] = useState<string | null>(null);
    const label = done === 0 ? 'Comece por aqui' : done === module.lessons.length ? 'Você concluiu este módulo' : 'Continue de onde parou';
    return (
        <section className="relative -mx-4 -mt-4 overflow-hidden bg-black text-white md:-mx-6 md:-mt-6">
            <div className="relative flex min-h-[30rem] flex-col sm:min-h-[26rem] lg:min-h-[32rem]">
                {image && broken !== image
                    ? <img src={image} alt="" referrerPolicy="no-referrer" onError={() => setBroken(image)} className="absolute inset-0 size-full object-cover" />
                    : <div className="absolute inset-0" style={{ background: drawnBackground(module.id) }} aria-hidden="true">
                        <GraduationCap className="absolute -right-8 top-10 size-72 rotate-12 text-white/[0.06] sm:right-10 sm:size-96" />
                    </div>}
                {/* Darkened under the text, and fading into the page at the bottom */}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20 md:bg-gradient-to-r md:from-black/90 md:via-black/50 md:to-transparent" />
                <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
                <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/70 to-transparent" />

                <div className="relative">{toolbar}</div>
                <div className="relative mt-auto max-w-xl space-y-3 px-4 pb-20 pt-16 md:px-6 lg:px-10 lg:pb-24">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">{label}</span>
                        {module.official && <OfficialBadge />}
                    </div>
                    <h2 className="font-spartan text-3xl font-extrabold leading-none tracking-tight drop-shadow sm:text-4xl lg:text-5xl">{module.title}</h2>
                    <p className="text-sm text-white/80">
                        {lessonsLabel(module.lessons.length)} · por {module.manager}
                        {done > 0 && done < module.lessons.length && <> · {done} concluídas</>}
                    </p>
                    {module.description && <p className="line-clamp-3 text-sm leading-relaxed text-white/85 sm:text-base">{module.description}</p>}
                    {done > 0 && <ProgressBar done={done} total={module.lessons.length} className="max-w-xs" />}
                    <div className="flex flex-wrap gap-2 pt-1">
                        <Link to={`/client/education/${next.lesson.id}`}
                            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-white px-6 text-sm font-semibold text-black transition-colors hover:bg-white/80 sm:flex-none">
                            <Play className="size-5 fill-current" />
                            {done === 0 ? 'Assistir' : done === module.lessons.length ? 'Rever'
                                : <>Continuar<span className="hidden sm:inline">: aula {next.number}</span></>}
                        </Link>
                        <button type="button" onClick={onInfo}
                            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-white/20 px-5 text-sm font-semibold backdrop-blur transition-colors hover:bg-white/30 sm:flex-none">
                            <Info className="size-5" /> <span className="sm:hidden">Detalhes</span><span className="hidden sm:inline">Mais informações</span>
                        </button>
                    </div>
                </div>
            </div>
        </section>
    );
}

function Toolbar({ overlay, tab, onTab, faqs, query, onQuery }: {
    overlay: boolean; tab: Tab; onTab: (t: Tab) => void; faqs: number; query: string; onQuery: (q: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const searching = open || query !== '';
    const pill = (active: boolean) => cn('rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
        overlay ? (active ? 'bg-white text-black' : 'text-white/80 hover:text-white') : (active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'));
    return (
        <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', overlay ? 'px-4 pt-4 md:px-6 md:pt-5 lg:px-10' : '')}>
            <h1 className={cn('flex items-center gap-2 font-spartan text-xl font-bold tracking-tight', searching && 'hidden sm:flex')}>
                <GraduationCap className="size-5 text-primary" /> Educacional
            </h1>
            {/* On phones the tabs go under the title and the search, as in a streaming app */}
            <nav className={cn('order-last flex w-full items-center gap-1 sm:order-none sm:w-auto', searching && 'hidden sm:flex')} role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'lessons'} onClick={() => onTab('lessons')} className={pill(tab === 'lessons')}>Aulas</button>
                <button type="button" role="tab" aria-selected={tab === 'faq'} onClick={() => onTab('faq')} className={pill(tab === 'faq')}>
                    Dúvidas <span className="hidden sm:inline">frequentes</span> {faqs > 0 && <span className="opacity-60">{faqs}</span>}
                </button>
            </nav>
            <div className={cn('ml-auto flex items-center', searching && 'flex-1 sm:flex-none')}>
                {searching ? (
                    <div className={cn('flex h-9 w-full items-center gap-2 rounded-md border px-2.5 sm:w-64',
                        overlay ? 'border-white/40 bg-black/60 text-white' : 'border-border bg-card')}>
                        <Search className="size-4 shrink-0 opacity-70" />
                        <input autoFocus value={query} onChange={e => onQuery(e.target.value)} placeholder="Aulas, módulos, dúvidas"
                            aria-label="Buscar nas aulas e dúvidas" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:opacity-60" />
                        <button type="button" onClick={() => { onQuery(''); setOpen(false); }} aria-label="Fechar a busca" className="opacity-70 hover:opacity-100">
                            <X className="size-4" />
                        </button>
                    </div>
                ) : (
                    <button type="button" onClick={() => setOpen(true)} aria-label="Buscar"
                        className={cn('flex size-9 items-center justify-center rounded-full transition-colors', overlay ? 'hover:bg-white/20' : 'hover:bg-accent')}>
                        <Search className="size-5" />
                    </button>
                )}
            </div>
        </div>
    );
}

// The module's page in a modal: its banner, what it is about and every lesson. Full screen on phones
function ModuleDialog({ module, onClose }: { module: EduModule | null; onClose: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = dialog.current;
        if (module && d && !d.open) d.showModal();
        if (!module && d?.open) d.close();
    }, [module]);
    const done = module ? doneIn(module) : 0;
    const image = module && (module.cover ?? module.lessons.find(l => l.thumbnail)?.thumbnail);
    return (
        <dialog ref={dialog} onClose={() => module && onClose()} aria-labelledby="module-dialog-title"
            onClick={e => { if (e.target === dialog.current) dialog.current.close(); }}
            className="m-0 h-full max-h-none w-full max-w-none overflow-y-auto bg-card p-0 text-foreground backdrop:bg-black/75 sm:m-auto sm:my-8 sm:h-auto sm:max-h-[calc(100vh-4rem)] sm:max-w-3xl sm:rounded-xl sm:border sm:border-border">
            {module && (
                <>
                    <div className="relative aspect-video max-h-[50vh] w-full overflow-hidden bg-black text-white sm:max-h-none">
                        {image ? <img src={image} alt="" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover" />
                            : <div className="absolute inset-0" style={{ background: drawnBackground(module.id) }} />}
                        <div className="absolute inset-0 bg-gradient-to-t from-card via-black/30 to-transparent" />
                        <button type="button" onClick={() => dialog.current?.close()} aria-label="Fechar"
                            className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-full bg-black/70 text-white hover:bg-black">
                            <X className="size-5" />
                        </button>
                        <div className="absolute inset-x-0 bottom-0 space-y-3 p-4 sm:p-6">
                            <h2 id="module-dialog-title" className="font-spartan text-2xl font-extrabold leading-none tracking-tight drop-shadow sm:text-4xl">{module.title}</h2>
                            <Link to={`/client/education/${nextIn(module).lesson.id}`}
                                className="inline-flex h-10 items-center gap-2 rounded-md bg-white px-5 text-sm font-semibold text-black hover:bg-white/80">
                                <Play className="size-4 fill-current" /> {done === 0 ? 'Assistir' : done === module.lessons.length ? 'Rever' : `Continuar: aula ${nextIn(module).number}`}
                            </Link>
                        </div>
                    </div>
                    <div className="space-y-5 p-4 sm:p-6">
                        <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                <span>{lessonsLabel(module.lessons.length)}</span>
                                <span>·</span>
                                <span>por {module.manager}</span>
                                {module.official && <OfficialBadge />}
                                {done > 0 && <span className="text-primary">{done} de {module.lessons.length} concluídas</span>}
                            </div>
                            {done > 0 && <ProgressBar done={done} total={module.lessons.length} className="max-w-xs bg-muted" />}
                            {module.description && <p className="text-sm leading-relaxed">{module.description}</p>}
                        </div>
                        <div>
                            <h3 className="mb-1 text-lg font-semibold">Aulas</h3>
                            <div className="divide-y divide-border">
                                {itemsOf(module).map(i => <EpisodeRow key={i.lesson.id} item={i} />)}
                            </div>
                        </div>
                    </div>
                </>
            )}
        </dialog>
    );
}

// A lesson in a list, its poster beside it: in the module's modal and beside the player
function EpisodeRow({ item, active, compact }: { item: Item; active?: boolean; compact?: boolean }) {
    const { lesson, module, number } = item;
    return (
        <Link to={`/client/education/${lesson.id}`} aria-current={active ? 'page' : undefined}
            className={cn('group flex items-center gap-3 py-3 transition-colors', compact ? 'rounded-lg px-2 py-2 hover:bg-accent' : 'sm:gap-4', active && 'bg-accent')}>
            {!compact && <span className="hidden w-6 shrink-0 text-center text-xl font-semibold text-muted-foreground sm:block">{number}</span>}
            <Poster src={lesson.thumbnail} seed={module.id} number={number} className={cn('shrink-0', compact ? 'w-28' : 'w-32 sm:w-40')}>
                <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="flex size-8 items-center justify-center rounded-full border border-white/80 bg-black/50 text-white"><Play className="size-3.5 translate-x-px fill-current" /></span>
                </span>
                {lesson.completed && <span className="absolute inset-x-0 bottom-0 h-1 bg-primary" />}
                {active && <span className="absolute inset-0 ring-2 ring-inset ring-primary" />}
            </Poster>
            <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-start justify-between gap-2">
                    <p className={cn('text-sm font-medium leading-snug', compact && 'line-clamp-2')}>
                        {compact && <span className="text-muted-foreground">{number}. </span>}{lesson.title}
                    </p>
                    {lesson.completed
                        ? <CheckCircle2 className="size-4 shrink-0 text-primary" aria-label="Concluída" />
                        : lesson.minutes && <span className="shrink-0 text-xs text-muted-foreground">{minutesLabel(lesson.minutes)}</span>}
                </div>
                {lesson.summary && !compact && <p className="line-clamp-2 text-xs text-muted-foreground sm:text-sm">{lesson.summary}</p>}
            </div>
        </Link>
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

// --- The player ---

function LessonView({ data, lessonId, onProgress }: { data: MyEducation; lessonId: number; onProgress: (lesson: EduLesson, completed: boolean) => void }) {
    const navigate = useNavigate();
    const [saving, setSaving] = useState(false);
    const all = data.modules.flatMap(itemsOf);
    const index = all.findIndex(i => i.lesson.id === lessonId);
    const current = all[index];

    if (!current) {
        return (
            <div className="panel">
                <EmptyState icon={<GraduationCap />} title="Aula não encontrada" description="Ela pode ter saído do ar."
                    action={<Link to="/client/education"><Button size="sm" variant="outline"><ArrowLeft /> Ver todas as aulas</Button></Link>} />
            </div>
        );
    }

    const { lesson, module, number } = current;
    const prev = all[index - 1];
    const next = all[index + 1];

    const toggle = async () => {
        setSaving(true);
        const completed = !lesson.completed;
        try {
            await api.put(`/me/education/lessons/${lesson.id}/progress`, { completed });
            onProgress(lesson, completed);
            if (completed && next) {
                toast.success('Aula concluída', { action: { label: 'Próxima', onClick: () => navigate(`/client/education/${next.lesson.id}`) } });
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
                    <ArrowLeft className="size-4" /> Educacional
                </Link>
                {lesson.video
                    ? <div className="-mx-4 sm:mx-0"><VideoPlayer video={lesson.video} title={lesson.title} /></div>
                    : <Poster src={lesson.thumbnail} seed={module.id} number={number} title={lesson.thumbnail ? undefined : lesson.title} className="rounded-xl" />}
                <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wider text-primary">{module.title} · aula {number} de {module.lessons.length}</p>
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
                        {prev && <Link to={`/client/education/${prev.lesson.id}`} className="flex-1 sm:flex-none"><Button variant="ghost" className="w-full"><ArrowLeft /> Anterior</Button></Link>}
                        {next && <Link to={`/client/education/${next.lesson.id}`} className="flex-1 sm:flex-none"><Button variant="outline" className="w-full">Próxima <ArrowRight /></Button></Link>}
                    </div>
                </div>
            </div>
            <aside className="panel p-4 lg:sticky lg:top-6">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Aulas do módulo</p>
                <h2 className="font-semibold leading-tight">{module.title}</h2>
                <p className="mb-2 text-xs text-muted-foreground">{doneIn(module)} de {module.lessons.length} concluídas</p>
                <div className="-mx-2 max-h-[70vh] space-y-0.5 overflow-y-auto">
                    {itemsOf(module).map(i => <EpisodeRow key={i.lesson.id} item={i} active={i.lesson.id === lesson.id} compact />)}
                </div>
                {next && next.module.id !== module.id && (
                    <Link to={`/client/education/${next.lesson.id}`} className="mt-3 flex items-center gap-2 rounded-lg border border-border p-3 text-sm hover:bg-accent">
                        <PlayCircle className="size-5 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">A seguir, {next.module.title}</span>
                            <span className="block truncate font-medium">{next.lesson.title}</span></span>
                    </Link>
                )}
            </aside>
        </div>
    );
}

// Tutorials in video, step by step, and the FAQ: Trademetric's about using the Mirror first, then the client's
// managers' about their products, and the managers' open to every user
export default function Education() {
    const { lessonId } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
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

    // The module's modal lives in the address, so the phone's back gesture closes it
    const opened = data?.modules.find(m => m.id === Number(params.get('modulo'))) ?? null;
    const openModule = (id: number) => setParams({ modulo: String(id) }, { state: { modal: true } });
    const closeModule = () => ((location.state as { modal?: boolean } | null)?.modal ? navigate(-1) : setParams({}, { replace: true }));

    const q = normalize(query.trim());
    const found = useMemo(() => (data?.modules ?? []).flatMap(m => itemsOf(m)
        .filter(i => matches(q, m.title, m.description) || matches(q, i.lesson.title, i.lesson.summary, i.lesson.body))), [data, q]);
    const faqs = useMemo(() => (data?.faqs ?? []).filter(f => matches(q, f.question, f.answer)), [data, q]);

    if (data && lessonId) return <LessonView data={data} lessonId={Number(lessonId)} onProgress={onProgress} />;

    if (data === null) return <p className="text-sm text-muted-foreground">Carregando...</p>;

    const modules = data.modules;
    if (modules.length === 0 && data.faqs.length === 0) {
        return (
            <div className="space-y-6">
                <h1 className="flex items-center gap-2 font-spartan text-xl font-bold tracking-tight"><GraduationCap className="size-5 text-primary" /> Educacional</h1>
                <div className="panel">
                    <EmptyState icon={<GraduationCap />} title="Nenhum conteúdo ainda"
                        description="Quando o seu gestor publicar tutoriais e respostas às dúvidas mais comuns, eles aparecem aqui." />
                </div>
            </div>
        );
    }

    // Featured: the first module with a lesson still to watch (Trademetric's come first), or the first one
    const featured = modules.find(m => doneIn(m) < m.lessons.length) ?? modules[0];
    const watching = modules.filter(m => doneIn(m) > 0 && doneIn(m) < m.lessons.length);
    const home = tab === 'lessons' && !q && featured;
    const toolbar = (overlay: boolean) => (
        <Toolbar overlay={overlay} tab={tab} onTab={setTab} faqs={data.faqs.length} query={query} onQuery={setQuery} />
    );

    return (
        <>
            <div className="space-y-8 pb-6">
                {home ? <Hero module={featured} toolbar={toolbar(true)} onInfo={() => openModule(featured.id)} /> : toolbar(false)}

                {q ? (
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            {found.length ? `${lessonsLabel(found.length)} para “${query.trim()}”` : `Nenhuma aula para “${query.trim()}”`}
                            {faqs.length > 0 && tab === 'lessons' && <> · <button type="button" className="text-primary hover:underline" onClick={() => setTab('faq')}>
                                {faqs.length} {faqs.length === 1 ? 'dúvida' : 'dúvidas'}</button></>}
                        </p>
                        {tab === 'lessons' && found.length > 0 && (
                            <div className="grid grid-cols-2 gap-x-2 gap-y-4 sm:grid-cols-3 sm:gap-x-3 lg:grid-cols-4 2xl:grid-cols-5">
                                {found.map(i => <LessonCard key={i.lesson.id} item={i} showModule />)}
                            </div>
                        )}
                        {tab === 'faq' && (faqs.length ? <FaqList faqs={faqs} /> : <div className="panel"><EmptyState icon={<HelpCircle />} title="Nada encontrado" description="Tente outra palavra, ou procure nas aulas." /></div>)}
                    </div>
                ) : tab === 'faq' ? (
                    data.faqs.length ? <div className="max-w-3xl"><FaqList faqs={data.faqs} /></div>
                        : <div className="panel"><EmptyState icon={<HelpCircle />} title="Nenhuma dúvida respondida ainda" /></div>
                ) : modules.length === 0 ? (
                    <div className="panel"><EmptyState icon={<Search />} title="Nenhuma aula ainda" description="Veja as respostas em Dúvidas frequentes." /></div>
                ) : (
                    <div className="relative -mt-12 space-y-8 sm:-mt-14">
                        {watching.length > 0 && (
                            <Row heading={<h2 className="relative text-base font-semibold sm:text-lg">Continue assistindo</h2>}>
                                {watching.map(m => <LessonCard key={m.id} item={nextIn(m)} showModule progress={[doneIn(m), m.lessons.length]} className={IN_ROW} />)}
                            </Row>
                        )}
                        {modules.map(m => <ModuleRow key={m.id} module={m} onInfo={() => openModule(m.id)} />)}
                    </div>
                )}
            </div>
            {/* Outside the spaced column: its margins would push the full-screen modal down on phones */}
            <ModuleDialog module={opened} onClose={closeModule} />
        </>
    );
}
