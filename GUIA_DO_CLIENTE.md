# Trademetric Copy Trader: guia do cliente

O EA **Trademetric Copy Trader Slave** copia para a sua conta do MetaTrader 5 as operações das estratégias do portfólio que você assinou. Ele roda no seu terminal, e as ordens saem da sua conta, na sua corretora.

## Antes de começar

- **MetaTrader 5** instalado no Windows e conectado à conta que vai copiar. A licença vale para um número de conta só.
- **O terminal precisa ficar aberto e conectado** durante o horário das estratégias. Com o computador desligado, nada é copiado. Se puder, use uma VPS Windows.
- **Você recebe da Trademetric** o arquivo `Trademetric Copy Trader Slave.ex5` e a **chave da licença**, que começa com `lic_`. Guarde a chave; se perder, peça uma nova.
- **Margem:** a corretora precisa aceitar o lote copiado. Na B3, o mínimo é 1 contrato, mesmo em contas pequenas.

## Instalação

1. No MetaTrader 5, abra **Arquivo › Abrir pasta de dados**, entre em `MQL5\Experts` e copie o arquivo para lá. Depois, no **Navegador**, clique com o botão direito em **Expert Advisors** e em **Atualizar**.
2. Em **Ferramentas › Opções › Expert Advisors**:
   - marque **Permitir negociação algorítmica**;
   - marque **Permitir WebRequest para as URLs listadas** e adicione `https://signals.trademetric.com.br`, exatamente assim, **sem porta**;
   - **Permitir importação de DLL** pode ficar desligado.
3. Abra **um** gráfico de qualquer ativo e qualquer tempo gráfico e arraste o EA para ele. O ativo do gráfico não importa: o EA copia todos os ativos das estratégias.
4. Na aba **Comum**, marque **Permitir negociação algorítmica**.
5. Na aba **Entradas**, cole a chave em **License key** e ajuste o tamanho das posições (veja abaixo). Clique em **OK**.
6. Confira se o botão **Algo Trading**, na barra de ferramentas, está ligado (verde).

## Como saber se está funcionando

O canto do gráfico mostra:

```
TDM Mirror Slave 4.03
Hub: conectado, portfólio 3
Licença: ativa, limite 2.00 lotes
Cópias abertas: 0
```

| No gráfico | O que fazer |
|---|---|
| Hub: conexão bloqueada pelo terminal: adicione https://signals.trademetric.com.br... | Volte ao passo 2 e adicione o endereço, sem porta. |
| Hub: chave de licença recusada | Confira a chave colada. Se estiver certa, peça uma nova à Trademetric. |
| Hub: licença de outra conta | A licença é de outro número de conta. Use a conta certa ou peça o ajuste. |
| Hub: chave trocada ou licença removida | Peça a chave nova e cole em **License key**. |
| Hub: parado: outro terminal está usando esta licença | A licença é de um terminal só, e o último a conectar assume. Remova o EA do outro terminal e recoloque neste. |
| Licença: revogada ou expirada (só gere as abertas) | Renove a assinatura. Enquanto isso o EA não abre nada novo, mas acompanha as posições abertas até a estratégia fechá-las. |
| Sincronizando... | Normal logo depois de conectar; some em segundos. Se ficar mais de um minuto, confira o botão **Algo Trading** e a opção da aba **Comum**: sem elas o EA conecta, mas não opera. |

Se o gráfico não mostra nada, o EA não carregou. O motivo aparece na aba **Experts** da Caixa de Ferramentas; o mais comum é a chave colada sem o `lic_` do começo.

## Tamanho das posições (aba Entradas)

- **Sizing = Fixed factor** (padrão): o lote da estratégia multiplicado por **inp_lots_factor**. Com **inp_lots_op** em *Divide*, o lote é dividido pelo fator. Exemplo: fator 2 copia o dobro, e fator 2 com *Divide* copia a metade.
- **Sizing = Proportional to balance** ou **Proportional to equity**: o lote acompanha o seu saldo (ou patrimônio). Em **Proportional: capital...**, informe o capital que copia o lote da estratégia por inteiro. Exemplo: com 10000 nesse campo e saldo de 5000, você copia metade do lote. A proporção é fixada na abertura de cada posição.
- O volume nunca fica abaixo do mínimo do ativo: contas pequenas copiam o mínimo, então confira a margem.
- O seu plano tem um **limite de lotes**, que vale para a soma das posições abertas. O que passar do limite não é copiado.

## Outras entradas

- **SL/TP:** *Same distance from entry* (padrão) coloca o stop e o alvo à mesma distância da entrada que na estratégia. É o certo quando a sua corretora tem cotação diferente da corretora da estratégia, como em cripto e forex. Na B3, as duas opções dão praticamente o mesmo resultado.
- **inp_copy_sltp:** deixe em *true*. Em *false*, as posições ficam sem stop e sem alvo e só fecham quando a estratégia fechar.
- **Late entry: max distance from master price:** se o terminal estava desligado quando a estratégia abriu uma posição, o EA só entra depois se o preço estiver a até esse número de pontos da entrada da estratégia. Com 0, ele nunca entra atrasado.
- **Max slippage (points):** o desvio máximo aceito na execução.
- **Symbol map** e **Suffix map:** só se a sua corretora usa nomes de ativos diferentes (por exemplo, `EURUSD.a` em vez de `EURUSD`). Na B3 não é preciso. Em caso de dúvida, fale com a Trademetric.
- As demais entradas (Server, Port, TLS, Timer, magic numbers) ficam como estão.

## No dia a dia

- **Não mexa nas posições copiadas.** Uma cópia que você fechar não é reaberta: o EA entende que você decidiu sair. Um stop ou alvo que você mudar volta ao da estratégia em até 15 segundos.
- **Conta netting (a regra na B3):** a posição é uma só por ativo. Não opere manualmente, nem com outro robô, os mesmos ativos da estratégia nessa conta: o EA ajusta a posição do ativo ao que a estratégia tem.
- **Reiniciar o terminal ou o computador** é seguro: o EA retoma as cópias abertas sem duplicar nada.
- **Se o terminal ficar desligado,** ao voltar o EA fecha o que a estratégia fechou nesse meio-tempo. Uma entrada perdida só é feita se o preço ainda estiver perto (veja *Late entry*).
- **Trocar de computador ou de VPS:** faça a troca **sem posições abertas** e remova o EA da máquina antiga.
- **Atualizações:** quando a Trademetric enviar uma versão nova, substitua o arquivo em `MQL5\Experts`. O terminal recarrega o EA, e as cópias abertas continuam.

## Suporte

Quando algo não for copiado, envie à Trademetric:
- o número da conta e o horário;
- um print do gráfico com o EA;
- o log da aba **Experts** da Caixa de Ferramentas (clique com o botão direito › **Abrir**), que fica em `MQL5\Logs`, num arquivo por dia.

## Riscos e termos de uso

*[A definir com o jurídico: aviso de risco, termos de uso e o enquadramento do serviço.]*
