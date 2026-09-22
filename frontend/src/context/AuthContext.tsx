
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { jwtDecode } from "jwt-decode";
import api, { setUnauthorizedHandler } from '../api';


interface User {
    sub: string;
    role: 'MANAGER' | 'CLIENT' | 'TDM_DEV';
    exp: number;
}

interface AuthContextType {
    user: User | null;
    token: string | null;
    login: (token: string) => void;
    logout: () => void;
}

// Refresh this long before the token expires
const REFRESH_MARGIN_MS = 60_000;

// The token's claims, or null if it is malformed or already expired
const readToken = (token: string | null): User | null => {
    if (!token) return null;
    try {
        const decoded = jwtDecode<User>(token);
        return decoded.exp * 1000 > Date.now() ? decoded : null;
    } catch {
        return null;
    }
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [token, setToken] = useState<string | null>(() => {
        const stored = localStorage.getItem('token');
        return readToken(stored) ? stored : null;
    });
    const user = readToken(token);

    const login = useCallback((newToken: string) => {
        localStorage.setItem('token', newToken);
        setToken(newToken);
    }, []);

    const logout = useCallback(() => {
        localStorage.removeItem('token');
        setToken(null);
    }, []);

    useEffect(() => {
        if (!token) localStorage.removeItem('token');
    }, [token]);

    // Any 401 from the API means the session is gone
    useEffect(() => setUnauthorizedHandler(logout), [logout]);

    // Refresh shortly before expiry. The server caps the session length: once the refreshed token
    // stops getting a later expiry, let it run out and log out.
    useEffect(() => {
        const claims = readToken(token);
        if (!claims) return;
        const msLeft = claims.exp * 1000 - Date.now();
        let expiryTimer: number | undefined;
        let cancelled = false;
        const refreshTimer = window.setTimeout(async () => {
            try {
                const res = await api.post('/token/refresh');
                if (cancelled) return;
                const next = readToken(res.data.access_token);
                if (next && next.exp > claims.exp) {
                    login(res.data.access_token);
                    return;
                }
            } catch {
                // A 401 already logged out; network errors fall through to the expiry timer
            }
            if (cancelled) return;
            expiryTimer = window.setTimeout(logout, Math.max(0, claims.exp * 1000 - Date.now()));
        }, Math.max(0, msLeft - REFRESH_MARGIN_MS));
        return () => {
            cancelled = true;
            clearTimeout(refreshTimer);
            clearTimeout(expiryTimer);
        };
    }, [token, login, logout]);

    return (
        <AuthContext.Provider value={{ user, token, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
