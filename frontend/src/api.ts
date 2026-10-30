
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
    master_login: number | null; // The Master account it copies from; null = every account
};

// An account a Master ever ran on, with its currency and latest balance
export type MasterAccount = {
    master_login: number;
    trade_mode: string;
    server: string | null;
    company: string | null;
    last_seen_at: string | null;
    currency: string | null;
    balance: number | null;
};

export type License = {
    id: number;
    portfolio_id: number | null;
    strategy_id: number | null;
    client_mt5_login: number | null;
    max_lots: number;
    is_active: boolean;
    is_paused?: boolean;
    paused_at?: string | null;
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

// pending: waiting for a pod; disabled, unpaid and pod_offline come from the API, the rest from the pod's report
export type HostingState =
    | 'pending' | 'starting' | 'running' | 'login_failed' | 'key_refused' | 'error' | 'restarting' | 'stopped'
    | 'disabled' | 'unpaid' | 'pod_offline';

// How a hosted terminal is paid: exempt, or a Stripe subscription of its own, apart from the portfolio's
export type HostingBilling = {
    exempt: boolean;
    paid: boolean; // Exempt, or paid until the period's end plus 2 days
    status: string | null; // active, trialing, past_due, canceled...; null before the first payment
    renewing: boolean; // Alive in Stripe
    cancel_at_period_end: boolean;
    period_end: string | null;
};

// The platform's hosting price, from Stripe; null when hosting is not charged
export type HostingPrice = { price: number; currency: string; days: number };

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
    billing: HostingBilling;
};

// The platform's view of hosting (TDM_DEV): every terminal, whose it is, and the pods running them
export type AdminHostedTerminal = HostedTerminal & {
    id: number;
    mt5_login: number | null;
    client: { id: number; email: string; name: string | null } | null;
    portfolio: string | null;
    manager: string | null;
};
export type AdminPod = {
    id: number;
    name: string;
    online: boolean;
    last_seen_at: string | null;
    capacity: number;
    running: number;
    assigned: number;
    agent: string | null;
    memory_mb: number | null;
    servers: number;
};
export type AdminHosting = {
    available: boolean;
    charged: boolean; // STRIPE_HOSTING_PRICE_ID is set
    price: HostingPrice | null;
    pods: AdminPod[];
    terminals: AdminHostedTerminal[];
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
    mt5_login: number | null; // null: bought without it, the client connects it next
    max_lots: number;
    is_active: boolean;
    is_paused: boolean;
    paused_at: string | null;
    valid: boolean; // Active and not expired
    expires_at: string | null;
    has_key: boolean;
    key_prefix: string | null;
    settings: { [K in keyof ClientSettings]: ClientSettings[K] | null };
    limits: ClientLimits;
    hosting: {
        server: string; enabled: boolean; state: HostingState; detail: string | null; status_at: string | null; billing: HostingBilling;
    } | null;
    connection: { ea_version: string | null; connected_at: number | null; active: boolean; last_ack_age_s: number | null } | null;
    billing: Billing | null; // Paid in Stripe
    // From a launch code: the free days start when the account is connected (started_at), and end at ends_at
    promo: { free_days: number; started_at: string | null; ends_at: string | null } | null;
    listing_slug: string | null; // The portfolio's page in the marketplace, while it is there
    renew_plans: Plan[]; // What a renewal can be paid with in Stripe; empty when it is paid by hand
};

// A plan of a listing paid in Stripe: the lot limit it buys, at the price Stripe charges
export type Plan = {
    id: number;
    name: string;
    max_lots: number;
    price: number;
    currency: string;
    days: number;
    archived: boolean;
    stripe_price_id?: string; // Only for the listing's manager
};

// How a license is paid in Stripe, and the plans it can change to
export type Billing = {
    subscription_id: number;
    status: string | null; // active, trialing, past_due, canceled...
    renewing: boolean; // Alive in Stripe: no renewal by hand
    cancel_at_period_end: boolean;
    period_end: string | null;
    plan: Plan | null;
    plans: Plan[];
};

export type DashboardTrader = {
    license_id: number;
    portfolio_id: number;
    portfolio_name: string;
    manager_name: string | null;
    mt5_login: number | null;
    max_lots: number;
    is_active: boolean;
    is_paused: boolean;
    paused_at: string | null;
    valid: boolean;
    expires_at: string | null;
    profit_today: number;
    profit_week: number;
    profit_month: number;
    open_positions: number;
    currency: string; // the copy's own account currency
    trades_count: number;
    strategies: string[];
};

export type RunningStrategy = {
    license_id: number;
    portfolio_name: string;
    manager_name: string | null;
    strategy_name: string;
    magic_number: number | null;
    is_paused: boolean;
    status: string;
    trades_today: number;
    profit_today: number;
    open_positions: number;
    currency: string; // the copy's own account currency
};

export type ClientDashboardData = {
    is_lead: boolean;
    profit_today: number;
    trades_today: number;
    profit_week: number;
    trades_week: number;
    profit_month: number;
    trades_month: number;
    total_profit: number;
    currency: string;
    curve: { t: string; v: number }[];
    running_today: RunningStrategy[];
    traders: DashboardTrader[];
    all_paused: boolean;
    lead_highlights: PublicListing[];
};

export type MyLicenses = {
    hosting_available: boolean; servers: string[]; hosting_price: HostingPrice | null;
    hosting_room: boolean; // The pods have room for one more: without it, hosting is not offered
    licenses: ClientLicense[];
};

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

// capital_source: what return_pct is over (dash-mc: maximum drawdown plus 3 sigma of the portfolio's Monte Carlo on
// the Dash; dash: balance declared on the Dash; account: the Master's balance) or why there is none (accounts,
// currency-mismatch)
export type CapitalSource = 'dash-mc' | 'dash' | 'account' | 'accounts' | 'currency-mismatch' | null;

export type PortfolioPerformance = PerformanceStats & {
    strategies: { id: number | null; name: string | null; trades: number; net: number }[]; // null: homologation trades of no known strategy
    lots: number; // Lots the trades closed
    per_lot: number | null; // Average result per lot: net / lots
    master_login: number | null;
    capital_source: CapitalSource;
    // Trades from before the Master first connected: no client got them, so they are not in the numbers above
    before_mirror: { trades: number; net: number; until: string | null };
    // The Dash live tracking in the track record: the trades that closed before the clients got the first one
    homologation: { trades: number; net: number; verified: number; to: string | null; copy_start: string | null };
};

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

// A portfolio's link to a Trademetric Dash portfolio (the Master's closed trades go to the Dash)
export type DashLink = {
    token_hint: string;
    status: 'active' | 'error'; // error: the Dash refused the token; the Mirror tries again every hour
    last_error: string | null;
    last_sent_at: string | null;
    sent_count: number;
    send_since: string;
    created_at: string;
    backtest: { name: string | null; trades: number; initial_balance: number | null; capital: number | null; currency: string | null } | null;
    backtest_fetched_at: string | null;
    backtest_error: string | null;
};

export type DashLinkState = { available: boolean; link: DashLink | null };

// The backtest declared on the Trademetric Dash, and the live result in its Monte Carlo cone (percent of the account)
export type ConeBand = { k: number; live: number; p5: number; p25: number; p50: number; p75: number; p95: number };

export type BacktestView =
    | { available: false }
    | {
          available: true;
          fetched_at: string | null;
          backtest: {
              trades: number;
              from: string | null;
              to: string | null;
              currency: string | null;
              initial_balance: number | null; // The capital the percentages are over
              capital_basis: 'monte_carlo' | 'declared' | null; // Monte Carlo DD + 3 sigma, or the declared balance
              net: number;
              win_rate: number | null;
              profit_factor: number | null;
              return_pct: number | null;
              max_drawdown_pct: number | null;
              curve: { k: number; v: number }[];
              strategies: string[];
              truncated: boolean;
          };
          // The Dash portfolio's own live tracking frozen by the Mirror, over the same capital; verified: trades that
          // came from OnTick; official: the ones before the first copy, the homologation in the track record
          incubation: (Omit<Extract<BacktestView, { available: true }>['backtest'], 'strategies'> & { verified: number; official: number }) | null;
          cone: { trades: number; simulations: number; bands: ConeBand[]; verdict: 'inside' | 'below' | 'above' } | null;
          cone_missing: 'capital' | 'accounts' | 'balance' | 'currency' | 'no-trades' | 'few-trades' | null;
      };

// The marketplace shows the figures only past a minimum of followers and copies
export type PublicFollowerStats = { enough: boolean; min_followers: number; min_copies: number } & Partial<FollowerStats>;

export type Me = { email: string; name: string | null; role: 'MANAGER' | 'CLIENT' | 'TDM_DEV'; bio: string | null;
    youtube_url: string | null; instagram_url: string | null; email_verified: boolean; email_enabled: boolean };

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
    plans: Plan[]; // Paid in Stripe when there are any; the listing's price is the cheapest
    pay_online: boolean; // Paid in Stripe, approved by the payment
    default_days: number;
    default_max_lots: number;
    min_capital: number | null;
    hosting_allowed: boolean;
    show_backtest: boolean;
    status: 'draft' | 'published' | 'suspended';
    suspended_reason: string | null;
    published_at: string | null;
    updated_at: string | null;
};

export type MyListing = { portfolio: { id: number; name: string; strategies: number }; listing: Listing | null };

// What anyone sees in the marketplace: the last 90 days in stats, the manager's public profile
export type PublicListing = Omit<Listing, 'portfolio_id' | 'status' | 'suspended_reason' | 'default_max_lots'> & {
    manager: { name: string; bio: string | null; youtube_url: string | null; instagram_url: string | null };
    strategies: string[];
    hosting_price?: HostingPrice | null; // On the listing's own page, when it can be hosted and hosting is charged
    hosting_room?: boolean; // On the listing's own page: the pods have room, so the cloud is offered
    has_promo?: boolean; // On the listing's own page: it takes a launch code (never which)
    stats: Pick<PerformanceStats, 'currency' | 'trades' | 'win_rate' | 'net' | 'return_pct' | 'max_drawdown_pct' | 'profit_factor'> & {
        per_lot: number | null; // The average result per lot closed, in the portfolio's currency
        assets: string[]; // What the copy traded, the most lots first (WIN, WDO, EURUSD...); empty without copies
        curve: number[];
    };
};

export type SubscriptionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type Subscription = {
    id: number;
    listing: { id: number; slug: string; title: string; checkout_url: string | null; pay_online: boolean; price: number | null; currency: string; default_days: number };
    mt5_login: number | null;
    kind: 'new' | 'renewal' | 'promo'; // promo: free days from a launch code
    status: SubscriptionStatus;
    note: string | null;
    decision_note: string | null;
    license_id: number | null;
    created_at: string;
    decided_at: string | null;
    plan: Plan | null;
    paid_online: boolean;
    stripe_status: string | null;
    stripe_period_end: string | null;
    stripe_cancel_at_period_end: boolean;
    client?: { name: string | null; email: string }; // Only for the manager
};

export type AdminListing = Listing & { manager: string | null };

// A listing's launch code (promos.py): whoever has it gets the portfolio free for free_days, once
export type PromoCode = {
    id: number;
    code: string;
    label: string | null;
    free_days: number;
    max_uses: number | null; // null: no limit
    uses: number;
    valid_until: string | null;
    active: boolean;
    usable: boolean; // Active, before valid_until and below max_uses
    created_at: string;
    started: number; // Clients who connected an account: their free days are running
    subscribed: number; // Clients who renewed after
};

// Educational area (education.py): Trademetric's own content (official) and each manager's. The video is a link to
// YouTube, Vimeo or Panda Video; embed_url is the player. Images are links too: thumbnail is the lesson's own or its
// YouTube video's, else none (the page draws a poster)
export type EduAudience = 'clients' | 'everyone';

export type EduVideo = { provider: 'youtube' | 'vimeo' | 'panda'; embed_url: string };

export type EduLesson = {
    id: number;
    module_id: number;
    title: string;
    summary: string | null;
    video: EduVideo | null;
    thumbnail: string | null;
    body: string | null; // Plain text, shown as written
    minutes: number | null;
    completed?: boolean; // The client's view
    video_url?: string | null; // The manager's view, from here on
    thumbnail_url?: string | null;
    published?: boolean;
    done_by?: number; // How many users marked it done
    updated_at?: string;
};

export type EduManagedModule = {
    id: number;
    title: string;
    description: string | null;
    cover_url: string | null;
    audience: EduAudience;
    published: boolean;
    updated_at: string;
    lessons: EduLesson[];
};

export type EduManagedFaq = { id: number; question: string; answer: string; audience: EduAudience; published: boolean; updated_at: string };

export type EduManage = {
    modules: EduManagedModule[];
    faqs: EduManagedFaq[];
    clients: number;
    platform: boolean; // Trademetric's own content, edited by an admin: always for every client
    official?: { title: string; lessons: string[] }[]; // For a manager: what Trademetric already teaches its clients
};

export type EduModule = {
    id: number;
    title: string;
    description: string | null;
    cover: string | null; // A wide banner
    manager: string;
    official: boolean;
    lessons: EduLesson[];
};

export type EduFaq = { id: number; question: string; answer: string; manager: string; official: boolean };

export type MyEducation = { modules: EduModule[]; faqs: EduFaq[] };
