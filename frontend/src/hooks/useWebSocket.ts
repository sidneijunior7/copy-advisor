import { useState, useEffect, useRef, useCallback } from 'react';

export type Trade = {
    ticket: string;
    type: string;
    symbol: string;
    volume: string;
    price: string;
    sl: string;
    tp: string;
    magic?: string;
    // Add other fields if necessary
};

export type WebSocketStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

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
    const [status, setStatus] = useState<WebSocketStatus>('DISCONNECTED');
    const [trades, setTrades] = useState<Record<string, Trade>>({});
    const [logs, setLogs] = useState<LogEntry[]>([]);

    const socketRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);

    const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
        setLogs(prev => [
            { id: Date.now(), time: new Date().toLocaleTimeString(), message, level },
            ...prev
        ].slice(0, 100)); // Keep last 100
    }, []);

    const connect = useCallback(() => {
        if (socketRef.current?.readyState === WebSocket.OPEN) return;

        setStatus('CONNECTING');
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Dev mode uses localhost:8000 (Python server), Prod uses relative
        // We need to handle port. If we serve from Python (port 8000), relative is fine.
        // If we dev on 5173, we need to point to 8000.
        // Use VITE_WS_URL if provided, otherwise fallback to logic
        const wsUrl = import.meta.env.VITE_WS_URL
            ? import.meta.env.VITE_WS_URL
            : `${protocol}//${import.meta.env.DEV ? 'localhost:8000' : window.location.host}/ws`;

        addLog(`Connecting to ${wsUrl}...`, 'info');

        const ws = new WebSocket(wsUrl);
        socketRef.current = ws;

        ws.onopen = () => {
            setStatus('CONNECTED');
            addLog('Connected to Server', 'success');
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'STATE') {
                    setTrades(msg.trades);
                } else if (msg.type === 'UPDATE') {
                    const data = msg.data;
                    if (data.action === 'OPEN') {
                        // Use same key format as server STATE: "strategyId_ticket"
                        const key = data.strategy_id ? `${data.strategy_id}_${data.ticket}` : String(data.ticket);
                        setTrades(prev => ({ ...prev, [key]: data }));
                        addLog(`Trade Opened: ${data.symbol} #${data.ticket}`, 'success');
                    } else if (data.action === 'CLOSE') {
                        setTrades(prev => {
                            const next = { ...prev };
                            // Key is "strategyId_ticket", find by ticket suffix
                            const key = Object.keys(next).find(k => k.endsWith(`_${data.ticket}`)) || String(data.ticket);
                            delete next[key];
                            return next;
                        });
                        addLog(`Trade Closed: ${data.ticket}`, 'info');
                    }
                }
            } catch (error) {
                console.error("Parse error", error);
            }
        };

        ws.onclose = () => {
            setStatus('DISCONNECTED');
            addLog('Disconnected. Reconnecting...', 'error');
            socketRef.current = null;
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

    return { status, trades, logs, connect };
}
