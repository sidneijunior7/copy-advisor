import type { EduAudience } from '../api';

// A link the API can turn into a player; the API has the exact rules and says when a link is not one
export const VIDEO_URL = /^https:\/\/((www\.|m\.)?youtube\.com|youtu\.be|(www\.)?vimeo\.com|player\.vimeo\.com|player-vz-[a-z0-9-]+\.tv\.pandavideo\.com(\.br)?)\/\S+$/;

export const AUDIENCES: Record<EduAudience, { label: string; hint: string }> = {
    clients: { label: 'Só meus clientes', hint: 'Quem tem ou já teve uma licença sua.' },
    everyone: { label: 'Todos os usuários', hint: 'Qualquer cliente do Mirror, mesmo sem licença sua, por exemplo antes de assinar.' },
};

export const minutesLabel = (minutes: number | null | undefined) => (minutes ? `${minutes} min` : null);
