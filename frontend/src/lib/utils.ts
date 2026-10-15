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

// FastAPI sends `detail` as a string for our own errors and as a list for validation errors
export const apiError = (err: unknown, fallback: string): string => {
    const detail = isAxiosError(err) ? err.response?.data?.detail : undefined;
    return typeof detail === 'string' ? detail : fallback;
};
