# Spike de terminais hospedados

Mede quantos MetaTrader 5 cabem num container e quanto cada um consome. Um container ("pod") roda N terminais `/portable` no mesmo Wine e no mesmo Xvfb. Cada terminal fica numa pasta própria (um "slot"), loga numa conta e roda um EA anexado pelo arquivo de partida (`/config:start.ini`). Tudo é local, e os nomes começam com `tdm-spike`.

| Serviço | O que é |
|---|---|
| `tdm-spike-db` | Postgres descartável |
| `tdm-spike-api` | API do repositório; migra e roda `seed.py` ao subir |
| `tdm-spike-hub` | hub do repositório |
| `tdm-spike-pod` | os terminais (`pod.sh`), sobre a imagem do mt5-worker do Drawdown Guard |

## Preparar

`tools/spike/ea/` precisa dos EAs compilados e das DLLs do ZMQ, que só a sonda usa: o Master e o Slave v4 falam WebSocket e rodam com "Allow DLL imports" desligado. A pasta não vai para o Git.

```bash
powershell -File tools/compile_eas.ps1 -Files "Trademetric Copy Trader Slave.mq5","Trademetric Copy Trader Master.mq5","Trademetric Spike Probe.mq5"
cp "<pasta do build>"/*.ex5 tools/spike/ea/
cp "<pasta de dados do MT5>/MQL5/Libraries/"lib*.dll tools/spike/ea/
```

Mais dois arquivos vão em `tools/spike/ea/`:

- **`servers.dat`:** vem do `config/` de um MT5 que já conectou na corretora. Sem ele o terminal não conhece o servidor e nunca conecta, sem dar erro.
- **`webrequest_url.txt`:** a linha `WebRequestUrl=...` do `config/common.ini`. A lista de URLs liberadas fica cifrada ali e o `start.ini` não a preenche. Para gerar a linha:
  1. Abra um terminal desta imagem **sem** `/config`, porque só assim ele grava o `common.ini`.
  2. Libere `http://api.spike.test:8000` (a sonda faz `WebRequest` na API) e `http://hub.spike.test` (os EAs v4 abrem socket para o hub) em *Tools → Options → Expert Advisors*. No Wine, o campo abre com F2. Depois, feche o terminal normalmente.
  3. Copie a linha para o arquivo.

  Sem tela, dá para fazer isso dentro do pod com `xdotool` e conferir cada passo com `import -window root` no `DISPLAY=:99`.

  Cuidados com a lista:
  - A linha vale em qualquer slot da mesma imagem; a de outra máquina não vale.
  - O MT5 recusa hostname sem ponto, por isso a API tem o alias `api.spike.test` e o hub, `hub.spike.test`.
  - Para socket (`SocketConnect`), a entrada precisa estar **sem porta**. Com `http://hub.spike.test`, o socket abre em qualquer porta. Com `http://api.spike.test:8000`, o `WebRequest` funciona, mas o socket para a mesma porta é recusado com o erro 4014.
  - `127.0.0.1` também precisa estar na lista.

Para o modo `slave`, as contas demo ficam em `tools/spike/private/accounts.json`. A pasta não vai para o Git nem para as imagens.

```json
[{"login": 1234567, "password": "...", "server": "MetaQuotes-Demo"}]
```

O `seed.py` cria a chave do Master `spike-master-key` e dois portfólios, cada um com uma licença por login:
- **Spike:** estratégia de magic 777001, alimentada pelo `fake_master.py`. A chave do login N é `lic_spike_N`.
- **Echo:** estratégia de magic 5457873, o magic padrão do Slave, alimentada por um Master EA. A chave é `lic_echo_N`.

Ele roda toda vez que a API sobe. Quando trocar as contas, reinicie a API.

## Rodar

```bash
cd tools/spike
docker compose up -d --build                                 # 3 slots com a sonda, sem conta
SLOTS=5 EA=slave docker compose up -d --force-recreate tdm-spike-pod
PLAN=slave@0,master@0,echo@1 SLAVE_KEEP_MAGIC=false docker compose up -d --force-recreate tdm-spike-pod
docker exec tdm-spike-hub python -u spike/fake_master.py --symbol WINZ26 --cycles 3
docker compose logs -f tdm-spike-pod
docker compose down                                          # -v apaga banco e slots
```

## Hospedagem (pod de produção contra esta stack)

O serviço `tdm-spike-hosted` roda o `Dockerfile.pod` da raiz, com o `pod_agent.py`. Ele sobe pelo profile `hosting` e usa a chave `pod_spike_local`, que o `seed.py` cria:

```bash
docker compose --profile hosting up -d tdm-spike-hosted
```

Os terminais vêm da API, como em produção (`PUT /licenses/{id}/hosting`). Para logar no painel local, dê uma senha ao gestor do spike com `create_admin.py spike-manager@local` dentro do `tdm-spike-api` e copie o `frontend/dist` para `/app/frontend/` do container. O `seed.py` não troca a chave de uma licença hospedada, porque o pod tem a dela.

**Lista do WebRequest do pod (`pod/webrequest_url.txt`):** foi gerada assim, num container da imagem do pod:
1. Suba o Xvfb e o desktop do Wine como o `pod_agent.py` faz, crie uma pasta de terminal e abra o `terminal64.exe /portable` **sem** `/config`.
2. Feche o assistente de abertura de conta (Cancel), abra *Tools → Options* (Ctrl+O) e vá à aba *Experts*.
3. Em cada URL, clique na linha "add new URL", aperte F2, digite e confirme com Enter: `https://signals.trademetric.com.br` e `http://hub.spike.test`.
4. Clique em OK, feche o terminal com `wine taskkill /IM terminal64.exe` e copie a linha `WebRequestUrl=` do `config/common.ini` (UTF-16).

Confira cada passo com `import -window root` no `DISPLAY=:99`.

- **`EA=probe`:** roda `Trademetric Spike Probe.mq5`, que não precisa de conta. Ela responde se o terminal carrega a DLL do ZMQ, se recebe o heartbeat do hub e se o `WebRequest` é liberado pela configuração de partida. Os logs dela começam com `PROBE`. Desde o corte do ZMQ o hub não publica mais na 5556, então o teste de heartbeat da sonda falha; a carga da DLL e o `WebRequest` continuam valendo.
- **`EA=slave`:** roda o Slave v4 de verdade no portfólio Spike, por WebSocket e sem DLL.
- **`PLAN`:** define um papel por slot (`slave`, `echo`, `master` ou `probe`) e a conta de cada um, pelo índice em `accounts.json`. No exemplo, os dois EAs v4 rodam em cadeia:
  1. o `fake_master.py` publica no Spike;
  2. o Slave da conta 0 copia, com o magic dele (`SLAVE_KEEP_MAGIC=false`);
  3. o Master, também na conta 0, publica essa cópia no Echo;
  4. o Slave da conta 1 copia do Echo.

## Resultados (`tools/spike/out/`)

- **`metrics.csv`:** uma linha por terminal a cada 30 s, com PSS e RSS em MB, CPU (% de um núcleo) e threads. A linha `all` traz o total do container, lido do cgroup. O PSS divide as páginas compartilhadas entre os processos, então é o número que se soma.
- **`pod.log`:** o que o `pod.sh` fez, além dos avisos de LiveUpdate.
- **`logs/slot-NN-journal.log` e `logs/slot-NN-experts.log`:** o diário do terminal e o log dos EAs, em UTF-8.
