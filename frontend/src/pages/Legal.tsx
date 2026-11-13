import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PRIVACY_PATH, TERMS_PATH } from '../components/TermsNotice';
import { COMPANY, LEGAL_DATE, LEGAL_VERSION } from '../lib/company';

// The Terms of Use and the Privacy Policy. The policy says what privacy.py (API) does with each kind of data and for
// how long: change one, change the other, and bump LEGAL_VERSION so that who signs up next accepts the new text

const link = 'font-medium text-primary underline-offset-4 hover:underline';
const Mail = () => <a href={`mailto:${COMPANY.email}`} className={link}>{COMPANY.email}</a>;

function LegalDoc({ title, children }: { title: string; children: ReactNode }) {
    return (
        <article className="mx-auto max-w-3xl space-y-8">
            <header className="space-y-1">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
                <p className="text-sm text-muted-foreground">Versão {LEGAL_VERSION}, de {LEGAL_DATE}.</p>
            </header>
            {children}
        </article>
    );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
    return (
        <section className="space-y-3">
            <h2 className="text-lg font-semibold">{n}. {title}</h2>
            <div className="space-y-3 text-sm leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
                {children}
            </div>
        </section>
    );
}

function List({ children }: { children: ReactNode }) {
    return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

export function PrivacyPage() {
    return (
        <LegalDoc title="Política de Privacidade">
            <Section n={1} title="Quem somos">
                <p>
                    O Trademetric Mirror é operado por <strong>{COMPANY.legalName}</strong>, CNPJ {COMPANY.cnpj}, com sede na
                    {' '}{COMPANY.address} ("Trademetric"). Somos o controlador dos dados pessoais tratados na plataforma, nos
                    termos da Lei Geral de Proteção de Dados (Lei 13.709/2018).
                </p>
                <p>Para qualquer assunto sobre os seus dados, escreva para <Mail />. É o nosso canal de atendimento ao titular.</p>
            </Section>

            <Section n={2} title="Quais dados tratamos e para quê">
                <List>
                    <li><strong>Cadastro:</strong> e-mail, nome e senha. Guardamos só um código derivado da senha, não a senha. Usamos para criar a sua conta, permitir o acesso e enviar avisos sobre ela.</li>
                    <li><strong>CPF:</strong> para identificar o titular da assinatura e impedir mais de uma conta por pessoa. Não é mostrado ao responsável pelo portfólio.</li>
                    <li><strong>Conta de negociação:</strong> o número da sua conta MetaTrader 5, o servidor da corretora e, se você informar, a corretora e a assessoria. Usamos para liberar e configurar a cópia.</li>
                    <li><strong>Senha de negociação da conta MetaTrader 5:</strong> só se você contratar a execução na nuvem. É guardada cifrada e usada apenas para manter o seu terminal conectado. É apagada quando você remove a hospedagem ou encerra a conta; se você apenas pausar a nuvem, ela continua guardada.</li>
                    <li><strong>Operações e saldo:</strong> cada ordem copiada na sua conta (volume, preço, resultado e eventuais erros) e o saldo e o patrimônio da conta, registrados por hora enquanto ela está conectada. Usamos para executar a cópia no tamanho que você definiu, mostrar o seu desempenho e prestar suporte.</li>
                    <li><strong>Pagamento:</strong> o pagamento é processado pela Stripe. Não recebemos nem guardamos os dados do seu cartão. Guardamos o identificador do pagamento e a situação da assinatura.</li>
                    <li><strong>Simulação no checkout:</strong> se você informar o e-mail antes de criar a conta, guardamos o e-mail e o plano simulado para enviar a simulação e, uma vez, um lembrete. Todo e-mail traz um link para parar de receber.</li>
                    <li><strong>Registros de aceite:</strong> a data, a versão do texto e o endereço IP de quando você aceitou os Termos de Uso e esta Política, e a data em que confirmou a ciência dos riscos.</li>
                    <li><strong>Registros de acesso:</strong> endereço IP, data e hora do cadastro, de cada login e da renovação da sessão, por segurança e por exigência legal.</li>
                    <li><strong>Área Educacional:</strong> as aulas que você marcou como concluídas.</li>
                </List>
                <p>Não pedimos dados sensíveis, como os de saúde, origem racial, religião ou biometria.</p>
            </Section>

            <Section n={3} title="Com que fundamento">
                <p>Tratamos os seus dados com base na LGPD (art. 7º):</p>
                <List>
                    <li>para <strong>executar o contrato</strong> de assinatura e os passos anteriores a ele, pedidos por você, como o envio da simulação;</li>
                    <li>para <strong>cumprir obrigações legais e regulatórias</strong>, como a guarda dos registros de acesso;</li>
                    <li>para o <strong>exercício regular de direitos</strong>, guardando os registros de aceite e das operações;</li>
                    <li>com base no nosso <strong>legítimo interesse</strong>, na prevenção a fraudes, no suporte e no lembrete da simulação, sempre com a possibilidade de você se opor.</li>
                </List>
                <p>Usamos o consentimento apenas onde ele é pedido de forma expressa.</p>
            </Section>

            <Section n={4} title="Com quem compartilhamos">
                <List>
                    <li><strong>O responsável pelo portfólio que você assina</strong> (chamado de gestor na plataforma) vê o seu nome, o seu e-mail, o número da sua conta MetaTrader 5, a situação da sua licença e da conexão, e as cópias que falharam nessa conta. Não vê o seu CPF, a sua senha nem o seu saldo.</li>
                    <li><strong>Prestadores de serviço</strong> que tratam dados em nosso nome: a Supabase, que hospeda o banco de dados em São Paulo; a Stripe, que processa os pagamentos; e serviços de hospedagem de servidores, de envio de e-mails e de monitoramento técnico.</li>
                    <li><strong>Autoridades</strong>, como a Comissão de Valores Mobiliários, a Autoridade Nacional de Proteção de Dados e o Poder Judiciário, quando houver obrigação legal ou ordem.</li>
                    <li><strong>Estatísticas públicas:</strong> a página de um portfólio pode mostrar como os seguidores copiaram, sempre de forma agregada e só a partir de um número mínimo de contas, sem identificar ninguém.</li>
                </List>
                <p>Não vendemos dados pessoais.</p>
            </Section>

            <Section n={5} title="Transferência para fora do Brasil">
                <p>
                    Alguns prestadores tratam dados fora do Brasil, em especial a Stripe, que processa os pagamentos. Essas
                    transferências se apoiam nos contratos de proteção de dados desses prestadores. Você pode pedir informações
                    sobre elas pelo canal da seção 1.
                </p>
            </Section>

            <Section n={6} title="Por quanto tempo guardamos">
                <List>
                    <li><strong>Enquanto a sua conta existir:</strong> os dados de cadastro, a conta de negociação, as operações, o saldo, os pagamentos e os registros de aceite.</li>
                    <li><strong>Quando a conta é encerrada:</strong> a senha, a senha de negociação, as aulas concluídas e as simulações são apagadas na hora. A sua identificação e os registros de aceite, de assinatura, de operações e de saldo ficam arquivados por <strong>5 anos</strong>, para cumprir obrigações e para defesa em eventual processo, e depois são eliminados.</li>
                    <li><strong>Senha de negociação:</strong> até você remover a hospedagem na nuvem.</li>
                    <li><strong>E-mail e simulação de quem não criou conta:</strong> 30 dias.</li>
                    <li><strong>Registros de acesso:</strong> 6 meses.</li>
                </List>
            </Section>

            <Section n={7} title="Seus direitos">
                <p>
                    Você pode, a qualquer momento e sem custo: confirmar se tratamos os seus dados e acessá-los; corrigir dados
                    incompletos ou desatualizados; pedir a anonimização, o bloqueio ou a eliminação do que for desnecessário ou
                    excessivo; pedir a portabilidade; saber com quem compartilhamos; se opor a um tratamento; e revogar um
                    consentimento.
                </p>
                <List>
                    <li>Na página <strong>Pagamentos</strong> da sua conta, você baixa uma cópia dos seus dados e pede o encerramento da conta.</li>
                    <li>Para os demais pedidos, escreva para <Mail />.</li>
                </List>
                <p>
                    Respondemos em até 15 dias. Alguns dados não podem ser apagados enquanto durar uma obrigação legal de guarda.
                    Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).
                </p>
            </Section>

            <Section n={8} title="Como protegemos">
                <p>
                    A conexão com a plataforma é cifrada. A senha de acesso é guardada de forma que não pode ser lida, e a senha
                    de negociação é cifrada com uma chave mantida fora do banco de dados. O acesso interno é restrito a quem
                    precisa.
                </p>
                <p>
                    Nenhum sistema é imune a falhas. Se ocorrer um incidente que possa causar risco ou dano relevante a você,
                    avisaremos você e a ANPD nos prazos da regulamentação.
                </p>
            </Section>

            <Section n={9} title="Cookies e armazenamento no navegador">
                <p>
                    Não usamos cookies de publicidade nem de medição de audiência. Guardamos no seu navegador apenas o necessário
                    para o site funcionar: a sua sessão, o tema escolhido e o rascunho do checkout.
                </p>
                <p>
                    As aulas em vídeo são exibidas por serviços de terceiros (YouTube, Vimeo ou Panda Video), que podem usar
                    cookies próprios quando você reproduz um vídeo. Se passarmos a medir a audiência, pediremos o seu
                    consentimento antes.
                </p>
            </Section>

            <Section n={10} title="Decisões automatizadas">
                <p>
                    A cópia das operações é automática, mas segue apenas o portfólio e os limites que você escolheu, e você pode
                    pausá-la a qualquer momento. Não tomamos decisões automatizadas com base no seu perfil.
                </p>
            </Section>

            <Section n={11} title="Menores de idade">
                <p>A plataforma é destinada a maiores de 18 anos. Não tratamos, de forma intencional, dados de crianças e adolescentes.</p>
            </Section>

            <Section n={12} title="Alterações">
                <p>
                    Podemos atualizar esta política. Mudanças relevantes serão avisadas por e-mail ou na plataforma antes de
                    entrarem em vigor. A versão e a data ficam no topo desta página. Veja também os{' '}
                    <Link to={TERMS_PATH} className={link}>Termos de Uso</Link>.
                </p>
            </Section>
        </LegalDoc>
    );
}

export function TermsPage() {
    return (
        <LegalDoc title="Termos de Uso">
            <Section n={1} title="Quem somos">
                <p>
                    O Trademetric Mirror ("Mirror") é operado por <strong>{COMPANY.legalName}</strong>, CNPJ {COMPANY.cnpj},
                    com sede na {COMPANY.address} ("Trademetric"). Atendimento: <Mail />.
                </p>
                <p>Ao criar uma conta, você declara que leu e aceita estes Termos e a <Link to={PRIVACY_PATH} className={link}>Política de Privacidade</Link>.</p>
            </Section>

            <Section n={2} title="O que é o serviço">
                <p>
                    O Mirror replica, na sua conta MetaTrader 5, as operações de um portfólio de estratégias que você escolhe na
                    plataforma. A cópia é automática: quando o responsável pelo portfólio abre ou fecha uma operação, a mesma
                    ordem é enviada à sua conta, no limite de contratos do seu plano.
                </p>
                <List>
                    <li><strong>Você decide:</strong> qual portfólio copiar, o plano, o tamanho, quando pausar e quando parar.</li>
                    <li><strong>A execução é da sua corretora:</strong> o Mirror envia a ordem, e é a corretora que a aceita, recusa e liquida.</li>
                    <li><strong>A Trademetric não é corretora e não guarda o seu dinheiro:</strong> não recebe depósitos, não faz saques nem transferências da sua conta.</li>
                    <li><strong>Não é recomendação personalizada:</strong> não avaliamos o seu perfil, os seus objetivos nem a sua situação financeira. Avalie se o serviço é adequado para você.</li>
                </List>
            </Section>

            <Section n={3} title="Quem pode usar">
                <List>
                    <li>Maiores de 18 anos, com CPF próprio.</li>
                    <li>Titulares da conta MetaTrader 5 que será usada, em corretora de sua escolha.</li>
                    <li>Uma conta no Mirror por pessoa, com dados verdadeiros e atualizados.</li>
                </List>
                <p>Você é responsável por guardar a sua senha e pelo que for feito com a sua conta.</p>
            </Section>

            <Section n={4} title="Como a cópia funciona e os seus limites">
                <List>
                    <li><strong>Preço e horário diferentes:</strong> a sua ordem é enviada depois da original e pode ser executada a outro preço. O resultado da sua conta não será igual ao do portfólio copiado.</li>
                    <li><strong>Ordens que não saem:</strong> a corretora pode recusar uma ordem, e a conta pode não ter margem. Nesses casos a cópia não é feita, ou é feita em tamanho menor.</li>
                    <li><strong>No seu computador:</strong> o MetaTrader 5 precisa ficar aberto e conectado. Se o computador desligar, hibernar ou perder a internet, a sua conta deixa de receber as ordens, inclusive as de saída.</li>
                    <li><strong>Na nuvem:</strong> o terminal roda em servidores da Trademetric, com a senha de negociação que você fornece. Você pode pausar ou remover a hospedagem quando quiser, e trocar a senha na corretora encerra o nosso acesso.</li>
                    <li><strong>Licença encerrada ou pausada:</strong> a cópia deixa de abrir operações novas. As que estiverem abertas continuam seguindo o portfólio até fechar.</li>
                </List>
            </Section>

            <Section n={5} title="Riscos">
                <List>
                    <li><strong>Você pode perder dinheiro.</strong> Em mercados alavancados, como os de contratos futuros, a perda pode ser maior que o capital depositado.</li>
                    <li><strong>O mercado é volátil</strong> e pode mudar depressa, sobretudo em períodos de instabilidade.</li>
                    <li><strong>Resultados passados não garantem resultados futuros.</strong> Os números exibidos e as simulações do checkout são históricos, anteriores a custos como corretagem, emolumentos, slippage e a mensalidade.</li>
                    <li><strong>Cada portfólio tem os seus riscos.</strong> A página do portfólio mostra o histórico, a maior queda e o capital sugerido pelo responsável. Leia antes de assinar.</li>
                    <li><strong>Sobre os portfólios:</strong> eles são desenvolvidos e operados pela própria Trademetric. O histórico exibido é o registrado na plataforma e não é garantia de resultado.</li>
                </List>
            </Section>

            <Section n={6} title="Planos, pagamento e cancelamento">
                <List>
                    <li><strong>Preço:</strong> o do plano escolhido, mostrado antes do pagamento. A execução na nuvem é opcional e cobrada à parte, quando você conecta a conta.</li>
                    <li><strong>Renovação:</strong> a assinatura se renova automaticamente a cada período, com cobrança no meio de pagamento cadastrado na Stripe.</li>
                    <li><strong>Cancelamento:</strong> você cancela quando quiser na página Pagamentos, sem multa. O acesso continua até o fim do período já pago.</li>
                    <li><strong>Arrependimento:</strong> você pode desistir da contratação em até 7 dias, contados da compra, e receber de volta o valor pago. Basta pedir por <Mail />.</li>
                    <li><strong>Códigos de lançamento:</strong> dão acesso gratuito por um período, uma vez por pessoa e por portfólio, contado a partir da conexão da conta.</li>
                    <li><strong>Mudança de preço:</strong> será avisada com antecedência e vale a partir da renovação seguinte.</li>
                </List>
            </Section>

            <Section n={7} title="O que não é permitido">
                <List>
                    <li>Usar conta MetaTrader 5 de outra pessoa ou compartilhar a sua licença.</li>
                    <li>Revender, redistribuir ou divulgar os sinais e as operações copiadas.</li>
                    <li>Copiar, modificar ou fazer engenharia reversa do software do Mirror.</li>
                    <li>Usar o serviço para fraude, manipulação de mercado ou qualquer fim ilegal.</li>
                </List>
            </Section>

            <Section n={8} title="Disponibilidade e responsabilidade">
                <p>
                    Trabalhamos para manter o serviço disponível e avisamos quando houver manutenção, mas não prometemos
                    funcionamento ininterrupto.
                </p>
                <p>
                    A Trademetric não responde pelo resultado das operações, pelas decisões de quem opera o portfólio copiado,
                    por atos ou falhas da corretora, nem por falhas do seu computador, da sua internet ou de configurações feitas
                    por você.
                </p>
                <p>Nada nestes Termos afasta os direitos que a lei garante ao consumidor.</p>
            </Section>

            <Section n={9} title="Suspensão e encerramento">
                <p>
                    Você pode encerrar a sua conta quando quiser, pela página Pagamentos ou por <Mail />. Podemos suspender ou
                    encerrar uma conta que descumpra estes Termos ou a lei, com aviso e com a devolução do que tiver sido pago e
                    não usado, quando for o caso.
                </p>
            </Section>

            <Section n={10} title="Propriedade intelectual">
                <p>
                    O software, a marca e o conteúdo do Mirror pertencem à Trademetric ou a quem os licenciou. A assinatura dá a
                    você o direito de usar o serviço, pessoal e intransferível, enquanto ela durar.
                </p>
            </Section>

            <Section n={11} title="Alterações destes Termos">
                <p>
                    Podemos atualizar estes Termos. Mudanças relevantes serão avisadas por e-mail ou na plataforma antes de
                    entrarem em vigor. Se você não concordar, pode cancelar a assinatura.
                </p>
            </Section>

            <Section n={12} title="Lei e foro">
                <p>Estes Termos seguem a lei brasileira. Fica eleito o foro do domicílio do consumidor.</p>
            </Section>
        </LegalDoc>
    );
}
