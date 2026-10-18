
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
    client_limits: ClientLimits;
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
    client: { email: string; name: string | null } | null; // The client account it is linked to
    claim_expires_at: string | null; // An access code is waiting to be used until then
    settings: HostingInputs;
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

// What a portfolio's clients may set on their own licenses
export type ClientLimits = {
    factor_min: number;
    factor_max: number;
    sizing_modes: NonNullable<HostingInputs['sizing_mode']>[];
    sltp_modes: NonNullable<HostingInputs['sltp_mode']>[];
};

// The Slave settings a client may change
export type ClientSettings = {
    sizing_mode: NonNullable<HostingInputs['sizing_mode']>;
    lots_factor: number;
    reference_capital: number | null;
    sltp_mode: NonNullable<HostingInputs['sltp_mode']>;
    symbol_map: string | null;
    suffix_map: string | null;
};

// A license as its client sees it. hosting: the terminal we run for it; connection: its Slave on the hub now
export type ClientLicense = {
    id: number;
    portfolio: { id: number; name: string | null };
    manager: string | null;
    mt5_login: number;
    max_lots: number;
    is_active: boolean;
    valid: boolean; // Active and not expired
    expires_at: string | null;
    has_key: boolean;
    key_prefix: string | null;
    settings: { [K in keyof ClientSettings]: ClientSettings[K] | null };
    limits: ClientLimits;
    hosting: { server: string; enabled: boolean; state: HostingState; detail: string | null; status_at: string | null } | null;
    connection: { ea_version: string | null; connected_at: number | null; active: boolean; last_ack_age_s: number | null } | null;
};

export type MyLicenses = { hosting_available: boolean; servers: string[]; licenses: ClientLicense[] };

// One copy on the client's account, from the Slave's reports. result: close minus open price, signed by direction
export type CopyRow = {
    uid: string;
    symbol: string | null;
    type: 'buy' | 'sell' | null;
    status: 'open' | 'closed' | 'failed';
    opened_at: string;
    closed_at: string | null;
    volume: number;
    open_price: number | null;
    close_price: number | null;
    result: number | null;
    profit: number | null; // In money, when the Slave reports it (4.04+)
    failures: number;
};

export type ClientIssue = { at: string; uid: string; action: string; volume: number | null; retcode: number };

// Results of closed trades in a period, in the account's currency. return_pct and max_drawdown_pct need the
// balance at the start of the period (one Master account); curve is the cumulative result after each trade
export type PerformanceStats = {
    currency: string | null;
    trades: number;
    wins: number;
    losses: number;
    win_rate: number | null;
    net: number;
    gross_profit: number;
    gross_loss: number;
    profit_factor: number | null;
    avg_win: number | null;
    avg_loss: number | null;
    best: number | null;
    worst: number | null;
    max_drawdown: number;
    start_balance: number | null;
    return_pct: number | null;
    max_drawdown_pct: number | null;
    months: { month: string; net: number }[];
    curve: { t: string; v: number }[];
};

export type PortfolioPerformance = PerformanceStats & { strategies: { id: number; name: string | null; trades: number; net: number }[] };

export type CopiesPerformance = PerformanceStats & { equity: { t: string; balance: number | null; equity: number | null }[] };

export type MyPerformance = { copies: CopiesPerformance; portfolio: PortfolioPerformance | null };

// How the followers copied a portfolio, in points (price difference): accounts of any size compare
export type FollowerSymbol = {
    symbol: string;
    copies: number;
    master_points: number;
    follower_points: number;
    entry_cost: number; // Positive: the follower got a worse price than the Master
    exit_cost: number;
    capture: number | null; // Followers' points over the Master's, in %; null when the Master did not gain
};

export type FollowerStats = {
    followers: number;
    copies: number;
    capture: number | null;
    copy_rate: number | null;
    latency_ms: number | null;
    symbols: FollowerSymbol[];
};

// The marketplace shows the figures only past a minimum of followers and copies
export type PublicFollowerStats = { enough: boolean; min_followers: number; min_copies: number } & Partial<FollowerStats>;

export type Me = { email: string; name: string | null; role: 'MANAGER' | 'CLIENT' | 'TDM_DEV'; bio: string | null; email_verified: boolean; email_enabled: boolean };

export const MARKETS = ['B3', 'Forex', 'Cripto', 'Índices', 'Commodities'] as const;
export type Market = typeof MARKETS[number];

// A portfolio's listing as its manager edits it
export type Listing = {
    id: number;
    portfolio_id: number;
    slug: string;
    title: string;
    summary: string | null;
    description: string | null;
    markets: Market[];
    price: number | null;
    currency: 'BRL' | 'USD';
    checkout_url: string | null;
    default_days: number;
    default_max_lots: number;
    min_capital: number | null;
    hosting_allowed: boolean;
    status: 'draft' | 'published' | 'suspended';
    suspended_reason: string | null;
    published_at: string | null;
    updated_at: string | null;
};

export type MyListing = { portfolio: { id: number; name: string; strategies: number }; listing: Listing | null };

// What anyone sees in the marketplace: the last 90 days in stats, the manager's public profile
export type PublicListing = Omit<Listing, 'portfolio_id' | 'status' | 'suspended_reason' | 'default_max_lots'> & {
    manager: { name: string; bio: string | null };
    strategies: string[];
    stats: Pick<PerformanceStats, 'currency' | 'trades' | 'win_rate' | 'net' | 'return_pct' | 'max_drawdown_pct' | 'profit_factor'> & { curve: number[] };
};

export type SubscriptionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type Subscription = {
    id: number;
    listing: { id: number; slug: string; title: string; checkout_url: string | null; price: number | null; currency: string; default_days: number };
    mt5_login: number;
    kind: 'new' | 'renewal';
    status: SubscriptionStatus;
    note: string | null;
    decision_note: string | null;
    license_id: number | null;
    created_at: string;
    decided_at: string | null;
    client?: { name: string | null; email: string }; // Only for the manager
};

export type AdminListing = Listing & { manager: string | null };
