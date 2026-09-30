import { Badge, type BadgeProps } from './ui/Badge';
import { connectionLabels, type WebSocketStatus } from '../hooks/useWebSocket';

const variants: Record<WebSocketStatus, BadgeProps['variant']> = {
    CONNECTED: 'success',
    CONNECTING: 'warning',
    DISCONNECTED: 'warning',
    ERROR: 'destructive',
    FORBIDDEN: 'muted',
};

export default function ConnectionBadge({ status }: { status: WebSocketStatus }) {
    return (
        <Badge variant={variants[status]} className="rounded-lg px-3 py-1.5 font-medium" role="status">
            <span className="relative flex h-2 w-2">
                {status === 'CONNECTED' && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
                )}
                <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
            </span>
            {connectionLabels[status]}
        </Badge>
    );
}
