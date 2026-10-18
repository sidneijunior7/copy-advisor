
import axios from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8000' : ''),
});

let onUnauthorized: () => void = () => {};

// AuthProvider registers its logout here; returns the cleanup for useEffect
export const setUnauthorizedHandler = (handler: () => void) => {
    onUnauthorized = handler;
    return () => { onUnauthorized = () => {}; };
};

api.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem('token');
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => Promise.reject(error)
);

api.interceptors.response.use(
    (response) => response,
    (error) => {
        // On /token a 401 is just a wrong password, shown by the login form
        if (error.response?.status === 401 && error.config?.url !== '/token') {
            onUnauthorized();
        }
        return Promise.reject(error);
    }
);

export default api;

// Response shapes. Datetimes are naive UTC ("2026-10-15T13:00:00"): read them with parseUtc (lib/utils)

export type Strategy = { id: number; name: string; magic_number: number; is_active: boolean };

export type Portfolio = {
    id: number;
    name: string;
    strategies: Pick<Strategy, 'id' | 'name' | 'magic_number'>[];
};

export type License = {
    id: number;
    portfolio_id: number | null;
    strategy_id: number | null;
    client_mt5_login: number;
    max_lots: number;
    is_active: boolean;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    key_prefix: string | null;
    has_key: boolean;
    license_key?: string; // Plain Slave key: only in the response that creates it
};

export type MasterKey = {
    id: number;
    label: string;
    key_prefix: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
    key?: string; // Plain key: only in the response that creates it
};

// Live WSS sessions as the hub reports them; connected_at in unix seconds
export type MasterSession = {
    kind: 'master';
    manager_id: number;
    key_id: number;
    key_label: string | null;
    login: number;
    ea_version: string;
    connected_at: number;
    last_msg_age_s: number;
};

export type SlaveSession = {
    kind: 'slave';
    license_id: number;
    portfolio_id: number;
    portfolio_name: string;
    login: number;
    ea_version: string;
    connected_at: number;
    active: boolean; // false: manage-only, the license was revoked or expired
    max_lots: number;
    last_ack_seq: number | null;
    lag: number | null; // Messages behind the portfolio
    last_ack_age_s: number | null;
};

export type EaKind = 'master' | 'slave';

// The current version of each EA, to flag terminals that run an older one
export type Connections = {
    available: boolean;
    masters: MasterSession[];
    slaves: SlaveSession[];
    latest: Partial<Record<EaKind, string>>;
};

// A compiled EA the dashboard offers for download; built_at in UTC with a Z
export type EaRelease = { version: string; file: string; size: number; sha256: string; built_at: string };
export type EaReleases = Partial<Record<EaKind, EaRelease>>;

// A copy a Slave could not make, or made smaller: retcode is MT5's TRADE_RETCODE_*. For 10034 (the license's
// lot limit) volume is what was left out; otherwise it is the volume the order tried
export type CopyIssue = {
    at: string;
    portfolio_id: number;
    portfolio_name: string;
    login: number;
    license_id: number | null;
    uid: string; // <master login>_<position id>
    action: string;
    volume: number | null;
    retcode: number;
};

// Slave inputs a manager sets for a hosted terminal; the rest keep the EA's defaults
export type HostingInputs = {
    sizing_mode?: 'factor' | 'balance' | 'equity';
    lots_factor?: number;
    reference_capital?: number;
    sltp_mode?: 'distance' | 'price';
    symbol_map?: string;
    suffix_map?: string;
    late_max_deviation_points?: number;
};

// pending: waiting for a pod; disabled and pod_offline come from the API, the rest from the pod's report
export type HostingState =
    | 'pending' | 'starting' | 'running' | 'login_failed' | 'key_refused' | 'error' | 'restarting' | 'stopped'
    | 'disabled' | 'pod_offline';

// A license whose Slave runs in one of our pods. Never the password nor the key
export type HostedTerminal = {
    license_id: number;
    server: string;
    enabled: boolean;
    inputs: HostingInputs;
    state: HostingState;
    detail: string | null;
    status_at: string | null;
    pod: string | null;
    created_at: string;
    updated_at: string;
};

// available: false while the server has no HOSTING_SECRET. servers: the broker servers the pods can log into
export type HostingList = { available: boolean; servers: string[]; terminals: HostedTerminal[] };
