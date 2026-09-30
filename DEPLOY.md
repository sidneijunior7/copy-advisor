# Deploy e rollout — TDM Mirror v3

## Arquitetura

O monólito passa a ser dois serviços, construídos a partir do mesmo repositório:

| Serviço | Dockerfile | O que faz | Portas |
|---|---|---|---|
| `mirror-api` | `Dockerfile` | API, dashboard e `/ws`; roda `migrate.py` ao subir | 8000 (domínio `mirrorserver.trademetric.com.br`) |
| `mirror-hub` | `Dockerfile.hub` | Recebe os Masters, publica para os Slaves, grava sinais | 5555 e 5556 publicadas no host; 5558 e 8001 só na rede interna |

Um deploy da API não derruba mais os sinais. O hub roda sozinho, com o próprio `/health` na porta 8001.

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
- Portas publicadas: `5555` e `5556`.
- **Uma réplica.** Se o EasyPanel permitir escolher a ordem de update, use *stop-first*. Com dois hubs no ar ao mesmo tempo, os Masters podem ir para um e os Slaves ficarem no outro.

**`mirror-api` (serviço atual)**
- **Remover** as portas publicadas `5555` e `5556`; elas passam para o hub.
- Variáveis novas (use o hostname interno do hub, que o EasyPanel mostra na página do serviço, algo como `<projeto>_mirror-hub`):
  - `HUB_EVENTS_URL=tcp://<hostname-do-hub>:5558`
  - `HUB_HEALTH_URL=http://<hostname-do-hub>:8001/health`

A lista completa de variáveis está em `.env.example`.

**Conferência:** `GET https://mirrorserver.trademetric.com.br/health` deve mostrar `"status": "healthy"` e o bloco `hub` com `"warming": false`.

## Ordem de rollout

1. **Janela de manutenção:** criar o `mirror-hub`, mover as portas 5555/5556 e fazer o deploy da API. Com `HUB_LEGACY_PUBLISH=1`, os EAs antigos continuam funcionando: o hub aceita o formato antigo do Master e publica as linhas `OPEN`/`CLOSE` que o Slave antigo entende.
2. **Masters:** instalar o Master v3 **com a conta sem posição aberta**. A versão antiga truncava `pos_id` grandes, então uma posição aberta com ela ganharia identidade nova na troca. Configurar o input novo `InpServer`, que antes era um `127.0.0.1` fixo no código.
3. **Slaves:** distribuir o Slave v3 com a instrução de instalar **sem posição copiada aberta**. Posições do EA antigo (comentário `Copy ZMQ`) não são geridas pela v3, e o EA avisa no log quando encontra alguma.
4. **Desligar o legado:** com todos os clientes atualizados, `HUB_LEGACY_PUBLISH=0`.

### Inputs novos do Slave

| Input | Padrão | Uso |
|---|---|---|
| `inp_push_port` | 5555 | Envio das confirmações de execução |
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

Para testar o hub sem MT5, use `tools/hub_probe.py`: `listen` mostra o que um slave recebe e `master` simula um master.

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
- **Segurança:** a Fase 1 está na seção abaixo. O barramento ZMQ (portas 5555/5556) continua sem autenticação; isso depende da troca de transporte.

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
3. **`master_key`:** cada manager pode gerar uma chave nova com `POST /me/manager/rotate-key`, e depois precisa atualizar todos os Masters dele. Enquanto o transporte for ZMQ em claro, a chave nova vaza do mesmo jeito que a antiga. Por isso a rotação em massa fica para quando o transporte mudar.

**O que mudou para quem usa o dashboard**
- O `/ws` só aceita conexão depois de receber `{"type": "AUTH", "token": ...}`. Cada manager vê só as próprias posições, e o TDM_DEV vê todas. Uma conta CLIENT é recusada (código 4403), porque ainda não existe vínculo entre cliente e manager.
- O token é renovado sozinho um minuto antes de expirar, até o limite de `SESSION_MAX_HOURS` desde o login. Um token expirado ou uma resposta 401 levam de volta para o login.
- Um manager congelado perde o acesso na hora, sem esperar o token expirar.
- Licença é sempre de portfólio: `POST /licenses` exige `portfolio_id`. Para vender uma estratégia avulsa, crie um portfólio só com ela. Licenças antigas por estratégia continuam listadas, mas nunca autenticaram no EA.
- `/token` e `/api/license/check` respondem `429` depois de `AUTH_MAX_FAILURES` falhas do mesmo IP em `AUTH_FAILURE_WINDOW_SECONDS`. O IP vem do `X-Forwarded-For` do proxy do EasyPanel (`FORWARDED_ALLOW_IPS=*` no `Dockerfile`).
