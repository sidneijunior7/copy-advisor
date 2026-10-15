import { type ReactNode } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import CopyField from './CopyField';
import { Button } from './ui/Button';
import { cn } from '../lib/utils';

interface OneTimeKeyProps {
    title: string;
    value: string;
    /** What the copy toast calls it, e.g. "Chave da licença" */
    label: string;
    /** Where the key goes */
    children?: ReactNode;
    onClose: () => void;
    className?: string;
}

// The API keeps only a hash: once this closes, the key is gone. Callers hold it in state, never in storage or logs
export default function OneTimeKey({ title, value, label, children, onClose, className }: OneTimeKeyProps) {
    return (
        <div role="status" className={cn('space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-4', className)}>
            <div className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                        Copie agora: por segurança, ela não será mostrada de novo.
                    </p>
                </div>
            </div>
            <CopyField value={value} label={label} />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                {children && <p className="text-xs text-muted-foreground">{children}</p>}
                <Button type="button" size="sm" variant="secondary" className="shrink-0 sm:ml-auto" onClick={onClose}>
                    <Check /> Já copiei
                </Button>
            </div>
        </div>
    );
}
