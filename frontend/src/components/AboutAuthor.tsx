import { useRef } from 'react';
import { Instagram, UserRound, X, Youtube } from 'lucide-react';
import type { PublicListing } from '../api';
import { Button } from './ui/Button';

type Manager = PublicListing['manager'];

// The manager's networks as icons; the API only accepts YouTube and Instagram addresses
export function AuthorLinks({ manager }: { manager: Manager }) {
    const links = [
        { url: manager.youtube_url, label: 'YouTube', icon: <Youtube /> },
        { url: manager.instagram_url, label: 'Instagram', icon: <Instagram /> },
    ].filter(l => l.url);
    if (links.length === 0) return null;
    return (
        <div className="flex gap-2">
            {links.map(l => (
                <a
                    key={l.label}
                    href={l.url!}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    aria-label={`${l.label} de ${manager.name}`}
                    title={l.label}
                    className="flex size-10 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary [&_svg]:size-4"
                >
                    {l.icon}
                </a>
            ))}
        </div>
    );
}

// The manager's presentation in a modal, to keep the page short on phones: a sheet from the bottom there, centered from sm up
export default function AboutAuthor({ manager }: { manager: Manager }) {
    const dialog = useRef<HTMLDialogElement>(null);
    return (
        <>
            <Button type="button" size="sm" variant="outline" onClick={() => dialog.current?.showModal()}>
                <UserRound /> Sobre o autor
            </Button>
            <dialog
                ref={dialog}
                aria-labelledby="about-author-title"
                // A click on the backdrop lands on the dialog itself, outside its content
                onClick={e => { if (e.target === dialog.current) dialog.current.close(); }}
                className="mb-0 mt-auto w-full max-w-none rounded-t-2xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/60 sm:m-auto sm:max-w-lg sm:rounded-2xl"
            >
                <div className="max-h-[80vh] space-y-4 overflow-y-auto p-5">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-xs uppercase tracking-wider text-muted-foreground">Sobre o autor</p>
                            <h2 id="about-author-title" className="mt-1 text-lg font-semibold">{manager.name}</h2>
                        </div>
                        <Button type="button" size="icon" variant="ghost" onClick={() => dialog.current?.close()} aria-label="Fechar">
                            <X />
                        </Button>
                    </div>
                    {manager.bio
                        ? <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{manager.bio}</p>
                        : <p className="text-sm text-muted-foreground">O gestor ainda não escreveu uma apresentação.</p>}
                    <AuthorLinks manager={manager} />
                </div>
            </dialog>
        </>
    );
}
