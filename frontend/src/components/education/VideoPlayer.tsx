import { type EduVideo } from '../../api';

// The lesson's video in its own player (YouTube, Vimeo or Panda Video), 16:9 at any width
export default function VideoPlayer({ video, title }: { video: EduVideo; title: string }) {
    return (
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
            <iframe
                src={video.embed_url}
                title={title}
                className="absolute inset-0 h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                loading="lazy"
            />
        </div>
    );
}
