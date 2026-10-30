import type { EduAudience } from '../api';

// A link the API can turn into a player; the API has the exact rules and says when a link is not one
export const VIDEO_URL = /^https:\/\/((www\.|m\.)?youtube\.com|youtu\.be|(www\.)?vimeo\.com|player\.vimeo\.com|player-vz-[a-z0-9-]+\.tv\.pandavideo\.com(\.br)?)\/\S+$/;

export const IMAGE_URL = /^https:\/\/[^\s/?#]+\.[^\s/?#]+\/\S*$/;

export const AUDIENCES: Record<EduAudience, { label: string; hint: string }> = {
    clients: { label: 'Só meus clientes', hint: 'Quem tem ou já teve uma licença sua.' },
    everyone: { label: 'Todos os usuários', hint: 'Qualquer cliente do Mirror, mesmo sem licença sua, por exemplo antes de assinar.' },
};

export const minutesLabel = (minutes: number | null | undefined) => (minutes ? `${minutes} min` : null);

// A drawn poster for a lesson or a module without an image. Each module keeps its own colors, so its lessons read
// as one series
export const drawnBackground = (seed: number) => {
    const h = (seed * 47 + 162) % 360;
    return `radial-gradient(120% 90% at 85% 10%, hsl(${h} 70% 38% / 0.9), transparent 60%), linear-gradient(135deg, hsl(${h} 55% 22%), hsl(${(h + 40) % 360} 60% 8%))`;
};
