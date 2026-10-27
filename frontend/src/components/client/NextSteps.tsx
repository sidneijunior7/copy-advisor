import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { ClientLicense } from '../../api';
import { nextStep } from '../../lib/clientLicense';
import { cn } from '../../lib/utils';

// The licenses that are not copying for a reason the client can fix, each with the step that fixes it
export default function NextSteps({ licenses }: { licenses: ClientLicense[] }) {
    const pending = licenses.map(l => ({ l, step: nextStep(l) })).filter(p => p.step !== null);
    if (pending.length === 0) return null;
    const urgent = pending.some(p => p.step!.tone === 'destructive');

    return (
        <section className={cn('rounded-xl border-2 p-4 sm:p-5', urgent ? 'border-destructive/40 bg-destructive/5' : 'border-warning/40 bg-warning/5')}>
            <h2 className="flex items-center gap-2 font-semibold">
                <AlertTriangle className={cn('size-4', urgent ? 'text-destructive' : 'text-warning')} />
                {pending.length === 1 ? 'Falta 1 passo para copiar' : `${pending.length} cópias precisam de você`}
            </h2>
            <ul className="mt-3 space-y-2">
                {pending.map(({ l, step }) => (
                    <li key={l.id}>
                        <Link to={`/client/licenses/${l.id}`}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 active:bg-muted/50">
                            <span className="min-w-0">
                                <span className="block text-sm font-medium">{step!.title}</span>
                                <span className="block text-xs text-muted-foreground">
                                    {l.portfolio.name ?? `Portfólio #${l.portfolio.id}`}{l.mt5_login != null && ` · conta ${l.mt5_login}`} · {step!.detail}
                                </span>
                            </span>
                            <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
                                <span className="hidden sm:inline">{step!.action}</span> <ArrowRight className="size-4" />
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    );
}
