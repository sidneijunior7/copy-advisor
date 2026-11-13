import { AlertTriangle } from 'lucide-react';

// DRAFT: placeholders until the lawyers send the final texts. The sign-up links here (TermsNotice), so the routes
// must exist; the banner says plainly that these are not the final terms
function Draft({ title, sections }: { title: string; sections: { heading: string; body: string }[] }) {
    return (
        <article className="mx-auto max-w-3xl space-y-6">
            <div role="note" className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <p><strong>Rascunho.</strong> Este texto ainda está em revisão jurídica e será substituído pela versão final.</p>
            </div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            {sections.map(s => (
                <section key={s.heading} className="space-y-2">
                    <h2 className="text-lg font-semibold">{s.heading}</h2>
                    <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                </section>
            ))}
        </article>
    );
}

export function TermsPage() {
    return (
        <Draft
            title="Termos de Uso"
            sections={[
                { heading: '1. O que é o Trademetric Mirror', body: 'Uma plataforma que replica, na conta MetaTrader 5 do cliente, as operações dos portfólios publicados pelos gestores no marketplace.' },
                { heading: '2. Riscos', body: 'Operar no mercado financeiro envolve risco de perda, inclusive maior que o capital informado. Resultados passados não garantem resultados futuros. A cópia replica as operações do gestor na conta do cliente.' },
                { heading: '3. Assinatura e cancelamento', body: 'A assinatura renova automaticamente a cada período do plano e pode ser cancelada a qualquer momento em Minha conta → Assinaturas, valendo até o fim do período pago.' },
                { heading: '4. Responsabilidades', body: '[A definir pelo jurídico: responsabilidades do cliente, do gestor e da Trademetric; execução pela corretora; disponibilidade do serviço.]' },
                { heading: '5. Contato', body: '[A definir: canal oficial de atendimento.]' },
            ]}
        />
    );
}

export function PrivacyPage() {
    return (
        <Draft
            title="Política de Privacidade"
            sections={[
                { heading: '1. Dados que coletamos', body: 'Email, nome, CPF, a corretora informada e os números das contas MetaTrader 5 conectadas, além das operações copiadas.' },
                { heading: '2. Para que usamos', body: 'Identificar o titular da assinatura, liberar e acompanhar a cópia, cobrar o plano e enviar avisos sobre a conta. O CPF não é compartilhado com o gestor.' },
                { heading: '3. Emails sobre a simulação', body: 'Quem informa o email no checkout e não conclui a assinatura recebe a simulação e um lembrete. Todo email traz um link para parar de receber.' },
                { heading: '4. Seus direitos (LGPD)', body: '[A definir pelo jurídico: acesso, correção, exclusão, portabilidade e o canal do encarregado de dados.]' },
            ]}
        />
    );
}
