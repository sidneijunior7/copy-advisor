# Spike de terminais hospedados

Mede quantos MetaTrader 5 cabem num container e quanto cada um consome. Um container ("pod") roda N terminais `/portable` no mesmo Wine e no mesmo Xvfb. Cada terminal fica numa pasta própria (um "slot"), loga numa conta e roda um EA anexado pelo arquivo de partida (`/config:start.ini`). Tudo é local, e os nomes começam com `tdm-spike`.

| Serviço | O que é |
|---|---|
| `tdm-spike-db` | Postgres descartável |
| `tdm-spike-api` | API do repositório; migra e roda `seed.py` ao subir |
| `tdm-spike-hub` | hub do repositório |
| `tdm-spike-pod` | os terminais (`pod.sh`), sobre a imagem do mt5-worker do Drawdown Guard |

## Preparar

`tools/spike/ea/` precisa do Slave e da sonda compilados, além das DLLs do ZMQ. A pasta não vai para o Git.

```bash
powershell -File tools/compile_eas.ps1 -Files "Trademetric Copy Trader Slave.mq5","Trademetric Spike Probe.mq5"
cp "<pasta do build>"/*.ex5 tools/spike/ea/
cp "<pasta de dados do MT5>/MQL5/Libraries/"lib*.dll tools/spike/ea/
```

Mais dois arquivos vão em `tools/spike/ea/`:

- **`servers.dat`:** vem do `config/` de um MT5 que já conectou na corretora. Sem ele o terminal não conhece o servidor e nunca conecta, sem dar erro.
- **`webrequest_url.txt`:** a linha `WebRequestUrl=...` do `config/common.ini`. A lista de URLs liberadas fica cifrada ali e o `start.ini` não a preenche. Para gerar a linha:
  1. Abra um terminal desta imagem **sem** `/config`, porque só assim ele grava o `common.ini`.
  2. Libere `http://api.spike.test:8000` em *Tools → Options → Expert Advisors* (no Wine, o campo abre com F2) e feche o terminal normalmente.
  3. Copie a linha para o arquivo.

  A linha vale em qualquer slot da mesma imagem; a de outra máquina não vale. O MT5 recusa hostname sem ponto na lista, por isso a API tem o alias `api.spike.test`.

Para o modo `slave`, as contas demo ficam em `tools/spike/private/accounts.json`. A pasta não vai para o Git nem para as imagens.

```json
[{"login": 1234567, "password": "...", "server": "MetaQuotes-Demo"}]
```

O `seed.py` cria uma licença para cada login. Ele roda toda vez que a API sobe. Quando trocar as contas, reinicie a API.

## Rodar

```bash
cd tools/spike
docker compose up -d --build                                 # 3 slots com a sonda, sem conta
SLOTS=5 EA=slave docker compose up -d --force-recreate tdm-spike-pod
docker compose logs -f tdm-spike-pod
docker compose down                                          # -v apaga banco e slots
```

- **`EA=probe`:** roda `Trademetric Spike Probe.mq5`, que não precisa de conta. Ela responde se o terminal carrega a DLL do ZMQ, se recebe o heartbeat do hub e se o `WebRequest` é liberado pela configuração de partida. Os logs dela começam com `PROBE`.
- **`EA=slave`:** roda o Slave de verdade, assinando o portfólio `spike-portfolio-key`.

## Resultados (`tools/spike/out/`)

- **`metrics.csv`:** uma linha por terminal a cada 30 s, com PSS e RSS em MB, CPU (% de um núcleo) e threads. A linha `all` traz o total do container, lido do cgroup. O PSS divide as páginas compartilhadas entre os processos, então é o número que se soma.
- **`pod.log`:** o que o `pod.sh` fez, além dos avisos de LiveUpdate.
- **`logs/slot-NN-journal.log` e `logs/slot-NN-experts.log`:** o diário do terminal e o log dos EAs, em UTF-8.
