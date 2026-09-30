import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export const formatDate = (value: string | number | Date) =>
    new Date(value).toLocaleDateString('pt-BR');

export const formatTime = (value: string | number | Date) =>
    new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// FastAPI sends `detail` as a string for our own errors and as a list for validation errors
export const apiError = (err: any, fallback: string): string => {
    const detail = err?.response?.data?.detail;
    return typeof detail === 'string' ? detail : fallback;
};
