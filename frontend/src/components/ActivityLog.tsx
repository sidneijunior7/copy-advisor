import { ScrollText } from 'lucide-react';
import type { LogEntry } from '../hooks/useWebSocket';
import { cn } from '../lib/utils';
import EmptyState from './EmptyState';

const dot: Record<LogEntry['level'], string> = {
    info: 'bg-muted-foreground',
    success: 'bg-success',
    error: 'bg-destructive',
};

export default function ActivityLog({ logs }: { logs: LogEntry[] }) {
    if (logs.length === 0) {
        return <EmptyState icon={<ScrollText />} title="Sem atividade nesta sessão" />;
    }

    return (
        <ul className="max-h-80 space-y-1 overflow-y-auto px-5 pb-5" aria-live="polite">
            {logs.map(log => (
                <li key={log.id} className="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                    <span className={cn('h-1.5 w-1.5 shrink-0 -translate-y-0.5 rounded-full', dot[log.level])} />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{log.time}</span>
                    <span className="min-w-0 break-words text-foreground/90">{log.message}</span>
                </li>
            ))}
        </ul>
    );
}
