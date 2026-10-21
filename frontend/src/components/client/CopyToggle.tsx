import { useState } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../api';
import { apiError, cn } from '../../lib/utils';

interface CopyToggleProps {
    licenseId: number;
    isPaused: boolean;
    disabled?: boolean;
    traderName?: string;
    onChanged?: (newPaused: boolean) => void;
    size?: 'sm' | 'md';
    showLabel?: boolean;
    className?: string;
}

export default function CopyToggle({
    licenseId,
    isPaused,
    disabled = false,
    traderName,
    onChanged,
    size = 'md',
    showLabel = true,
    className,
}: CopyToggleProps) {
    const [loading, setLoading] = useState(false);
    const active = !isPaused;

    const toggle = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (disabled || loading) return;

        const nextPaused = !isPaused;
        setLoading(true);

        try {
            await api.put(`/me/licenses/${licenseId}/pause`, { paused: nextPaused });
            onChanged?.(nextPaused);
            if (nextPaused) {
                toast.warning(`Cópia pausada ${traderName ? `de ${traderName}` : ''}`, {
                    description: 'Pausa suave ativa: nenhuma nova posição será aberta. Posições abertas seguem o Master até fechar.',
                });
            } else {
                toast.success(`Cópia reativada ${traderName ? `de ${traderName}` : ''}`, {
                    description: 'Sua conta está sincronizada e copiando novas operações em tempo real.',
                });
            }
        } catch (err) {
            toast.error(apiError(err, 'Não foi possível alterar o estado da cópia.'));
        } finally {
            setLoading(false);
        }
    };

    const isSmall = size === 'sm';

    return (
        <div className={cn('inline-flex items-center gap-2.5 select-none', className)}>
            <button
                type="button"
                role="switch"
                aria-checked={active}
                disabled={disabled || loading}
                onClick={toggle}
                className={cn(
                    'relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-all duration-300 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
                    isSmall ? 'h-5 w-9' : 'h-6 w-11',
                    active
                        ? 'bg-success shadow-[0_0_12px_rgba(16,185,129,0.35)]'
                        : 'bg-muted-foreground/30 hover:bg-muted-foreground/40',
                )}
                title={active ? 'Clique para pausar a cópia' : 'Clique para ligar a cópia'}
            >
                <span
                    className={cn(
                        'pointer-events-none inline-flex items-center justify-center rounded-full bg-card shadow-md transition-transform duration-300 ease-in-out',
                        isSmall ? 'size-4' : 'size-5',
                        active
                            ? isSmall ? 'translate-x-4 text-success' : 'translate-x-5 text-success'
                            : 'translate-x-0 text-muted-foreground',
                    )}
                >
                    {loading ? (
                        <Loader2 className={cn('animate-spin', isSmall ? 'size-2.5' : 'size-3')} />
                    ) : active ? (
                        <Play className={cn('fill-current', isSmall ? 'size-2' : 'size-2.5')} />
                    ) : (
                        <Pause className={cn('fill-current', isSmall ? 'size-2' : 'size-2.5')} />
                    )}
                </span>
            </button>

            {showLabel && (
                <div className="flex flex-col text-left">
                    <span className={cn('text-xs font-semibold tracking-wide', active ? 'text-success' : 'text-muted-foreground')}>
                        {active ? 'Cópia Ativa' : 'Cópia Pausada'}
                    </span>
                    <span className="text-[10px] text-muted-foreground/80 leading-none">
                        {active ? 'Abrindo e fechando' : 'Pausa suave (fecha abertas)'}
                    </span>
                </div>
            )}
        </div>
    );
}
