import { isAxiosError } from 'axios';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// The API sends naive UTC datetimes: without a zone, Date would read them as local time
export const parseUtc = (value: string) => new Date(/T[\d:.]+$/.test(value) ? `${value}Z` : value);

const toDate = (value: string | number | Date) => (typeof value === 'string' ? parseUtc(value) : new Date(value));

export const formatDate = (value: string | number | Date) =>
    toDate(value).toLocaleDateString('pt-BR');

export const formatTime = (value: string | number | Date) =>
    toDate(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const formatDateTime = (value: string | number | Date) =>
    toDate(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const isPast = (value: string) => parseUtc(value).getTime() <= Date.now();

// "4.01" is older than "4.02". A version that isn't dotted numbers (a test probe) is never called older
export const isOlderVersion = (version: string, latest?: string) => {
    if (!latest || !/^\d+(\.\d+)*$/.test(version) || !/^\d+(\.\d+)*$/.test(latest)) return false;
    const a = version.split('.').map(Number);
    const b = latest.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff < 0;
    }
    return false;
};

// As the hub sees it: a revoked or expired license opens nothing new and keeps managing what was open
export const licenseIsValid = (license: { is_active: boolean; expires_at: string | null }) =>
    license.is_active && (license.expires_at == null || !isPast(license.expires_at));

// "agora", "há 12 s", "há 5 min", "há 3 h", "há 2 dias"
export const formatAgo = (seconds: number) => {
    if (seconds < 1) return 'agora';
    if (seconds < 60) return `há ${Math.floor(seconds)} s`;
    if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `há ${Math.floor(seconds / 3600)} h`;
    const days = Math.floor(seconds / 86400);
    return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
};

// A ?next= the login and sign-up pages go back to: only a path of this site, never another origin
export const safeNext = (next: string | null, fallback: string) =>
    next && /^\/(?![/\\])/.test(next) ? next : fallback;

// FastAPI sends `detail` as a string for our own errors and as a list for validation errors
export const apiError = (err: unknown, fallback: string): string => {
    const detail = isAxiosError(err) ? err.response?.data?.detail : undefined;
    return typeof detail === 'string' ? detail : fallback;
};

// <input type="date"> works in local days: a date chosen there lasts through its whole day
export const toDayInput = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const endOfDay = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d, 23, 59, 59).toISOString();
};
