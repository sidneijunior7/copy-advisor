import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

export type Trade = {
    key: string;
    ticket: string;
    type: string;
    symbol: string;
    volume: string;
    price: string;
    sl: string;
    tp: string;
    magic?: string;
    strategy_id?: number;
    strategy_name?: string;
    timestamp?: number;
};

// The hub sends numbers; the pages compare type against '0' (BUY)
const toTrade = (data: any): Trade => ({ ...data, type: String(data.type) });

export type WebSocketStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'FORBIDDEN';

export const connectionLabels: Record<WebSocketStatus, string> = {
    CONNECTED: 'Conectado',
    CONNECTING: 'Conectando',
    DISCONNECTED: 'Reconectando',
    ERROR: 'Falha na conexão',
    FORBIDDEN: 'Sem acesso',
};

// Signal reasons published by the hub (models.Signal.reason)
const actionLabels: Record<string, string> = {
    OPEN: 'Abertura',
    ADD: 'Aumento',
    PARTIAL: 'Parcial',
    REVERSE: 'Reversão',
    MODIFY: 'Ajuste de SL/TP',
    SYNC: 'Sincronização',
};

// Close codes set by the server (server.py)
const CLOSE_UNAUTHORIZED = 4401; // Token invalid or expired: log out
const CLOSE_FORBIDDEN = 4403; // This account has no live view: don't retry

export type LogEntry = {
    id: number;
    time: string;
    message: string;
    level: 'info' | 'error' | 'success';
}

interface UseWebSocketReturn {
    status: WebSocketStatus;
    trades: Record<string, Trade>;
    logs: LogEntry[];
    connect: () => void;
}

export function useWebSocket(): UseWebSocketReturn {
    const { token, logout } = useAuth();
    const tokenRef = useRef(token);
    const logoutRef = useRef(logout);
    tokenRef.current = token;
    logoutRef.current = logout;

    const [status, setStatus] = useState<WebSocketStatus>('DISCONNECTED');
    const [trades, setTrades] = useState<Record<string, Trade>>({});
    const [logs, setLogs] = useState<LogEntry[]>([]);

    const socketRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);

    const logIdRef = useRef(0);

    const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
        const id = ++logIdRef.current; // Date.now() repeats when two events land in the same millisecond
        setLogs(prev => [
            { id, time: new Date().toLocaleTimeString('pt-BR'), message, level },
            ...prev
        ].slice(0, 100)); // Keep last 100
    }, []);

    const connect = useCallback(() => {
        if (socketRef.current?.readyState === WebSocket.OPEN) return;
        if (!tokenRef.current) return;

        setStatus('CONNECTING');
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Dev mode uses localhost:8000 (Python server), Prod uses relative
        // We need to handle port. If we serve from Python (port 8000), relative is fine.
        // If we dev on 5173, we need to point to 8000.
        // Use VITE_WS_URL if provided, otherwise fallback to logic
        const wsUrl = import.meta.env.VITE_WS_URL
            ? import.meta.env.VITE_WS_URL
            : `${protocol}//${import.meta.env.DEV ? 'localhost:8000' : window.location.host}/ws`;

        addLog('Conectando ao servidor...', 'info');

        const ws = new WebSocket(wsUrl);
        socketRef.current = ws;

        ws.onopen = () => {
            // The server waits for the token before sending anything
            ws.send(JSON.stringify({ type: 'AUTH', token: tokenRef.current }));
            setStatus('CONNECTED');
            addLog('Conectado ao servidor', 'success');
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'STATE') {
                    const state: Record<string, Trade> = {};
                    for (const [key, data] of Object.entries(msg.trades)) state[key] = toTrade(data);
                    setTrades(state);
                } else if (msg.type === 'UPDATE') {
                    // Every UPDATE carries the full position state: volume 0 means closed
                    const data = msg.data;
                    if (Number(data.volume) > 0) {
                        setTrades(prev => ({ ...prev, [data.key]: toTrade(data) }));
                        addLog(`${actionLabels[data.action] ?? data.action}: ${data.symbol} #${data.ticket} (${data.volume} lotes)`, 'success');
                    } else {
                        setTrades(prev => {
                            const next = { ...prev };
                            delete next[data.key];
                            return next;
                        });
                        addLog(`Posição encerrada: ${data.symbol} #${data.ticket}`, 'info');
                    }
                }
            } catch (error) {
                console.error("Parse error", error);
            }
        };

        ws.onclose = (event) => {
            socketRef.current = null;
            if (event.code === CLOSE_UNAUTHORIZED) {
                setStatus('DISCONNECTED');
                logoutRef.current();
                return;
            }
            if (event.code === CLOSE_FORBIDDEN) {
                setStatus('FORBIDDEN');
                addLog('Esta conta não tem acesso ao acompanhamento ao vivo', 'error');
                return;
            }
            setStatus('DISCONNECTED');
            addLog('Conexão perdida. Reconectando...', 'error');
            // Reconnect
            reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
        };

        ws.onerror = () => {
            setStatus('ERROR');
            // addLog('Connection Error', 'error');
        };

    }, [addLog]);

    useEffect(() => {
        connect();
        return () => {
            if (socketRef.current) {
                socketRef.current.onclose = null; // Prevent trigger
                socketRef.current.close();
            }
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        };
    }, [connect]);

    // A refreshed token extends the open connection, which would otherwise close when the old one expires
    useEffect(() => {
        const ws = socketRef.current;
        if (token && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'AUTH', token }));
        }
    }, [token]);

    return { status, trades, logs, connect };
}
