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

## Limitações conhecidas

- **Netting:** o Slave ajusta a posição líquida do símbolo inteiro. Operar manualmente o mesmo símbolo numa conta netting copiada faz o EA "corrigir" a operação manual. Com várias cópias no mesmo símbolo, o SL/TP não é copiado.
- **Master antigo:** fechamento parcial continua virando fechamento total, porque o formato antigo não distingue os dois.
- **Fora deste trabalho:** tudo que é segurança (SEC-*). O `/ws` e o barramento ZMQ continuam sem autenticação.
