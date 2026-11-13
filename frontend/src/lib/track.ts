// The funnel's events for Google Tag Manager. Never anything that identifies a person (email, name, CPF): only what
// was chosen. Without GTM on the page the events just pile up in an array nobody reads, and nothing breaks
type TrackValue = string | number | boolean | null | undefined;

declare global {
    interface Window { dataLayer?: Record<string, unknown>[] }
}

export function track(event: string, params: Record<string, TrackValue> = {}) {
    try {
        window.dataLayer = window.dataLayer ?? [];
        window.dataLayer.push({ event, ...params });
    } catch {
        // Tracking must never break the page
    }
}
