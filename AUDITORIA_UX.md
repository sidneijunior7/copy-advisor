# Auditoria de UX e funil: cliente leigo no Mirror

26/10/2026. Esta auditoria avalia o caminho de quem nunca usou copy trade, desde chegar ao site até a primeira operação copiada na conta. Ela se baseia na leitura do código do frontend (hub-v3, commit 7ff8085). Ainda não houve observação de usuários nem análise de métricas. Por isso, as prioridades abaixo são hipóteses a validar com a medição da §5.

**Resumo:** a compra está bem resolvida. O funil perde gente em três pontos:

1. **Antes da compra**, ninguém explica o que é copy trade, o que é preciso ter para usar e quanto custa no total.
2. **Depois da compra**, o cliente cai numa tela técnica: conta MT5, chave, EA, pasta de dados, WebRequest. A hospedagem, que elimina tudo isso, aparece como um extra, e não como o caminho fácil.
3. **No painel**, o cliente vê "Copiando" mesmo quando nada está conectado. Isso destrói a confiança na primeira semana, que é quando ele decide se cancela.

---

## 1. O funil hoje

| # | Etapa | Onde | O que o leigo encontra |
|---|---|---|---|
| 1 | Chegada | `/` → `/marketplace` | Vai direto ao catálogo: "Estratégias para copiar", filtros e cartões com retorno, queda e lucro por lote |
| 2 | Escolha | `/marketplace/:slug` | Números de 90 dias, desempenho, backtest e seguidores. Caixa com preço, plano e "Copiar esta estratégia" |
| 3 | Cadastro | `/cadastro?next=` | Só email e senha. O painel lateral fala com o **gestor** ("Replique suas estratégias", "Master e Slave", "1 : N") |
| 4 | Pagamento | Stripe Checkout | Volta para `/client/licenses?pagamento=ok` com um toast: "conecte sua conta MT5" |
| 5 | Ativação | `/client/licenses/:id` | Confirmar o email, informar o número da conta. Depois, a oferta de hospedagem e o cartão "EA no seu computador" |
| 6 | Instalação | `/client/install` | 5 passos técnicos no MetaTrader (pasta de dados, WebRequest, chave, arrastar o EA, entradas) |
| 7 | Uso | `/client` | Painel com lucros, traders e o selo "Copiando" |

O cliente dá cerca de 7 telas e 12 decisões até a primeira cópia, e a parte mais difícil (etapas 5 e 6) vem **depois** de ele já ter pago. É ali que nascem os pedidos de reembolso e os chamados de suporte.

---

## 2. Onde acertamos

Isto é para manter:

- **Cadastro mínimo** (`Register.tsx`): só email e senha, e o `next=` devolve o cliente ao anúncio. Está certo para um funil de compra.
- **Comprar antes de informar a conta** (`ListingPage.tsx`, `SubscribeBox`): o cliente não precisa procurar o número da conta para pagar. Isso tira atrito do momento de maior intenção.
- **Números reais e honestos:** "Maior queda" ao lado do retorno, desempenho real, **Como os seguidores copiaram** e o aviso de risco no anúncio e no rodapé. Mostrar o resultado dos seguidores é raro no mercado e é o que mais gera confiança.
- **Barra fixa de compra no celular**, que some quando a caixa de assinatura aparece na tela.
- **Autoatendimento depois da compra:** trocar de plano, cancelar e retomar no próprio Mirror, cartão e faturas na Stripe, e pausar com um clique (`CopyToggle`).
- **Um só estado da cópia** em Minhas licenças (`copyState` em `lib/clientLicense.ts`): "Conecte sua conta", "Vencida", "Desconectado" e "Copiando" vêm do hub e da hospedagem. É o padrão certo, mas falta usá-lo no painel (veja o achado P1).
- **Oferta da hospedagem com preço à vista e letras miúdas claras** ("por conta MT5", "cada conta é uma assinatura").

---

## 3. Achados, por etapa

A prioridade vai de **P1** (perde clientes ou confiança agora) a **P3** (polimento).

### 3.1 Chegada e catálogo

**P1. Não há explicação para quem não sabe o que é copy trade.**
O `/` leva direto ao catálogo. O leigo não sabe o que vai acontecer na conta dele, o que precisa ter (uma conta MT5 numa corretora), quanto capital usar, se pode perder dinheiro nem se pode cancelar.

- **Proposta:** colocar no topo do `/marketplace`, só para visitantes, um bloco curto que some depois do login:
  - **título:** "As operações de gestores reais, copiadas automaticamente na sua conta";
  - **3 passos com ícone:** *Escolha um gestor* → *Assine* → *Conecte sua conta da corretora*;
  - **pré-requisito:** "Você precisa de uma conta MetaTrader 5 numa corretora", com o link "Ainda não tenho conta". Hoje esse pré-requisito não aparece em lugar nenhum antes do pagamento;
  - **FAQ de 5 perguntas no fim da página:** risco, capital mínimo, preciso deixar o computador ligado?, posso cancelar?, o gestor mexe no meu dinheiro? (a resposta é não: ele só envia as ordens).

**P2. A ordenação padrão é "Maior retorno".**
Ela empurra o leigo para o gestor mais arriscado da vitrine, e o primeiro prejuízo vira cancelamento e reclamação.

- **Proposta:** usar como padrão uma ordenação "Recomendados", que leve em conta retorno e queda, ou pelo menos "Menor queda" para quem não está logado.
- **Proposta:** mostrar um selo de risco legível no cartão (*Conservador*, *Moderado*, *Arrojado*), calculado a partir da maior queda.

**P2. Há jargão nos cartões.**
"Lucro por lote" e "Operações" não dizem nada ao leigo. "Retorno 90 dias" e "Maior queda" funcionam.

- **Proposta:** no cartão, deixar retorno, queda e a curva. O lucro por lote vai para a página do anúncio, com uma explicação.

### 3.2 Página do anúncio

**P1. A hospedagem não aparece na hora da compra.**
A linha "Hospedagem: Disponível / EA no seu computador" é a única menção, e "EA" é jargão. O melhor momento do upsell é antes do pagamento ou logo depois dele, não dias depois, dentro da licença.

- **Proposta:** trocar essa linha por um aviso de venda: "Sem instalar nada: + R$ 9,99/mês para rodar na nossa nuvem (opcional, depois do pagamento)". Ela antecipa o custo total, evitando surpresa, e prepara o upsell da §3.4.

**P2. O plano é explicado em lotes.**
O `PlanPicker` mostra "Limite de 2 lotes na cópia", e o leigo não sabe qual plano escolher.

- **Proposta:** acrescentar uma linha de orientação por plano, preenchida pelo gestor ou calculada a partir do capital recomendado: "Para contas de até R$ 5 mil".
- **Proposta:** marcar um plano como **Mais escolhido**.

**P2. O texto dos botões e as referências estão inconsistentes.**
Deslogado, o botão diz "Copiar esta estratégia"; logado, "Assinar e pagar". O texto da caixa diz "cancele quando quiser em **Minhas licenças**", mas isso agora fica em **Assinaturas**.

- **Proposta:** usar "Copiar esta estratégia" nos dois casos, com "Pagamento seguro pela Stripe · cancele quando quiser" embaixo, e corrigir a referência.

**P3. "Sobre a estratégia e o gestor" fica fechado.**
Para o leigo, quem é o gestor é motivo de compra.

- **Proposta:** mostrar a bio resumida, com foto se houver, acima da dobra, e deixar só a descrição longa recolhida.

### 3.3 Cadastro

**P1. O painel lateral fala com o público errado.**
O `AuthShell` diz "Replique suas estratégias em tempo real", "Master e Slave" e "1 : N". É a mensagem para o gestor, mostrada a quem veio comprar.

- **Proposta:** usar uma variante para o cliente no `/cadastro`, ou quando o `next` aponta para o marketplace. Por exemplo: "Copie gestores reais na sua conta", "Cancele quando quiser" e "Seu dinheiro fica na sua corretora".

**P2. A confirmação do email trava no meio do funil.**
O email só é exigido para **conectar a conta**, ou seja, depois de pagar (`ConnectAccount.tsx`). Quem pagou e não acha o email fica preso no passo mais importante.

- **Proposta:** pedir a confirmação logo depois do cadastro, com um código de 6 dígitos na própria tela em vez de um link, ou permitir conectar a conta e cobrar a confirmação mais tarde.

### 3.4 Pagamento e ativação: o maior vazamento

**P1. Depois do pagamento não há uma sequência guiada.**
O cliente volta para a lista de licenças com um toast e precisa descobrir sozinho que deve abrir a licença, confirmar o email, informar a conta e escolher como copiar.

- **Proposta:** criar uma tela de boas-vindas pós-compra (`/client/licenses/:id/ativar`, ou um modo assistente no detalhe), com 3 passos e uma barra de progresso:
  1. **Sua conta da corretora:** o número, com uma imagem mostrando onde encontrá-lo no MT5.
  2. **Como você quer copiar?** Duas opções grandes, lado a lado:

     | ☁️ Automático na nuvem · **Recomendado** | 💻 No meu computador |
     |---|---|
     | R$ 9,99/mês · nada para instalar · funciona com o computador desligado | Grátis · instale o EA · o MetaTrader precisa ficar aberto |
     | Servidor e senha → pagamento | Baixar o EA → passo a passo |

  3. **Pronto:** um estado ao vivo, "Conectando…" e depois "Copiando ✓", com o que acontece em seguida ("na próxima operação do gestor, a cópia aparece aqui").

  Esse é o lugar certo do "por mais R$ 9,99, quer?": uma escolha no momento da ativação, e não um bloco promocional ao lado de um cartão técnico.

**P1. O caminho do EA local é longo demais para um leigo.**
São 5 passos com "pasta de dados", "MQL5\Experts", "WebRequest" e uma URL "sem porta" (`ClientInstall.tsx`). Cada um é um ponto de abandono e de chamado.

- **Proposta:** posicionar esse caminho como **"Avançado"** no assistente.
- **Proposta:** acrescentar um vídeo curto ou GIFs por passo.
- **Proposta:** dar um botão "Copiar a URL".
- **Proposta:** permitir que o EA leia a chave colada uma única vez, se tecnicamente viável.
- **Proposta:** no fim, mostrar uma verificação ao vivo: "Esperando o EA conectar…" e depois "Conectado ✓".

**P2. A senha da conta assusta.**
O cliente leigo hesita em entregar a senha da conta da corretora. Hoje o texto diz "Fica cifrada e ninguém a vê", e isso é bom, mas não basta.

- **Proposta:** acrescentar três garantias perto do campo:
  - "Usamos só para abrir o MetaTrader no nosso servidor";
  - "Saques continuam só com você, na corretora";
  - "Trocou a senha na corretora? A hospedagem para na hora".
- **Proposta:** trocar o campo livre de servidor por uma escolha da corretora com a lista dos servidores atendidos, porque o leigo não sabe o nome do servidor.

**P2. São duas cobranças e duas assinaturas.**
Portfólio e hospedagem são cobrados separadamente, o que é correto pela regra de negócio. Mas o cliente vê duas cobranças no cartão sem ter sido avisado.

- **Proposta:** antecipar isso no anúncio (§3.2).
- **Proposta:** na tela da hospedagem, dizer "Esta é uma assinatura separada da assinatura do portfólio".
- **Proposta:** usar na Stripe uma descrição de fatura clara, como "TRADEMETRIC HOSPEDAGEM".

### 3.5 Uso diário

**P1. O painel diz "Copiando" sem estar copiando.**
Em `ClientDashboard.tsx`, o selo de cada trader é `t.is_paused ? 'Pausado' : t.valid ? 'Copiando' : 'Inativo'`. Ele só olha se a licença é válida. Uma licença paga sem conta conectada, sem EA conectado ou com a hospedagem não paga aparece como **Copiando**. O leigo acredita que está tudo certo, não vê operação e conclui que o produto não funciona.

- **Proposta:** usar no painel o mesmo `copyState` de Minhas licenças, que já sabe dizer "Conecte sua conta", "Desconectado" e "Hospedagem não paga".
- **Proposta:** quando uma licença precisa de ação, mostrar no topo um cartão "Falta 1 passo para começar a copiar" com o botão do passo. Esta é a correção de maior retorno sobre o esforço da lista toda.

**P2. O menu do cliente tem seis itens que se sobrepõem.**
Os itens são Painel, Minhas licenças, Assinaturas, Hospedagem, Instalação e Marketplace. Para o leigo, "licença", "assinatura" e "hospedagem" são a mesma coisa vista de três lados.

- **Proposta:** reduzir para quatro itens:
  - **Início** (o painel);
  - **Minhas cópias** (licenças, com o estado e a hospedagem de cada uma);
  - **Pagamentos** (assinaturas do portfólio e da hospedagem, cartão e faturas);
  - **Marketplace**.
- **Proposta:** levar a Instalação para dentro do assistente da §3.4 e para a ajuda.
- **Proposta:** chamar "licença" de **cópia** ou **assinatura** em toda a interface do cliente.

**P3. A oferta de hospedagem pode ficar repetitiva.**
Hoje ela aparece no painel, em Assinaturas, em Hospedagem e na licença. Para quem já disse "Agora não", isso vira ruído. A dispensa hoje vale só para a licença e para aquele navegador.

- **Proposta:** uma dispensa global de 7 dias, que vale para todas as telas.
- **Proposta:** reaparecer em momentos de dor, por exemplo quando o EA local ficar desconectado durante o pregão: "Seu computador desligou e você perdeu a operação de hoje. Quer deixar no automático por R$ 9,99?". É o upsell mais forte que existe e hoje não é usado.

### 3.6 Emails do ciclo de vida

Hoje há confirmação de email, recuperação de senha e a mensagem "Assinatura aprovada", que traz um link para a licença. Faltam os emails que fazem o cliente ativar e continuar:

| Quando | Email | Por quê |
|---|---|---|
| 24 h depois de pagar, sem conta conectada | "Falta 1 passo: conecte sua conta" | É o maior vazamento (§3.4) |
| Primeira operação copiada | "Sua primeira cópia: WIN, +R$ 32" | É o momento "funcionou", que mais reduz o cancelamento |
| EA local desconectado no pregão | "Sua cópia parou", com a oferta de hospedagem | Retenção e upsell |
| 3 dias antes de vencer, se não renova sozinha | "Sua assinatura vence sexta" | Renovação |

---

## 4. Ordem sugerida

| Ordem | Item | Achado | Impacto | Esforço |
|---|---|---|---|---|
| 1 | Painel com o estado real e o cartão "Falta 1 passo" | 3.5 P1 | Alto | Baixo |
| 2 | Corrigir o texto do `AuthShell` para o cliente, o texto dos botões e "Minhas licenças" → "Assinaturas" | 3.3 P1, 3.2 P2 | Médio | Baixo |
| 3 | Assistente de ativação pós-compra, com a escolha nuvem ou computador | 3.4 P1 | Muito alto | Médio |
| 4 | Explicação para visitantes no marketplace: pré-requisito e FAQ | 3.1 P1 | Alto | Baixo |
| 5 | Hospedagem antecipada no anúncio e o aviso das duas cobranças | 3.2 P1, 3.4 P2 | Médio | Baixo |
| 6 | Email "Falta 1 passo" e email da primeira cópia | 3.6 | Alto | Médio |
| 7 | Menu do cliente com 4 itens e o vocabulário "cópia" | 3.5 P2 | Médio | Médio |
| 8 | Selo de risco e ordenação padrão do catálogo | 3.1 P2 | Médio | Médio |
| 9 | Upsell quando o EA local cai, e dispensa global | 3.5 P3 | Médio | Médio |

Os itens 1 e 2 cabem num dia e corrigem o que hoje faz o cliente desconfiar do produto. O item 3 é o que mais muda a conversão do pagamento para a cópia ativa.

**Cuidado regulatório:** o painel do lead usa "traders de alta performance", "portfólios validados", "track record auditado" e "execução ultrarrápida". Pelo risco apontado na análise da Res. 21, vale revisar promessas de desempenho e a palavra "auditado" com o jurídico antes de investir em tráfego pago.

---

## 5. Como medir

Sem números, as prioridades acima são estimativas. Para medir o funil, basta registrar estes eventos, no GTM ou no próprio backend:

`catalogo_visto` → `anuncio_visto` → `copiar_clicado` → `cadastro_feito` → `checkout_aberto` → `pagamento_ok` → `conta_conectada` → `modo_escolhido` (nuvem ou computador) → `primeira_copia`.

As duas taxas que mais importam:

- **pagamento_ok → primeira_copia em até 72 h:** mostra a saúde da ativação. Se ficar abaixo de 70%, o assistente da §3.4 é urgente.
- **Proporção que escolhe a nuvem no momento da ativação:** mostra se o upsell está bem posicionado.

---

## 6. O que foi implementado em 26/10

| Achado | Situação |
|---|---|
| 3.5 P1: o painel diz "Copiando" sem estar copiando | **Feito.** O painel usa o mesmo estado de Minhas cópias e mostra no topo o cartão "Falta 1 passo" ou "N cópias precisam de você", com um link para cada cópia |
| 3.4 P1: falta uma sequência guiada depois do pagamento | **Feito.** Ao voltar da Stripe, o cliente vai direto para a cópia nova, onde um assistente de 3 passos (conta, como copiar, pronto) mostra a nuvem como **Recomendado** e o computador como **Avançado**. O assistente continua até a hospedagem ser paga e permite voltar e escolher outro jeito |
| 3.4 P1: o caminho do EA local é longo | **Melhorado.** Dentro do assistente: baixar o EA, copiar a URL num toque, gerar a chave e "Esperando o EA conectar…", com atualização a cada 5 s |
| 3.4 P2: a senha assusta e são duas cobranças | **Feito.** Três garantias junto da senha, e o aviso "uma assinatura separada da assinatura do portfólio" |
| 3.1 P1: não há explicação para quem nunca copiou | **Feito.** O marketplace mostra aos visitantes o bloco "Como funciona", com 3 passos e o pré-requisito da conta MT5, e um FAQ de 6 perguntas no fim |
| 3.1 P2: ordenação e jargão no catálogo | **Feito.** A ordenação padrão é "Recomendados" (retorno sobre a queda). O cartão mostra o selo de risco e deixa o lucro por lote só na ordenação por lote |
| 3.2: a hospedagem não aparece na compra, o plano é explicado em lotes, os botões e as referências estão inconsistentes, a bio fica escondida | **Feito.** O anúncio mostra "+ R$ 9,99/mês para rodar na nossa nuvem". O plano diz "Copia ordens de até X lotes (contratos)". O botão é "Copiar esta estratégia" nos dois casos, e as referências foram corrigidas. A bio aparece acima da dobra. O selo de risco também está no anúncio |
| 3.3 P1: o cadastro fala com o gestor | **Feito.** O cadastro, e o login vindo do marketplace, falam com o cliente. No celular aparecem garantias embaixo do formulário |
| 3.5 P2: o menu tem 6 itens | **Feito.** O menu tem Início, Minhas cópias, Pagamentos e Marketplace, mais uma seção "Mais" com Hospedagem e Instalar o EA. No celular há uma **barra de abas fixa embaixo**, e os avisos sobem para não ficarem atrás dela |
| 3.5 P3: a oferta de hospedagem é repetitiva | **Feito.** "Agora não" no painel vale 7 dias. Quando o EA do computador está desconectado, a oferta muda para "Seu computador está desligado? … a cópia não para mais" |
| 3.6: emails do ciclo de vida | **Parcial.** O email de aprovação traz os 2 passos e o link "Ative agora", e o de renovação ficou separado |
| Cuidado regulatório | **Feito.** Saíram do painel "alta performance", "portfólios validados", "track record auditado" e "execução ultrarrápida" |

**Ficou para depois, porque precisa de decisão ou de infraestrutura:**

- **Emails "Falta 1 passo" depois de 24 h, "primeira cópia" e "sua cópia parou":** precisam de uma tarefa periódica e de um evento do hub.
- **Confirmação do email por código de 6 dígitos (3.3 P2):** muda o backend do cadastro.
- **Plano "Mais escolhido" e "para contas de até R$ X":** precisa de um campo novo no anúncio, preenchido pelo gestor.
- **Medição do funil (§5):** os eventos ainda não estão no GTM.
- **Descrição na fatura da Stripe** ("TRADEMETRIC HOSPEDAGEM"): é uma configuração no painel da Stripe.
- **As faixas do selo de risco** (até 10%, até 25% e acima de 25% de queda) são um ponto de partida e merecem revisão de negócio e jurídica.
