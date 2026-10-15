# Deploy e rollout — TDM Mirror

## Arquitetura

O monólito passa a ser dois serviços, construídos a partir do mesmo repositório:

| Serviço | Dockerfile | O que faz | Portas |
|---|---|---|---|
| `mirror-api` | `Dockerfile` | API, dashboard e `/ws`; roda `migrate.py` ao subir | 8000 (domínio `mirror.trademetric.com.br`) |
| `mirror-hub` | `Dockerfile.hub` | Recebe os Masters, publica para os Slaves, grava sinais | 8002 (WebSocket, domínio `signals.trademetric.com.br`); 5557 e 5556 publicadas no host até o corte do ZMQ; 5558 e 8001 só na rede interna |

Um deploy da API não derruba mais os sinais. O hub roda sozinho, com o próprio `/health` na porta 8001.

## v4: transporte WSS e chaves próprias

O hub passa a atender WebSocket na porta 8002, em `/v1/master` e `/v1/slave`, atrás do proxy do EasyPanel (`wss://signals.trademetric.com.br`). Cada conexão se autentica com a própria chave, e um Slave só recebe o portfólio da licença dele. O ZMQ continua igual até o corte, para os EAs v3.

- **Chaves só com hash.** O gestor tem várias chaves de Master (uma por Master/VPS), cada uma revogável. Cada licença tem a sua chave de Slave (`lic_...`), que pode ser trocada, e uma validade opcional. A chave aparece uma vez, quando é criada.
- **EAs v4.** Usam só WSS, sem DLL e sem `WebRequest` para a API: o hub valida a licença e informa o limite de lotes. O ZMQ ficou de fora, porque um EA que importa uma DLL só roda com "Allow DLL imports", mesmo que nunca a chame. Quem ainda não puder migrar continua no v3, que o hub atende pelo ZMQ até o corte.
- **Efeito imediato.** A API pede ao hub que recarregue o diretório depois de cada mudança em chave ou licença. Revogar uma chave derruba na hora os terminais conectados com ela.

### EasyPanel
1. **DNS:** registro A `signals.trademetric.com.br` → `148.230.74.39`, o mesmo IP do `mirror`.
2. **`tdm_hub`:** domínio `signals.trademetric.com.br` com HTTPS apontando para a porta **8002** do serviço. As portas 5557 e 5556 continuam publicadas enquanto houver EA v3.
3. **Deploy da API e, logo em seguida, do hub.** A API roda a migração `0006`.
   - O hub antigo continua funcionando depois da migração, porque `users.master_key` não é apagada.
   - O hub novo, sem a `0006`, não carrega o diretório e recusa os Masters até a tabela existir. Ele tenta de novo a cada 30 s.
4. Não há variável nova obrigatória. As opcionais do hub são `HUB_WS_PORT` (8002), `HUB_WS_QUEUE` (1000 mensagens por conexão), `HUB_WS_CONNS_PER_IP` (300; um pod de terminais hospedados divide um IP) e `HUB_WS_FAILS_PER_IP` (30 HELLOs recusados em 5 min).

**Conferência**
- `curl https://signals.trademetric.com.br/health` responde `OK`.
- O `/health` da API mostra `hub.ws` com `masters`, `slaves`, `manage_only` e `max_lag`.
- No painel, **Conexões** lista os terminais conectados via WSS.

### Gestores e clientes
- **Chaves do Master:** a chave usada até agora aparece como "Chave anterior" e continua valendo. Crie uma chave por Master/VPS e revogue a anterior quando todos os Masters estiverem no v4, porque ela trafegou em claro pelo ZMQ.
- **Licenças antigas** não têm chave de Slave: gere uma em Clientes ("Gerar chave") e entregue ao cliente junto com o EA v4.
- **No terminal do cliente,** libere `https://signals.trademetric.com.br` em *Ferramentas › Opções › Expert Advisors › Permitir WebRequest*. "Allow DLL imports" deixa de ser necessário. O gráfico mostra o estado da conexão e da licença.
- **Troque o v3 pelo v4 sem posição copiada aberta.** O v4 grava o mapeamento por portfólio (`MQL5\Files\TDM_Mirror\<login>_P<id>.csv`) e usa outra tag nos comentários, então não reconhece cópias abertas pelo v3. Em troca, trocar a chave da licença no v4 não perde as cópias abertas.

### Revogação, validade e chaves trocadas
- **Licença revogada ou expirada:** o terminal fica conectado em modo só-gestão. Ele recebe só as posições que já estavam abertas quando a licença deixou de valer, acompanha o Master até fechá-las e não abre nada novo. Posições abertas depois chegam como `SKIP`, sem conteúdo. Revogar não abre nem fecha nada por conta própria.
- **Chave nova da licença ou licença removida:** o terminal conectado cai na hora (`ERR|revoked`) e o EA tenta de novo a cada minuto, até receber a chave nova.
- **Dois terminais com a mesma licença:** o mais novo assume. O anterior para de copiar, não reconecta e avisa no gráfico.

### Corte do ZMQ
Faça o corte depois de 7 dias com todos os EAs no v4: o `/health` do hub não pode mostrar mensagens chegando pela porta 5557, e os slaves conectados por WSS devem bater com as licenças ativas.
1. `HUB_LEGACY_PUBLISH=0` e remoção das portas 5557 e 5556 do `tdm_hub` no EasyPanel.
2. Revogação da "Chave anterior" de cada gestor.
3. Migração que apaga `users.master_key` e deixa de usar `portfolios.public_key`, e remoção do ZMQ do hub.

## Antes do primeiro deploy

1. **Backup do banco** no Supabase.
2. **Magic numbers duplicados.** A migração `0002` cria `UNIQUE(user_id, magic_number)` e aborta se houver duplicatas. Confira antes:
   ```sql
   SELECT user_id, magic_number, COUNT(*) FROM strategies GROUP BY 1, 2 HAVING COUNT(*) > 1;
   ```
3. **Opcional:** rode `DATABASE_URL=<cópia do banco> python -m alembic check` depois de migrar uma cópia. Se o banco foi criado pelo `supabase_schema.sql`, vão aparecer diferenças de `NOT NULL`. Elas são esperadas e inofensivas.

O `migrate.py` reconhece sozinho um banco criado antes do Alembic: marca a revisão `0001_baseline` e aplica a `0002`. No Postgres a migração é transacional, então se falhar não sobra nada pela metade.

## EasyPanel

**`mirror-hub` (serviço novo)**
- Fonte: este repositório, `Dockerfile.hub`.
- Variáveis: `DATABASE_URL` (a mesma da API) e `HUB_LEGACY_PUBLISH=1`.
- Portas publicadas: `5557` e `5556`.
- **Uma réplica.** Se o EasyPanel permitir escolher a ordem de update, use *stop-first*. Com dois hubs no ar ao mesmo tempo, os Masters podem ir para um e os Slaves ficarem no outro.

**`mirror-api` (serviço atual)**
- **Remover** a porta publicada `5556` (e a `5557`, se existir); elas passam para o hub.
- Variáveis novas (use o hostname interno do hub, que o EasyPanel mostra na página do serviço, algo como `<projeto>_mirror-hub`):
  - `HUB_EVENTS_URL=tcp://<hostname-do-hub>:5558`
  - `HUB_HEALTH_URL=http://<hostname-do-hub>:8001/health`

A lista completa de variáveis está em `.env.example`.

**Conferência:** `GET https://mirror.trademetric.com.br/health` deve mostrar `"status": "healthy"` e o bloco `hub` com `"warming": false`.

## Ordem de rollout

1. **Janela de manutenção:** criar o `mirror-hub` com as portas 5557 e 5556, tirar a 5556 da API e fazer o deploy da API. Com `HUB_LEGACY_PUBLISH=1`, os EAs antigos continuam funcionando: o hub aceita o formato antigo do Master e publica as linhas `OPEN`/`CLOSE` que o Slave antigo entende.
2. **Masters:** instalar o Master v3 **com a conta sem posição aberta**. A versão antiga truncava `pos_id` grandes, então uma posição aberta com ela ganharia identidade nova na troca. Configurar o input novo `InpServer`, que antes era um `127.0.0.1` fixo no código.
3. **Slaves:** distribuir o Slave v3 com a instrução de instalar **sem posição copiada aberta**. Posições do EA antigo (comentário `Copy ZMQ`) não são geridas pela v3, e o EA avisa no log quando encontra alguma.
4. **Desligar o legado:** com todos os clientes atualizados, `HUB_LEGACY_PUBLISH=0`.

### Master 3.01: tipo da conta

O Master 3.01 envia `V2HELLO` ao conectar e a cada 5 minutos. A mensagem leva o tipo da conta (`demo`, `contest` ou `real`), o servidor e a corretora. O hub grava isso em `master_accounts` (migração `0005`) e não bloqueia nada. A regra de conta demo para estratégias da B3 ainda vai ser definida.

A ordem é: deploy da API, que roda a `0005`; depois o hub; por último o Master.
- **Hub antigo:** recebendo um Master 3.01, loga `Malformed legacy message` no máximo uma vez por minuto. Fora isso, nada muda.
- **Hub novo antes da migração:** as gravações do hub ficam na fila até a tabela existir. A publicação dos sinais segue normal.

```sql
SELECT u.email, a.master_login, a.trade_mode, a.server, a.company, a.last_seen_at
FROM master_accounts a JOIN users u ON u.id = a.manager_id ORDER BY a.last_seen_at DESC;
```

### Inputs novos do Slave

| Input | Padrão | Uso |
|---|---|---|
| `inp_push_port` | 5557 | Envio das confirmações de execução |
| `inp_slippage_points` | 20 | Desvio máximo na execução |
| `inp_late_max_deviation_points` | 50 | Entrada atrasada (posição descoberta pelo snapshot) só se o preço estiver a até N pontos da entrada do master; 0 = nunca |
| `inp_symbol_map` | vazio | Tradução explícita, ex.: `EURUSD=EURUSDm;XAUUSD=GOLD` |
| `inp_suffix_map` | vazio | Troca de sufixo, ex.: `.a=m` (EURUSD.a → EURUSDm) ou `=.raw` (acrescenta) |
| `inp_sizing_mode` | Fixed factor | `Fixed factor`: lote do master × fator. `Proportional to balance/equity`: lote do master × fator × capital da conta ÷ `inp_reference_capital` |
| `inp_reference_capital` | 10000 | Capital, na moeda da conta, que copia 1× os lotes do master (ex.: master opera 1 lote para cada 10 mil) |

No modo proporcional a escala é calculada quando a cópia abre e fica gravada no mapeamento: o equity oscilando depois não aumenta nem reduz a posição. O volume nunca fica abaixo do mínimo do símbolo, então contas muito pequenas copiam o lote mínimo. O teto de lotes da licença continua valendo.

## Checklist no MT5 (contas demo)

Faça isto antes de liberar para clientes. Use uma conta hedging, uma netting e uma com sufixo de símbolo.

- [ ] Abrir com SL/TP, mover o SL, fazer parcial de 50%, aumentar a posição e fechar: o slave acompanha cada passo.
- [ ] Reversão numa conta netting.
- [ ] Reiniciar o terminal do slave com posição aberta: o mapeamento sobrevive (`MQL5\Files\TDM_Mirror`) e nada é duplicado.
- [ ] Slave desligado enquanto o master abre e fecha: ao voltar, a posição órfã fecha; a entrada perdida só abre se o preço estiver dentro do desvio.
- [ ] SL batendo só no slave: a posição **não** reabre.
- [ ] Duas estratégias no mesmo símbolo numa conta netting: não entra em ciclo de fecha e reabre.
- [ ] Um Slave antigo ligado ao hub novo continua copiando OPEN/CLOSE.
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

Para testar o hub sem MT5, use `tools/hub_probe.py`: `listen` mostra o que um slave recebe e `master` simula um master. Com `--ws wss://signals.trademetric.com.br`, ele usa a conexão WebSocket com a chave da licença ou do Master.

## Observabilidade

- **Latência de cópia:** o hub guarda o instante em que publicou cada `POS` e, quando o `EXEC` do slave chega com o mesmo `uid` e `seq`, grava a diferença em `executions.latency_ms` (migração `0004`). O `/health` do hub mostra `exec_latency_ms` com p50, p95 e máximo das últimas 1000 execuções. A medida começa no hub: o trecho master → hub não entra, porque o Master não envia horário confiável.
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
- **Master antigo:** fechamento parcial continua virando fechamento total, porque o formato antigo não distingue os dois.
- **Segurança:** a Fase 1 está na seção abaixo. O barramento ZMQ (portas 5557/5556) continua sem autenticação até o corte (seção v4): quem assinar o PUB lê todos os portfólios.

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
3. **Chaves do Master:** desde a v4, cada gestor cria e revoga as próprias chaves no painel (seção v4). A rotação em massa acontece no corte do ZMQ.

**O que mudou para quem usa o dashboard**
- O `/ws` só aceita conexão depois de receber `{"type": "AUTH", "token": ...}`. Cada manager vê só as próprias posições, e o TDM_DEV vê todas. Uma conta CLIENT é recusada (código 4403), porque ainda não existe vínculo entre cliente e manager.
- O token é renovado sozinho um minuto antes de expirar, até o limite de `SESSION_MAX_HOURS` desde o login. Um token expirado ou uma resposta 401 levam de volta para o login.
- Um manager congelado perde o acesso na hora, sem esperar o token expirar.
- Licença é sempre de portfólio: `POST /licenses` exige `portfolio_id`. Para vender uma estratégia avulsa, crie um portfólio só com ela. Licenças antigas por estratégia continuam listadas, mas nunca autenticaram no EA.
- `/token` e `/api/license/check` respondem `429` depois de `AUTH_MAX_FAILURES` falhas do mesmo IP em `AUTH_FAILURE_WINDOW_SECONDS`. O IP vem do `X-Forwarded-For`, mas só de um proxy na rede privada (`FORWARDED_ALLOW_IPS` no `Dockerfile`): o endereço que o cliente escreve no cabeçalho é ignorado.
