import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, Pause, Play } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../ui/Button';

// For a visitor who has never copied anyone, edge to edge under the header as in a streaming home: the video
// behind, the pitch over its left side and fading into the page below. There is no dark cut of the video yet,
// so the dark theme dims the light one
export function HowItWorks() {
    const video = useRef<HTMLVideoElement>(null);
    const [playing, setPlaying] = useState(true);
    // It loops for good, so anyone can stop it (WCAG 2.2.2)
    const toggle = () => {
        const v = video.current;
        if (!v) return;
        if (v.paused) void v.play();
        else v.pause();
    };
    return (
        <section className="relative left-1/2 -mt-6 w-screen -translate-x-1/2 overflow-hidden sm:-mt-8">
            <div className="relative aspect-video w-full md:aspect-auto md:h-[72vh] md:max-h-[720px] md:min-h-[480px]">
                <video
                    ref={video}
                    src="/video_1.mp4"
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="auto"
                    aria-hidden="true"
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    className="absolute inset-0 size-full object-cover dark:brightness-[.45] dark:contrast-125 dark:saturate-[.85]"
                />
                {/* The left side clears for the text from md up; the bottom always melts into the page */}
                <div className="absolute inset-0 hidden bg-gradient-to-r from-background via-background/85 to-transparent md:block md:w-2/3" />
                <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-background to-transparent" />
                <button
                    type="button"
                    onClick={toggle}
                    aria-label={playing ? 'Pausar o vídeo' : 'Tocar o vídeo'}
                    className="absolute bottom-3 right-3 z-10 flex size-9 items-center justify-center rounded-full border border-border bg-card/80 text-foreground backdrop-blur transition-colors hover:bg-card md:bottom-[18%] md:right-6"
                >
                    {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                </button>
            </div>
            <div className="pointer-events-none relative mx-auto max-w-6xl px-4 md:absolute md:inset-0 md:flex md:items-center">
                <div className="pointer-events-auto -mt-6 max-w-xl space-y-3 md:mt-0">
                    <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
                        As operações de gestores reais, copiadas automaticamente na sua conta
                    </h1>
                    <p className="text-sm text-muted-foreground sm:text-base">
                        Você escolhe quem copiar. Quando o gestor compra ou vende, a mesma ordem é feita na sua conta da corretora,
                        no tamanho que você definir.
                    </p>
                    <div className="flex gap-2 pt-2 [&>a]:flex-1 sm:[&>a]:flex-none [&_button]:px-3 [&_button]:text-sm sm:[&_button]:px-8 sm:[&_button]:text-base">
                        <a href="#gestores"><Button size="lg" className="w-full sm:w-auto">Ver gestores <ArrowRight /></Button></a>
                        <a href="#duvidas"><Button size="lg" variant="ghost" className="w-full sm:w-auto">Dúvidas frequentes</Button></a>
                    </div>
                </div>
            </div>
        </section>
    );
}

const FAQ = [
    {
        q: 'Posso perder dinheiro?',
        a: 'Sim. A cópia repete as operações do gestor, e elas podem dar prejuízo. Veja a "Maior queda" de cada gestor: é o quanto a conta dele já caiu do topo. Comece com um valor que você aceita ver oscilar.',
    },
    {
        q: 'Do que eu preciso para começar?',
        a: 'De uma conta MetaTrader 5 numa corretora, com saldo. Depois de assinar, você informa o número da conta e escolhe como copiar: na nossa nuvem, sem instalar nada, ou com o EA no seu computador.',
    },
    {
        q: 'Preciso deixar o computador ligado?',
        a: 'Só se escolher copiar pelo seu computador. Com a hospedagem na nuvem, o MetaTrader roda num servidor nosso, ligado o tempo todo, por uma assinatura mensal à parte, por conta.',
    },
    {
        q: 'O gestor tem acesso ao meu dinheiro?',
        a: 'Não. O dinheiro fica na sua corretora, em seu nome. O gestor só envia as ordens de compra e venda; depósitos e saques continuam só com você.',
    },
    {
        q: 'Posso parar ou cancelar?',
        a: 'Quando quiser. Uma chave no painel pausa a cópia na hora, e a assinatura se cancela em Pagamentos: ela vale até o fim do período pago e não renova mais.',
    },
    {
        q: 'Qual plano escolher?',
        a: 'O plano define o tamanho máximo de cada ordem copiada, em lotes (contratos). Para começar, o menor plano costuma bastar; dá para trocar depois, e a diferença é proporcional.',
    },
];

// The questions a newcomer asks before paying, answered where they decide
export function Faq() {
    return (
        <section id="duvidas" className="scroll-mt-24 space-y-3">
            <h2 className="text-xl font-semibold">Dúvidas frequentes</h2>
            <div className="divide-y divide-border rounded-xl border border-border bg-card">
                {FAQ.map(({ q, a }) => (
                    <details key={q} className="group">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium">
                            {q}
                            <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" />
                        </summary>
                        <p className="px-4 pb-4 text-sm text-muted-foreground">{a}</p>
                    </details>
                ))}
            </div>
            <p className="text-center text-sm text-muted-foreground">
                Pronto para começar? <Link to="/cadastro" className="font-medium text-primary underline-offset-4 hover:underline">Crie sua conta em 10 segundos</Link>
            </p>
        </section>
    );
}
