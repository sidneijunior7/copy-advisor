# Deploy e rollout — TDM Mirror

## Arquitetura

O monólito passa a ser dois serviços, construídos a partir do mesmo repositório:

| Serviço | Dockerfile | O que faz | Portas |
|---|---|---|---|
| `mirror-api` | `Dockerfile` | API, dashboard e `/ws`; migra o banco ao subir, em segundo plano | 8000 (domínio `mirror.trademetric.com.br`) |
| `mirror-hub` | `Dockerfile.hub` | Recebe os Masters, publica para os Slaves, grava sinais | 8002 (WebSocket, domínio `signals.trademetric.com.br`); 5558 e 8001 só na rede interna |

Um deploy da API não derruba mais os sinais. O hub roda sozinho, com o próprio `/health` na porta 8001.

## v4: transporte WSS e chaves próprias

O hub atende WebSocket na porta 8002, em `/v1/master` e `/v1/slave`, atrás do proxy do EasyPanel (`wss://signals.trademetric.com.br`). Cada conexão se autentica com a própria chave, e um Slave só recebe o portfólio da licença dele. Desde o corte do ZMQ (seção abaixo), é o único caminho dos EAs até o hub.

- **Chaves só com hash.** O gestor tem várias chaves de Master (uma por Master/VPS), cada uma revogável. Cada licença tem a sua chave de Slave (`lic_...`), que pode ser trocada, e uma validade opcional. A chave aparece uma vez, quando é criada.
- **EAs v4.** Usam só WSS, sem DLL e sem `WebRequest` para a API: o hub valida a licença e informa o limite de lotes. Um EA que importa uma DLL só roda com "Allow DLL imports", mesmo que nunca a chame, por isso o ZMQ ficou de fora.
- **Efeito imediato.** A API pede ao hub que recarregue o diretório depois de cada mudança em chave ou licença. Revogar uma chave derruba na hora os terminais conectados com ela.

### EasyPanel
1. **DNS:** registro A `signals.trademetric.com.br` → `148.230.74.39`, o mesmo IP do `mirror`.
2. **`tdm_hub`:** domínio `signals.trademetric.com.br` com HTTPS apontando para a porta **8002** do serviço.
3. **Deploy da API e, logo em seguida, do hub.** A API roda a migração `0006`.
   - O hub antigo continua funcionando depois da migração, porque `users.master_key` só é apagada na `0007`.
   - O hub novo, sem a `0006`, não carrega o diretório e recusa os Masters até a tabela existir. Ele tenta de novo a cada 30 s.
4. Não há variável nova obrigatória. As opcionais do hub são `HUB_WS_PORT` (8002), `HUB_WS_QUEUE` (1000 mensagens por conexão), `HUB_WS_CONNS_PER_IP` (300; um pod de terminais hospedados divide um IP) e `HUB_WS_FAILS_PER_IP` (30 HELLOs recusados em 5 min).

**Conferência**
- `curl https://signals.trademetric.com.br/health` responde `OK`.
- O `/health` da API mostra `hub.ws` com `masters`, `slaves`, `manage_only` e `max_lag`.
- No painel, **Conexões** lista os terminais conectados via WSS.

### Gestores e clientes
- **Chaves do Master:** uma por Master/VPS, criada em Estratégias › Chaves do Master. As que existiam antes do corte do ZMQ foram revogadas por ele.
- **Licenças antigas** não têm chave de Slave: gere uma em Clientes ("Gerar chave") e entregue ao cliente junto com o EA v4.
- **No terminal do cliente,** libere `https://signals.trademetric.com.br` em *Ferramentas › Opções › Expert Advisors › Permitir WebRequest*. "Allow DLL imports" deixa de ser necessário. O gráfico mostra o estado da conexão e da licença.
- **Quem ainda tiver o v3 instalado** troca pelo v4 sem posição copiada aberta. O v4 grava o mapeamento por portfólio (`MQL5\Files\TDM_Mirror\<login>_P<id>.csv`) e usa outra tag nos comentários, então não reconhece cópias abertas pelo v3. Em troca, trocar a chave da licença no v4 não perde as cópias abertas.

### Distribuição dos EAs
O painel tem a página **Instalação**, com o Master e o Slave da versão atual para baixar e o passo a passo no MetaTrader 5. Os arquivos vêm de `downloads/`, que entra na imagem da API: `downloads/manifest.json` traz a versão, o tamanho e o SHA-256 de cada um. Só gestores baixam (`GET /ea/releases` e `GET /ea/releases/{master|slave}`); o gestor entrega o Slave ao cliente com a chave da licença.

**Para publicar uma versão nova**, depois de mudar um EA e o `#define VERSAO` dele:
```
powershell -File tools\compile_eas.ps1 -Publish
```
O script compila, copia os `.ex5` para `downloads/` e atualiza o manifesto. Faça o commit de `downloads/` junto com o código e o deploy da API. Em **Conexões**, os terminais numa versão anterior à publicada ganham o aviso "Atualizar para …".

### Revogação, validade e chaves trocadas
- **Licença revogada ou expirada:** o terminal fica conectado em modo só-gestão. Ele recebe só as posições que já estavam abertas quando a licença deixou de valer, acompanha o Master até fechá-las e não abre nada novo. Posições abertas depois chegam como `SKIP`, sem conteúdo. Revogar não abre nem fecha nada por conta própria.
- **Chave nova da licença ou licença removida:** o terminal conectado cai na hora (`ERR|revoked`) e o EA tenta de novo a cada minuto, até receber a chave nova.
- **Dois terminais com a mesma licença:** o mais novo assume. O anterior para de copiar, não reconecta e avisa no gráfico.

### Corte do ZMQ
O hub não abre mais as portas 5557 (PUSH dos Masters e confirmações dos Slaves) e 5556 (PUB dos Slaves), que não tinham autenticação: quem assinasse a 5556 lia todos os portfólios. Saem junto o formato do Master anterior ao v3, as linhas `OPEN`/`CLOSE` do Slave antigo (`HUB_LEGACY_PUBLISH` deixa de existir) e a validação de licença do Slave v3 (`POST /api/license/check`). EAs v3 param de copiar. O canal interno de eventos para a API (5558) continua.

A migração `0007` apaga `users.master_key` e `portfolios.public_key` e **revoga todas as chaves de Master existentes**, porque podem ter trafegado em claro pela 5557.

**Ordem**
1. **Deploy do hub primeiro.** O hub novo não lê as colunas que a `0007` apaga, então roda com o banco ainda na `0006`. O hub antigo, ao contrário, deixa de carregar o diretório depois da `0007`.
2. **Deploy da API**, que roda a `0007`. Confira `"schema": "ready"` no `/health`. Os Masters conectados caem com `ERR|revoked` em até 30 s.
3. **No EasyPanel, tire as portas 5557 e 5556 do `tdm_hub`.** De fora, as duas devem estar fechadas.
4. **Cada gestor cria uma chave de Master nova** no painel e a coloca no input do Master. Os Slaves não mudam.

Um Master conectado com uma chave revogada tenta de novo a cada minuto e mostra o motivo no gráfico. Com a chave nova no input ele volta sozinho, e o `V2SYNC` dele reconcilia as posições abertas.

## Antes do primeiro deploy

1. **Backup do banco** no Supabase.
2. **Magic numbers duplicados.** A migração `0002` cria `UNIQUE(user_id, magic_number)` e aborta se houver duplicatas. Confira antes:
   ```sql
   SELECT user_id, magic_number, COUNT(*) FROM strategies GROUP BY 1, 2 HAVING COUNT(*) > 1;
   ```
3. **Opcional:** rode `DATABASE_URL=<cópia do banco> python -m alembic check` depois de migrar uma cópia. Se o banco foi criado pelo `supabase_schema.sql`, vão aparecer diferenças de `NOT NULL`. Elas são esperadas e inofensivas.

O `migrate.py` reconhece sozinho um banco criado antes do Alembic: marca a revisão `0001_baseline` e aplica a `0002`. No Postgres a migração é transacional, então se falhar não sobra nada pela metade.

**A API sobe mesmo com o banco fora.** Ela migra numa thread (`MIGRATE_ON_START=1`, definido no `Dockerfile`):
- Enquanto a migração não termina, as rotas de dados respondem 503, o `/ws` fecha com 1013 e o `/health` mostra `"schema": "pending"`. O `/health/live` (o healthcheck do container) responde normalmente.
- Se o banco estiver fora, a API tenta de novo com espera crescente, até 30 s entre tentativas, e registra uma linha de log por minuto.
- Se a migração falhar por outro motivo, o `/health` mostra `"schema": "failed"` e o erro fica no log. As rotas de dados continuam em 503 até um deploy corrigido.

Antes, o `python migrate.py` rodava antes do uvicorn: com o banco fora no boot, o container saía com erro e o Swarm o reiniciava em loop.

## EasyPanel

**`mirror-hub`**
- Fonte: este repositório, `Dockerfile.hub`.
- Variáveis: `DATABASE_URL` (a mesma da API).
- Nenhuma porta publicada no host: o domínio `signals.trademetric.com.br` aponta para a 8002, e a API chega à 5558 e à 8001 pela rede interna.
- **Uma réplica.** Se o EasyPanel permitir escolher a ordem de update, use *stop-first*. Com dois hubs no ar ao mesmo tempo, os Masters podem ir para um e os Slaves ficarem no outro.

**`mirror-api`**
- Nenhuma porta publicada além do domínio `mirror.trademetric.com.br` (8000).
- Variáveis do hub (use o hostname interno dele, que o EasyPanel mostra na página do serviço, algo como `<projeto>_mirror-hub`):
  - `HUB_EVENTS_URL=tcp://<hostname-do-hub>:5558`
  - `HUB_HEALTH_URL=http://<hostname-do-hub>:8001/health`

A lista completa de variáveis está em `.env.example`.

**`mirror-monitor`** (alertas no Telegram)
- Fonte: este repositório, `Dockerfile.monitor`. Uma réplica, nenhuma porta, limite de memória de 64 MB.
- Checa o `/health` da API e o `signals.trademetric.com.br/health` a cada minuto. Avisa quando a API, o banco, o hub ou o endereço dos EAs falham três vezes seguidas, quando falta Master conectado no pregão (dias úteis, 09:00–18:30 de Brasília) e quando o hub perde gravações; avisa de novo quando volta ao normal. Ao subir, manda uma mensagem de teste.
- **Telegram:** crie o bot com o @BotFather (`/newbot`), que devolve o token. Mande uma mensagem ao bot (ou o adicione a um grupo) e abra `https://api.telegram.org/bot<TOKEN>/getUpdates`: o `chat.id` é o destino.
- Variáveis: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Opcionais: `MONITOR_SESSION` (padrão `09:00-18:30`), `MONITOR_MIN_MASTERS` (1), `MONITOR_FAILURES` (3), `MONITOR_INTERVAL_S` (60), `MONITOR_MASTER_QUIET_S` (120).
- Na mesma VPS, ele não avisa se a própria VPS cair. Para isso, `MONITOR_PING_URL` recebe a URL de um serviço como o healthchecks.io, chamada a cada rodada; o serviço avisa quando as chamadas param.

**Conferência:** `GET https://mirror.trademetric.com.br/health` deve mostrar `"status": "healthy"` e o bloco `hub` com `"warming": false`.

## Terminais hospedados

O MetaTrader 5 do cliente roda num pod nosso, sem nada instalado do lado dele. O pod roda o mesmo Slave, e o hub não vê diferença.

**Como funciona**
- O gestor clica em **Hospedar** na linha da licença, em Clientes, e informa o servidor da corretora, a senha de negociação da conta e as entradas do Slave (tamanho, SL/TP, mapas de símbolo).
- A senha e a chave da licença ficam cifradas com o `HOSTING_SECRET` (Fernet), que fica fora do banco. Hospedar dá à licença uma chave nova, que só o pod conhece. Por isso, um Slave que o cliente rode no próprio computador é desconectado.
- Cada pod (`pod_agent.py`, `Dockerfile.pod`) chama `POST /pods/sync` a cada 15 s. Ele informa o estado de cada terminal e recebe a lista do que deve rodar.
  - Um terminal novo vai para o primeiro pod com espaço e fica nele, mesmo desligado, porque o mapeamento das cópias mora na pasta dele.
  - Uma mudança de configuração reinicia o terminal.
  - Login recusado ("Invalid account", ou três recusas seguidas) para o terminal sem tentar de novo, porque a corretora pode bloquear a conta. Ele só volta com uma configuração nova.
  - Um terminal que cai volta sozinho, com espera crescente (30 s até 10 min).
  - Um terminal removido tem a pasta guardada por 7 dias em `slots/.removed`.
- O estado em Clientes vem do pod, que lê o diário e o log dos EAs do MT5, e das sessões do hub: um Slave conectado ao hub aparece como **Copiando**.

**API (`mirror-api`)**
- `HOSTING_SECRET`: gere com `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Sem ela, a hospedagem fica desligada. Trocá-la torna ilegíveis as senhas já cadastradas.
- A migração `0008` cria `hosted_pods` e `hosted_terminals`.
- Cada pod precisa de uma chave: `python create_pod.py <nome>` no console da API mostra a chave uma vez. `--revoke <nome>` corta o pod.

**Pod (`mirror-pod`)**
- Imagem: `Dockerfile.pod`, sobre `ghcr.io/sidneijunior7/mt5-worker:v1.72` (a VPS precisa de acesso a esse registro). Leva o Slave de `downloads/`; depois de publicar uma versão nova, refaça a imagem.
- Variáveis: `POD_KEY` e `CAPACITY` (terminais no pod). `API_URL`, `WS_HOST`, `WS_PORT` e `WS_TLS` já apontam para produção.
- Volume em `/root/.wine64/drive_c/slots`: as pastas dos terminais, com o mapeamento das cópias.
- Recursos, medidos em 18/10 num Ryzen 5 5500 com a B3 fechada:
  - cerca de 460 MB por terminal;
  - a subida de um terminal já criado leva uns 14 s a 1 a 1,5 núcleo, cerca de 21 s de CPU no total; ela só acontece quando o pod sobe, quando a configuração muda ou quando o terminal cai;
  - parado, cada terminal gasta ~2% de um núcleo, mais ~3,5% fixos do Wine (`wineserver`, `winedevice`) por pod; com o mercado aberto, os ticks somam ao custo (falta medir num pregão);
  - os terminais sobem um de cada vez, a cada `STAGGER_SECONDS` (20).
- Numa VPS que divide a CPU com outros serviços, rode o pod com `--cpu-shares 2`: o kernel só dá CPU a ele quando os outros containers não querem. A subida fica mais lenta quando a máquina está ocupada, mas não tira CPU de ninguém. `--cpus` serve de teto.
- **Corretoras:** `pod/brokers/brokers.json` liga cada servidor ao `servers.dat` dela e a um símbolo que ela lista, para o gráfico de partida. Sem o `servers.dat`, o terminal nunca conecta e não dá erro. Para incluir uma corretora, copie o `config/servers.dat` de um MT5 que já logou nela.
- **Lista do WebRequest:** `pod/webrequest_url.txt` tem a lista cifrada com `https://signals.trademetric.com.br` e `http://hub.spike.test`. Ela só vale para terminais desta imagem base. Se a base mudar, gere outra pela tela do MT5, como descrito em `tools/spike/README.md`.

**Teste local:** `tools/spike`, com `docker compose --profile hosting up -d tdm-spike-hosted`. O pod local usa a chave `pod_spike_local`, criada pelo `seed.py`.

## Contas de cliente

- **Cadastro aberto** em `/cadastro`, com até `SIGNUP_MAX_PER_HOUR` (5) cadastros por IP por hora. A conta começa vazia.
- **Vínculo com a licença:** em Clientes, o gestor clica em **Cliente → Gerar código de acesso**.
  - O código vale uma vez e por 7 dias; o banco guarda só o hash.
  - O cliente digita o código em **Minhas licenças**.
  - Códigos errados contam no limite de 10 tentativas por IP a cada 10 minutos.
  - Gerar outro código invalida o anterior, e usar o código leva a licença para a conta de quem o usou.
- **O que o cliente vê e faz,** só nas licenças dele:
  - o estado da cópia (conta hospedada ou EA no computador, pelo hub), o limite e a validade;
  - as cópias, com o resultado em diferença de preço, e as que falharam;
  - hospedar a própria conta (o gestor não vê a senha);
  - gerar a chave do EA no computador (licenças hospedadas não, porque a chave fica com o pod);
  - ajustar o tamanho e o SL/TP dentro dos limites do portfólio.
- **Limites dos ajustes:** cada portfólio define os seus em **Portfólios → limites dos clientes**. O padrão é fator de 0,01 a 1 e todos os modos. O limite de lotes da licença vale por cima de tudo.
- **Onde ficam os ajustes:** na licença (`licenses.settings`). O hub os envia ao Slave em segundos (veja Resultados e ajustes), sem reiniciar o terminal.
- A migração `0009` cria essas colunas, move os ajustes que estavam em `hosted_terminals.inputs` para a licença e dá como verificados os emails das contas que já existiam.

## Resultados e ajustes pelo painel

- **Slave 4.04:**
  - Recebe os ajustes da licença do hub (`CFG|chave=valor|...`) logo depois do WELCOME e sempre que mudam, e os aplica por cima das próprias entradas. Uma chave que não vem volta à entrada do EA. Os ajustes valem para as próximas cópias.
  - Informa o resultado de cada execução, com swap e comissão, no fim do `EXEC`.
  - Informa os fechamentos que não fez (SL, TP, stop out, fechamento manual) como `CLOSE_EXT`.
  - Envia saldo e patrimônio (`ACC`) a cada 5 minutos.
- **Master 4.01:**
  - Envia cada execução da conta (`V2DEAL`): operações, depósitos e saques, com lucro, swap, comissão e horário em UTC. Ele lê o histórico a partir de um cursor guardado na variável global `TDM_DEALS_<login>` do terminal; na primeira vez, desde 90 dias atrás, para que as posições que o hub já acompanhava entrem no desempenho (uma posição só conta com as execuções dela). O que se perdeu numa queda sai na reconexão, e o hub descarta duplicatas pelo número da execução.
  - Envia saldo e patrimônio (`V2ACC`) junto com o `V2HELLO`.
- **Hub:**
  - Aceita `EXEC` com 10 campos (EAs antigos) ou 11.
  - Grava as execuções do Master em `master_deals` e o último saldo de cada hora em `account_snapshots`. O `HUB_RETENTION_DAYS` não apaga essas tabelas, porque são o histórico de desempenho.
- **Painel:**
  - **Portfólios → Desempenho:** resultado, retorno sobre o saldo do Master no início do período, acerto, fator de lucro, maior queda, resultado acumulado e resultado por mês, a partir das execuções do Master.
  - **Licença → Desempenho**, para o cliente: o resultado das cópias dele, com o saldo e o patrimônio da conta, ao lado do desempenho do portfólio no mesmo período.
- **Ordem de deploy:**
  1. API (migração `0010`): o hub novo grava em colunas que ela cria.
  2. Hub.
  3. Os EAs (Master 4.01 no terminal do Master, Slave 4.04 nos clientes e no pod). Os EAs antigos continuam funcionando sem esses dados.

## Marketplace e emails

- **Páginas públicas,** sem login: o catálogo em `/marketplace` e a página de cada portfólio em `/marketplace/<endereço>`. São páginas do painel; os dados vêm de `/api/marketplace`, com o desempenho guardado em memória por 5 minutos.
- **Gestor:**
  - em **Vendas → Marketplace**, preenche o perfil público (nome e apresentação) e cria o anúncio de cada portfólio: título, resumo, descrição, mercados, preço, link de pagamento (só `https`), dias e lotes padrão da licença, capital recomendado e se aceita hospedagem;
  - só publica com um nome no perfil e uma estratégia no portfólio;
  - em **Vendas → Assinaturas**, aprova ou recusa os pedidos. Aprovar cria a licença já ligada à conta do cliente, ou estende a validade a partir do vencimento atual, se for renovação.
- **Cliente:** pede a assinatura na página do portfólio com o número da conta MT5, paga pelo link do gestor e acompanha o pedido em **Minhas licenças**, onde também pede a renovação. Uma conta MT5 com licença de outro cliente não pode ser pedida.
- **TDM_DEV:** em **Marketplace**, suspende um anúncio com o motivo, que o gestor vê ao tentar publicar de novo, e o devolve como rascunho.
- **Emails** (`mailer.py`), por qualquer servidor SMTP (o email da Hostinger serve):
  - `SMTP_HOST`, `SMTP_PORT` (465 usa SSL, as outras STARTTLS), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` e `PUBLIC_URL`, a base dos links;
  - enviam a confirmação do cadastro (link de 72 horas), a recuperação de senha (link de 1 hora), o aviso de pedido novo ao gestor e a decisão ao cliente;
  - com o SMTP configurado, só quem confirmou o email assina;
  - sem `SMTP_HOST` e `SMTP_FROM`, nada é enviado, a recuperação de senha responde que não está disponível e qualquer cliente assina;
  - os links valem uma vez, e o banco guarda só o hash. Trocar a senha encerra as sessões abertas antes da troca;
  - o pedido de recuperação responde igual para emails com e sem conta, e conta no limite de tentativas por IP.
- **Pagamento:** por enquanto é o link do gestor e a aprovação manual.
- **Deploy:** a migração `0011` cria as tabelas. Configure as variáveis do SMTP na API antes de anunciar o cadastro: sem elas, quem esquecer a senha depende do suporte.

### Como os seguidores copiaram

- A seção aparece na página do anúncio e em **Portfólios → Desempenho**. Para cada cópia que fechou, compara o preço que o Slave conseguiu com o do Master, em pontos (diferença de preço). Assim, contas de qualquer tamanho se comparam.
- **Os números:**
  - **Captura:** os pontos dos seguidores sobre os do Master, por ativo, ponderada pelas cópias. Só aparece quando o Master ganhou pontos no período.
  - **Custo na entrada e na saída:** quanto o preço do seguidor foi pior que o do Master, em média. Um custo negativo é um preço melhor.
  - **Taxa de cópia:** das ordens de abertura enviadas aos seguidores, quantas abriram. O limite de lotes da licença não conta como falha.
  - **Tempo de cópia:** a mediana, do Master à ordem do seguidor.
- **O que fica de fora:** cópias ainda abertas, posições revertidas (de um lado ou do outro) e posições do Master sem as execuções do Master 4.01. As cópias precisam do Slave 4.04 ou mais novo.
- **No marketplace,** os números só aparecem com pelo menos `FOLLOWER_STATS_MIN_FOLLOWERS` seguidores (5) e `FOLLOWER_STATS_MIN_COPIES` cópias fechadas (20) no período; abaixo disso, a seção diz que ainda não há seguidores suficientes. Assim, nenhum cliente é identificado. O gestor vê os dos próprios portfólios com qualquer número.
- **Por ativo,** porque pontos de ativos diferentes não se somam. O ativo é o do Master.
- **Deploy:** a migração `0012` cria um índice em `executions` (portfólio e data). A retenção do hub passou a guardar as execuções que formam o resultado das cópias; veja Observabilidade. Mesma ordem de sempre: API, depois o hub.

## Tipo da conta do Master

O Master envia `V2HELLO` ao conectar e a cada 5 minutos. A mensagem leva o tipo da conta (`demo`, `contest` ou `real`), o servidor e a corretora. O hub grava isso em `master_accounts` (migração `0005`) e não bloqueia nada. A regra de conta demo para estratégias da B3 ainda vai ser definida.

```sql
SELECT u.email, a.master_login, a.trade_mode, a.server, a.company, a.last_seen_at
FROM master_accounts a JOIN users u ON u.id = a.manager_id ORDER BY a.last_seen_at DESC;
```

## Inputs do Slave

| Input | Padrão | Uso |
|---|---|---|
| `inp_slippage_points` | 20 | Desvio máximo na execução |
| `inp_late_max_deviation_points` | 50 | Entrada atrasada (posição descoberta pelo snapshot) só se o preço estiver a até N pontos da entrada do master; 0 = nunca |
| `inp_symbol_map` | vazio | Tradução explícita, ex.: `EURUSD=EURUSDm;XAUUSD=GOLD` |
| `inp_suffix_map` | vazio | Troca de sufixo, ex.: `.a=m` (EURUSD.a → EURUSDm) ou `=.raw` (acrescenta) |
| `inp_sizing_mode` | Fixed factor | `Fixed factor`: lote do master × fator. `Proportional to balance/equity`: lote do master × fator × capital da conta ÷ `inp_reference_capital` |
| `inp_reference_capital` | 10000 | Capital, na moeda da conta, que copia 1× os lotes do master (ex.: master opera 1 lote para cada 10 mil) |
| `inp_sltp_mode` | Same distance from entry | `Same distance from entry`: o SL/TP fica à mesma distância da entrada que no master. O desvio entre a entrada local e a do master é fixado na primeira execução da cópia e somado a cada SL/TP que o master define. Serve para corretoras com cotações diferentes (cripto, forex), onde o mesmo preço deixaria o stop longe demais ou do lado errado da entrada; na B3 o desvio é só o slippage. `Same price as master`: o mesmo preço do master |

No modo proporcional a escala é calculada quando a cópia abre e fica gravada no mapeamento: o equity oscilando depois não aumenta nem reduz a posição. O volume nunca fica abaixo do mínimo do símbolo, então contas muito pequenas copiam o lote mínimo. O limite de lotes da licença vale para a soma das cópias abertas, e uma cópia cortada por ele guarda a proporção que recebeu.

## Checklist no MT5 (contas demo)

Faça isto antes de liberar para clientes. Use uma conta hedging, uma netting e uma com sufixo de símbolo.

- [ ] Abrir com SL/TP, mover o SL, fazer parcial de 50%, aumentar a posição e fechar: o slave acompanha cada passo.
- [ ] Reversão numa conta netting.
- [ ] Reiniciar o terminal do slave com posição aberta: o mapeamento sobrevive (`MQL5\Files\TDM_Mirror`) e nada é duplicado.
- [ ] Slave desligado enquanto o master abre e fecha: ao voltar, a posição órfã fecha; a entrada perdida só abre se o preço estiver dentro do desvio.
- [ ] SL batendo só no slave: a posição **não** reabre.
- [ ] Duas estratégias no mesmo símbolo numa conta netting: não entra em ciclo de fecha e reabre.
- [ ] Master e slave em corretoras com cotações diferentes (ex.: BTCUSD): o SL/TP do slave fica à mesma distância da entrada que o do master, também depois de mover o SL/TP, da parcial e de reiniciar o terminal.
- [ ] Linhas aparecem em `master_positions`, `signals` e `executions`.

**EAs v4 (WSS)**, com "Allow DLL imports" desligado e `https://signals.trademetric.com.br` na lista de WebRequest:
- [ ] O Master e o Slave conectam. O gráfico mostra "Hub: conectado", e a página Conexões do painel lista os dois.
- [ ] Sem a URL na lista, o gráfico explica o que liberar (erro 4014).
- [ ] O Master v4 recebe a chave nova do painel (Chaves do Master). Ao revogá-la, o Master cai e o gráfico avisa.
- [ ] Revogar a licença com uma cópia aberta: o EA avisa, não abre posição nova e fecha a cópia quando o Master fechar. Reativar volta a copiar.
- [ ] Validade no passado: mesmo comportamento da revogação. Remover a validade volta a copiar.
- [ ] "Nova chave" da licença: o terminal cai, o EA avisa e tenta de novo a cada minuto. Com a chave nova no input, volta, e as cópias abertas continuam vinculadas.
- [ ] O mesmo `.set` em dois terminais: o segundo assume e o primeiro para, com aviso no gráfico.
- [ ] Hub reiniciado (Implantar no EasyPanel) com posição aberta: os EAs reconectam sozinhos e nada duplica.

Para testar o hub sem MT5, use `tools/hub_probe.py`: `listen --key lic_... --login <conta>` mostra o que um slave recebe, e `master --key mst_... --magic <magic>` simula um master. O padrão é `wss://signals.trademetric.com.br`; `--ws ws://127.0.0.1:8002` aponta para um hub local.

## Observabilidade

- **Latência de cópia:** o hub guarda o instante em que publicou cada `POS` e, quando o `EXEC` do slave chega com o mesmo `uid` e `seq`, grava a diferença em `executions.latency_ms` (migração `0004`). O `/health` do hub mostra `exec_latency_ms` com p50, p95 e máximo das últimas 1000 execuções. A medida começa no hub: o trecho master → hub não entra, porque o Master não envia horário confiável.
- **Gravação do hub:** em lotes de até 500 jobs por transação, com o que acumulou desde a anterior: uma rajada de `EXEC` custa poucas idas ao banco, e não cerca de 5 por relatório. O estado das posições tem fila própria (10 mil) e os `EXEC` outra (20 mil): se o banco não acompanhar, são os `EXEC` que se perdem, nunca o estado que o hub relê ao reiniciar. Com o banco fora, o hub espera o tempo que for; um erro de schema (hub publicado antes da migração) espera até 10 min e depois descarta. O `/health` do hub mostra `db_queue`, `db_dropped` e `db_failed`.
- **Retenção:** com `HUB_RETENTION_DAYS=N` no `mirror-hub`, o hub apaga uma vez por dia, em blocos de 5 mil linhas, os `signals` e `executions` com mais de N dias. A primeira rodada é 10 min depois de subir. `master_positions` fica inteiro (uma linha por posição). Das `executions`, ficam as concluídas que formam o resultado de uma cópia (abertura, aumento, reversão e fechamento), porque são o histórico de "Como os seguidores copiaram". Vão as recusas e as mudanças de SL/TP. O padrão é 0, que guarda tudo.
- **Cópias com problema:** a página Conexões lista os últimos 7 dias do que os Slaves não copiaram, ou copiaram menor: recusa da corretora (mercado fechado, volume inválido...), falta de margem e o volume que o limite de lotes deixou de fora (código 10034). Vem da tabela `executions`, das linhas com `retcode` fora de 10008/10009/10010. Desde o Slave 4.02, cada terminal informa cada falha uma vez; antes, uma entrada atrasada recusada voltava a cada snapshot. A latência de cópia conta só as ordens executadas.
- **Logs:** `LOG_FORMAT=json` nos dois serviços produz uma linha JSON por evento, com os campos passados em `extra=`. Os logs de acesso do uvicorn continuam em texto.
- **Erros:** com `SENTRY_DSN` definido, exceções não tratadas e logs `ERROR` vão para o Sentry.

Consulta de latência por portfólio:
```sql
SELECT portfolio_id, COUNT(*),
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
FROM executions WHERE latency_ms IS NOT NULL AND created_at > now() - interval '7 days'
GROUP BY 1;
```

## Limitações conhecidas

- **Netting:** o Slave ajusta a posição líquida do símbolo inteiro. Operar manualmente o mesmo símbolo numa conta netting copiada faz o EA "corrigir" a operação manual. Com várias cópias no mesmo símbolo, o SL/TP não é copiado.
- **Segurança:** a Fase 1 está na seção abaixo. Desde o corte do ZMQ, todo Master e todo Slave se autenticam com a própria chave.

## Fase 1 de segurança

**Antes do deploy**
- `SECRET_KEY` no `mirror-api`: pelo menos 32 caracteres aleatórios (`python -c "import secrets; print(secrets.token_urlsafe(48))"`). Sem ela, ou com um valor fraco, a API **não sobe**. Trocar a chave desloga todo mundo.
- `CORS_ORIGINS` fica vazio em produção, porque o dashboard é servido pela própria API.
- Faça o deploy do `mirror-hub` junto com o da API. O hub novo manda o `manager_id` em cada evento, e é por ele que a API filtra o `/ws`. Com um hub antigo, os managers deixam de receber atualizações ao vivo (só o TDM_DEV continua vendo).

**Depois do deploy**
1. A migração `0003` desativa as contas de admin que usavam as senhas que estavam no Git (`tdmdev123` e `Trademetric2026!`). Defina uma senha nova pelo console do container:
   ```
   python create_admin.py <email>
   ```
   Num console sem terminal interativo: `ADMIN_PASSWORD='<senha>' python create_admin.py <email>`. O mesmo comando cria uma conta TDM_DEV se o email não existir.
2. As senhas migram de `sha256_crypt` para bcrypt sozinhas, no próximo login de cada usuário.
3. **Chaves do Master:** desde a v4, cada gestor cria e revoga as próprias chaves no painel (seção v4). A rotação em massa aconteceu no corte do ZMQ (migração `0007`).

**O que mudou para quem usa o dashboard**
- O `/ws` só aceita conexão depois de receber `{"type": "AUTH", "token": ...}`. Cada manager vê só as próprias posições, e o TDM_DEV vê todas. Uma conta CLIENT é recusada (código 4403), porque ainda não existe vínculo entre cliente e manager.
- O token é renovado sozinho um minuto antes de expirar, até o limite de `SESSION_MAX_HOURS` desde o login. Um token expirado ou uma resposta 401 levam de volta para o login.
- Um manager congelado perde o acesso na hora, sem esperar o token expirar.
- Licença é sempre de portfólio: `POST /licenses` exige `portfolio_id`. Para vender uma estratégia avulsa, crie um portfólio só com ela. Licenças antigas por estratégia continuam listadas, mas nunca autenticaram no EA.
- `/token` responde `429` depois de `AUTH_MAX_FAILURES` falhas do mesmo IP em `AUTH_FAILURE_WINDOW_SECONDS`. O IP vem do `X-Forwarded-For`, mas só de um proxy na rede privada (`FORWARDED_ALLOW_IPS` no `Dockerfile`): o endereço que o cliente escreve no cabeçalho é ignorado.
