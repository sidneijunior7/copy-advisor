import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, Plug, Search, ShieldCheck, Wallet } from 'lucide-react';
import { Button } from '../ui/Button';

const STEPS = [
    { icon: Search, title: 'Escolha um gestor', text: 'Compare o resultado real, a maior queda e o que os seguidores conseguiram.' },
    { icon: Wallet, title: 'Assine', text: 'No cartão, mês a mês. Sem fidelidade: cancele quando quiser.' },
    { icon: Plug, title: 'Conecte sua conta', text: 'As operações do gestor chegam sozinhas no seu MetaTrader 5.' },
];

// For a visitor who has never copied anyone: what happens, in three steps, and what they need before paying
export function HowItWorks() {
    return (
        <section className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card p-5 sm:p-8">
            <div className="max-w-2xl space-y-2">
                <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
                    As operações de gestores reais, copiadas automaticamente na sua conta
                </h1>
                <p className="text-sm text-muted-foreground sm:text-base">
                    Você escolhe quem copiar. Quando o gestor compra ou vende, a mesma ordem é feita na sua conta da corretora,
                    no tamanho que você definir.
                </p>
            </div>
            <ol className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {STEPS.map(({ icon: Icon, title, text }, i) => (
                    <li key={title} className="flex gap-3 rounded-xl border border-border bg-card/80 p-3 sm:flex-col sm:p-4">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></span>
                        <span>
                            <span className="block text-sm font-semibold">{i + 1}. {title}</span>
                            <span className="block text-xs text-muted-foreground">{text}</span>
                        </span>
                    </li>
                ))}
            </ol>
            <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                <span>
                    Você precisa de uma <strong className="text-foreground">conta MetaTrader 5 numa corretora</strong>. O dinheiro fica nela, em seu nome:
                    o gestor só envia as ordens e nunca movimenta saques ou depósitos.
                </span>
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <a href="#gestores"><Button size="lg" className="w-full sm:w-auto">Ver gestores <ArrowRight /></Button></a>
                <a href="#duvidas"><Button size="lg" variant="ghost" className="w-full sm:w-auto">Dúvidas frequentes</Button></a>
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
