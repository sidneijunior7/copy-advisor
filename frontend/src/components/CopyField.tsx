import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../lib/utils';

interface CopyFieldProps {
    value: string;
    /** What the toast calls it, e.g. "Chave mestre" */
    label: string;
    /** Hide the value until the user asks to see it */
    secret?: boolean;
    className?: string;
}

const iconButton =
    'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4';

export default function CopyField({ value, label, secret = false, className }: CopyFieldProps) {
    const [copied, setCopied] = useState(false);
    const [visible, setVisible] = useState(!secret);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            toast.success(`${label} copiada`);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error('Não foi possível copiar. Selecione o texto e copie manualmente.');
        }
    };

    return (
        <div className={cn('flex items-center gap-1 rounded-lg border border-border bg-secondary/50 py-1.5 pl-3 pr-1.5', className)}>
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-primary">
                {visible ? value : '•'.repeat(24)}
            </code>
            {secret && (
                <button
                    type="button"
                    onClick={() => setVisible(v => !v)}
                    className={iconButton}
                    aria-label={visible ? `Ocultar ${label}` : `Mostrar ${label}`}
                >
                    {visible ? <EyeOff /> : <Eye />}
                </button>
            )}
            <button type="button" onClick={copy} className={iconButton} aria-label={`Copiar ${label}`}>
                {copied ? <Check className="text-success" /> : <Copy />}
            </button>
        </div>
    );
}
