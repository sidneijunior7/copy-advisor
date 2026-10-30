# Cobrança dos gestores: mensalidade por faixa de clientes

> 30/10/2026: **em avaliação, nada desenvolvido.** Este documento registra o modelo combinado e o caminho técnico
> para quando a decisão for implementar. Antes de começar, confirmar os pontos de "A decidir" e o parecer da Res. 21.

## O modelo

- O Mirror **não cobra comissão** sobre as vendas do gestor. Cobra do gestor uma **mensalidade por faixa de clientes**
  (ex.: R$ 299 por até 50 clientes).
- O gestor fatura o próprio produto **na própria conta**: Stripe conectada ao Mirror, ou Hotmart/Kiwify com o fluxo
  atual de link de pagamento + aprovação manual.
- A hospedagem de terminais continua sendo cobrada do cliente pela Stripe do Mirror, como hoje (`STRIPE_HOSTING_PRICE_ID`).

### Por que não comissão

- **Dinheiro:** para tirar uma parte de cada venda, o dinheiro tem que passar pelo Mirror. Isso exige Stripe Connect
  com taxa da plataforma ou intermediação com repasse, o que traz nota fiscal sobre a intermediação, estornos e
  disputas.
- **Regulação:** um percentual sobre a venda de recomendação de investimento aproxima o Mirror da distribuição. A
  mensalidade de software o posiciona como fornecedor de tecnologia. É um argumento para levar ao parecer da Res. 21
  (ver `ANALISE_RES21.md`), não uma conclusão jurídica.
- **Receita:** a mensalidade é previsível, a nota é de venda de software ao gestor e não há apuração de vendas por
  gestor.

### Quando a comissão volta a fazer sentido

Quando o **marketplace** trouxer o cliente, o valor gerado é do Mirror. Aí cabe uma taxa só para as vendas que vierem do
marketplace, somada à mensalidade. Fica para uma fase posterior.

## Regras do produto

| Tema | Regra |
|---|---|
| O que conta como cliente | **Licença ativa** (conta copiando) de um portfólio ou estratégia do gestor. Um cliente com duas contas ocupa duas vagas. Licença vencida não conta. |
| Faixas (a calibrar) | Grátis até ~5, depois 50, 150 e 500 clientes. Acima da maior faixa, por negociação. |
| Passou da faixa | **Nunca desligar uma cópia em andamento.** Bloquear só novas licenças (ou cobrar o excedente, a decidir) e avisar o gestor no painel e por e-mail. |
| Mensalidade não paga | Período de tolerância, depois bloquear novas licenças e a edição do anúncio. As cópias que já rodam continuam. |
| Isentos | Os portfólios da própria Trademetric (MVP) e os gestores marcados como parceiros. |

## Desenho técnico

### 1. Conexão da Stripe do gestor: Stripe Connect Standard, sem taxa

O gestor clica em "Conectar minha Stripe" e autoriza numa tela da própria Stripe. O Mirror guarda só o
`stripe_account_id` (`acct_...`) e faz as chamadas em nome dessa conta com a chave da plataforma (opção
`stripe_account` / cabeçalho `Stripe-Account`). Nenhuma chave secreta de terceiros fica guardada.

- **Webhook:** um endpoint Connect só (ex.: `POST /payments/connect/webhook`, com `STRIPE_CONNECT_WEBHOOK_SECRET`). Cada
  evento traz `account`, que identifica o gestor.
- **Confirmar antes de começar:** a disponibilidade do Connect Standard para contas no Brasil e se o fluxo indicado
  hoje é o OAuth ou o onboarding por Account Links.
- **Alternativa, se o Connect não servir:** chaves restritas do gestor (`rk_...`), criptografadas com Fernet como a
  `HOSTING_SECRET`, mais um webhook por gestor (`/payments/webhook/{manager_id}`) com o próprio `whsec_`. Funciona, mas
  o Mirror passa a guardar segredos de terceiros e cada gestor configura o próprio webhook, o que gera chamados de
  suporte.

### 2. O que muda em `payments.py`

Hoje tudo usa uma Stripe só (`STRIPE_SECRET_KEY`). As cobranças do anúncio passam a usar a conta do dono do anúncio:

- `_client()`: recebe a conta conectada do gestor e a repassa em cada chamada.
- `price_terms` e `save_plans`: o `price_...` é lido na conta do gestor.
- `checkout`, `portal`, `change_plan`, `set_renewal`, `expire_checkout` e `_subscription`: são chamados em nome da conta
  conectada.
- `handle`: o webhook da plataforma continua tratando a hospedagem e a mensalidade dos gestores. O webhook Connect
  trata as assinaturas dos anúncios, localizando o gestor pelo `account`.
- `hosting_price` e a cobrança da hospedagem **não mudam**: continuam na conta da plataforma.

### 3. Mensalidade do gestor (cobrança do Mirror)

É o mesmo padrão da hospedagem: uma assinatura na Stripe da plataforma, com um preço por faixa (ou um preço com
`tiered`/quantidade).

- **Modelos:** em `User` (ou numa tabela `ManagerBilling`), guardar `stripe_account_id`, o status da conexão, a assinatura
  da mensalidade, a faixa, `paid_until` e uma flag de isento. Precisa de uma migração nova.
- **Contagem:** contar as licenças ativas dos portfólios e estratégias do gestor. A mesma consulta de `client_ids` em
  `education.py` serve de base, filtrando as que não venceram.
- **Bloqueio:** é feito na emissão e no resgate de licença (rotas de licença em `server.py` e a aprovação manual), nunca
  no hub.
- **Telas:** o gestor vê a faixa, o uso ("38 de 50 clientes"), o status da Stripe conectada e o portal da mensalidade.
  O admin vê os gestores, as faixas, quem está inadimplente e a flag de isento.

### 4. Fases sugeridas

1. **Mensalidade sem Connect:** faixas, contagem, bloqueio de novas licenças e a assinatura na Stripe da plataforma. Os
   gestores vendem por link + aprovação manual. Já permite cobrar.
2. **Stripe do gestor:** a conexão via Connect, o webhook Connect e a mudança de `payments.py` para a conta do anúncio.
3. **Marketplace:** uma taxa só para as vendas vindas do marketplace, se o parecer permitir.

## A decidir

- Valores e limites das faixas, e se o plano grátis existe.
- Excedente: bloquear novas licenças ou cobrar por cliente extra?
- Tolerância de inadimplência (quantos dias).
- Se os gestores parceiros atuais ficam isentos, e por quanto tempo.
- Connect Standard (confirmar no Brasil) ou chaves restritas.
- O parecer da Res. 21 sobre o modelo de mensalidade.
