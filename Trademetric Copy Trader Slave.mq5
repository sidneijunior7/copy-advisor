//+------------------------------------------------------------------+
//|                                Trademetric Copy Trader Slave.mq5 |
//|                                 Copyright 2026, Trademetric Inc. |
//|                                   https://www.trademetric.com.br |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Trademetric Inc."
#property link      "https://www.trademetric.com.br"
#property version   "4.01"
#define VERSAO "4.01"

#include <Trade\Trade.mqh>
#include "Include/TDM/WsClient.mqh"

// Protocolo v2, cada mensagem traz o estado completo de uma posição do master:
//   POS|epoch|seq|uid|type|symbol|vol|price_open|sl|tp|magic|reason   (vol 0 = fechada)
//   SNAP|epoch|seq|uid,type,symbol,vol,price_open,sl,tp,magic;...      (estado completo do portfólio)
//   HB|epoch|seq                                                        (heartbeat, repete o último seq)
// A mesma função, AplicarEstado(), leva a posição local ao estado do master tanto para POS quanto
// para SNAP. Um slave que perdeu mensagens converge no próximo SNAP.
//
// Transporte: wss://<inp_ws_host>/v1/slave, autenticado pela chave da licença (lic_...). Sem DLL e sem
// WebRequest para a API: o hub valida a licença, informa o limite de lotes e manda o SNAP na conexão.
// (O v3, por ZMQ, continua atendido pelo hub até o desligamento; um binário com #import de DLL só roda
// com "Allow DLL imports", mesmo sem chamá-la, por isso o ZMQ não está aqui.)
//   EA -> hub  HELLO|slave|v1|<chave>|<login>|<versão>|<epoch>|<seq> · ACK|epoch|seq (a cada HB) · EXEC|...
//   hub -> EA  WELCOME|epoch|hb_s|portfolio|ativa|max_lots · LIC|ativa|max_lots · ERR|código|motivo
//              SKIP|epoch|seq: seq consumido por uma posição que esta licença não acompanha

enum ENUM_OPERATOR_LOTS
   {
      multiply = 0,//Multiply [*]
      divide = 1   //Divide [/]
   };

enum ENUM_SIZING
   {
      sizing_factor = 0,  //Fixed factor
      sizing_balance = 1, //Proportional to balance
      sizing_equity = 2   //Proportional to equity
   };

sinput string inp_connection_key = "YOUR_LICENSE_KEY"; // License key (lic_..., dashboard: Clients)
sinput string inp_ws_host = "signals.trademetric.com.br"; // Server
sinput int inp_ws_port = 443; // Port
sinput bool inp_ws_tls = true; // TLS
sinput int inp_timer = 100; // Timer (ms)
sinput ulong inp_standard_magic_number = 5457873;
sinput bool inp_keep_original_magic = true;
sinput bool inp_copy_sltp = true;
sinput double inp_lots_factor = 1;
sinput ENUM_OPERATOR_LOTS inp_lots_op = 0;
sinput ENUM_SIZING inp_sizing_mode = sizing_factor; // Sizing
sinput double inp_reference_capital = 10000; // Proportional: capital (account currency) that copies 1x the master lots
sinput string inp_magic_to_copy = "0";
sinput int inp_slippage_points = 20; // Max slippage (points)
sinput int inp_late_max_deviation_points = 50; // Late entry: max distance from master price (points, 0 = never)
sinput string inp_symbol_map = ""; // Symbol map (EURUSD=EURUSDm;WINV26=WINV26)
sinput string inp_suffix_map = ""; // Suffix map (.a=m;=.raw)

// Uma cópia = uma posição do master (uid = <login do master>_<POSITION_IDENTIFIER>)
struct Copia {
   string uid;
   string symbol;  // Símbolo local (já traduzido)
   int    type;    // 0 = buy, 1 = sell
   double alvo;    // Volume local desejado
   double escala;  // Volume local por lote do master, fixada na abertura (o equity oscilando não mexe na posição)
   long   magic;   // Magic do master
   bool   done;    // Fechada fora do EA (SL/TP/manual): nunca reabre
};
// Hedging: posições locais (POSITION_IDENTIFIER) de cada cópia
struct Vinculo {
   string uid;
   long   pos;
};
// Netting: identificador da posição líquida de cada símbolo, para detectar fechamento externo
struct Liquido {
   string symbol;
   long   pos;
};
// Ordem aceita cuja posição ainda não apareceu (execução em bolsa)
struct Pendente {
   string uid;
   string symbol;
   int    dir;     // +1 buy, -1 sell
   double vol;
   ulong  order;
   ulong  since;
};
struct Traducao {
   string master;
   string local;   // "" = símbolo indisponível
};

// Variáveis Globais
// Trocar os inputs roda o OnInit de novo sem recarregar o EA: o OnInit reinicia o estado da conexão
CWsClient ws;
bool   autenticado = false;   // WELCOME recebido nesta conexão
bool   parado = false;        // Outro terminal assumiu a licença; este não reconecta
int    portfolio_id = 0;      // Portfólio da licença, do WELCOME
string adiadas[];             // Fluxo recebido enquanto o terminal não pode operar
string estado_hub = "";       // Linha de estado no gráfico
bool   erro_do_hub = false;   // estado_hub veio de um ERR: o erro genérico do fechamento não o substitui
ulong  proximo_comentario = 0;
CTrade trade;

Copia    copias[];
Vinculo  vinculos[];
Liquido  liquidos[];
Pendente pendentes[];
Traducao traducoes[];
string   avisados[];     // Chaves de log já emitidas (log uma vez)
string   falhas_sltp[];  // "uid|sl|tp" que o broker recusou: não insiste

bool   hedging;
long   login;
double lots_factor;
double max_lots_limit = 0; // Limit from License
ulong  standard_magic_number;
string s_magic_to_copy[];
bool   licenca_ativa = true;

string last_epoch = "";
long   last_seq = 0;
bool   need_snap = true;

bool   was_ready = false;
ulong  ready_at = 0;
bool   dirty = false;
string map_file;
string lock_name;
string comment_tag;

const int   WARMUP_MS = 5000;           // Posições e histórico carregam depois do OnInit
const ulong PENDING_TIMEOUT_MS = 60000;
const int   MAX_ADIADAS = 20000;        // Acima disso descarta e espera o próximo SNAP

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit() {
   if(StringFind(inp_connection_key, "lic_") != 0) {
      Print("Informe a chave da licença (lic_...), gerada no painel em Clientes. A chave do portfólio era do EA v3.");
      return(INIT_PARAMETERS_INCORRECT);
   }
   standard_magic_number = inp_standard_magic_number == 0 ? (ulong)MathRand() : inp_standard_magic_number;
   StringSplit(inp_magic_to_copy, ',', s_magic_to_copy);

   if(inp_lots_factor <= 0){Print("Lots Factor must be greater than zero."); return(INIT_FAILED);}
   lots_factor = inp_lots_op==multiply ? inp_lots_factor : (1/inp_lots_factor);
   if(inp_sizing_mode != sizing_factor && inp_reference_capital <= 0) {Print("Reference capital must be greater than zero."); return(INIT_FAILED);}

   login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(login <= 0) {Print("Conta não identificada. Faça login e reinicie o EA."); return(INIT_FAILED);}
   hedging = AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING;

   string key8 = StringSubstr(inp_connection_key, 0, 8);
   lock_name = StringFormat("TDM_LOCK_%I64d_%s", login, key8);
   if(!AdquirirTrava()) {
      Print("Já existe outra instância deste EA com a mesma chave nesta conta. Remova a duplicada.");
      return(INIT_FAILED);
   }
   FolderCreate("TDM_Mirror");
   AvisarPosicoesAntigas();
   trade.SetExpertMagicNumber(standard_magic_number);
   trade.SetDeviationInPoints(inp_slippage_points);
   // Numa re-inicialização as globais do fluxo ainda são da conexão anterior: recomeça pelo snapshot
   last_epoch = "";
   last_seq = 0;
   need_snap = true;
   licenca_ativa = true;

   // O mapeamento e a tag dos comentários dependem do portfólio, que vem no WELCOME: trocar a chave da
   // licença não perde as cópias abertas
   ArrayResize(copias, 0);
   ArrayResize(vinculos, 0);
   ArrayResize(liquidos, 0);
   ArrayResize(pendentes, 0);
   ArrayResize(adiadas, 0);
   portfolio_id = 0;
   autenticado = false;
   parado = false;
   MathSrand((uint)(GetTickCount() ^ (uint)login));
   ws.Configurar(inp_ws_host, inp_ws_port, "/v1/slave", inp_ws_tls);
   estado_hub = "conectando...";
   EventSetMillisecondTimer(inp_timer <= 0 ? 100 : inp_timer);
   PrintFormat("Slave %s | %s | conta %I64d (%s)", VERSAO, inp_ws_host, login, hedging ? "hedging" : "netting");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {
   EventKillTimer();
   if(dirty && map_file != "") SalvarMapa();
   LiberarTrava();
   ws.Desconectar();
   map_file = "";
   Comment("");
}

//+------------------------------------------------------------------+
//| Terminal conectado, autotrading liberado e aquecido              |
//+------------------------------------------------------------------+
bool Pronto() {
   bool ok = TerminalInfoInteger(TERMINAL_CONNECTED) != 0 &&
             TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0 &&
             MQLInfoInteger(MQL_TRADE_ALLOWED) != 0;
   if(!ok) {
      if(was_ready) Print("Aguardando conexão com o broker / AutoTrading...");
      was_ready = false;
      ready_at = 0;
      return false;
   }
   if(ready_at == 0) ready_at = GetTickCount64() + WARMUP_MS;
   if(GetTickCount64() < ready_at) return false;
   if(!was_ready) {
      was_ready = true;
      Print("Pronto para copiar");
   }
   return true;
}

void OnTrade() {
   if(map_file != "" && Pronto()) AtualizarVinculos();
}

//+------------------------------------------------------------------+
//| Conexão com o hub, licença e fluxo                               |
//+------------------------------------------------------------------+
void OnTimer() {
   ws.Processar();
   if(ws.NovaConexao()) {
      autenticado = false;
      ws.Enviar(StringFormat("HELLO|slave|v1|%s|%I64d|%s|%s|%I64d", inp_connection_key, login, VERSAO,
                             last_epoch == "" ? "0" : last_epoch, last_seq));
      estado_hub = "autenticando...";
   }
   bool pronto = Pronto();
   if(pronto) {
      ResolverPendentes();
      // O que chegou enquanto o terminal não podia operar, na ordem
      for(int i = 0; i < ArraySize(adiadas); i++) ProcessarWss(adiadas[i]);
      ArrayResize(adiadas, 0);
   }
   string msg;
   for(int n = 0; n < 2000 && ws.Receber(msg); n++) {
      if(pronto || !Fluxo(msg)) ProcessarWss(msg);
      else if(ArraySize(adiadas) < MAX_ADIADAS) Adicionar(adiadas, msg);
      else {
         ArrayResize(adiadas, 0);
         MarcarLacuna();
      }
   }
   if(!ws.Aberto() && !parado && !erro_do_hub && ws.UltimoErro() != "") estado_hub = ws.UltimoErro();
   if(dirty && map_file != "") SalvarMapa();
   MostrarEstado();
}

// POS, SNAP, HB e SKIP dependem do terminal pronto; WELCOME, LIC e ERR, não
bool Fluxo(string msg) {
   return StringFind(msg, "POS|") == 0 || StringFind(msg, "SNAP|") == 0 || StringFind(msg, "HB|") == 0 ||
          StringFind(msg, "SKIP|") == 0;
}

void ProcessarWss(string msg) {
   if(StringFind(msg, "WELCOME|") == 0) {Welcome(msg); return;}
   if(StringFind(msg, "ERR|") == 0) {ErroDoHub(msg); return;}
   if(!autenticado || map_file == "") return;  // Linhas de uma conexão anterior ao WELCOME
   if(StringFind(msg, "LIC|") == 0) {
      string f[];
      if(StringSplit(msg, '|', f) == 3) AtualizarLicenca(f[1] == "1", StringToDouble(f[2]));
      return;
   }
   if(StringFind(msg, "SKIP|") == 0) {
      string f[];
      if(StringSplit(msg, '|', f) != 3) return;
      long seq = StringToInteger(f[2]);
      if(f[1] != last_epoch) {last_epoch = f[1]; MarcarLacuna();}
      else if(seq != last_seq + 1) MarcarLacuna();
      last_seq = seq;
      return;
   }
   Processar(msg);
   if(StringFind(msg, "HB|") == 0) ws.Enviar(StringFormat("ACK|%s|%I64d", last_epoch, last_seq));
}

void Welcome(string msg) {
   string f[];
   if(StringSplit(msg, '|', f) != 6) {Print("WELCOME inesperado: ", msg); return;}
   int pid = (int)StringToInteger(f[3]);
   if(pid != portfolio_id) {
      // Primeira conexão (ou licença de outro portfólio): mapeamento e tag passam a ser os deste portfólio
      if(dirty && map_file != "") SalvarMapa();
      portfolio_id = pid;
      comment_tag = TagDaChave("P" + IntegerToString(pid));
      map_file = StringFormat("TDM_Mirror\\%I64d_P%d.csv", login, pid);
      CarregarMapa();
      ArrayResize(pendentes, 0);
      PrintFormat("Licença do portfólio %d | %d cópias no mapeamento", pid, ArraySize(copias));
   }
   autenticado = true;
   erro_do_hub = false;
   if(f[1] != last_epoch) MarcarLacuna();  // O hub manda o SNAP logo em seguida
   AtualizarLicenca(f[4] == "1", StringToDouble(f[5]));
   estado_hub = StringFormat("conectado, portfólio %d", portfolio_id);
}

void AtualizarLicenca(bool ativa, double max_lots) {
   if(max_lots != max_lots_limit) PrintFormat("Limite de lotes da licença: %s", DoubleToString(max_lots, 2));
   max_lots_limit = max_lots;
   if(ativa == licenca_ativa) return;
   licenca_ativa = ativa;
   Print(ativa ? "Licença ativa: copiando." :
                 "Licença revogada ou expirada: novas posições não são abertas; as abertas continuam sendo geridas.");
}

void ErroDoHub(string msg) {
   string f[];
   StringSplit(msg, '|', f);
   string codigo = ArraySize(f) > 1 ? f[1] : "";
   string motivo = ArraySize(f) > 2 ? f[2] : "";
   erro_do_hub = true;
   if(codigo == "replaced") {
      parado = true;
      ws.Desconectar();
      estado_hub = "parado: outro terminal está usando esta licença";
      Print("Outro terminal conectou com esta licença e este EA parou de copiar. Mantenha uma instância só por licença.");
      return;
   }
   if(codigo == "auth") {
      estado_hub = "chave de licença recusada";
      Print("O hub recusou a chave da licença. Confira no painel (Clientes): ela pode ter sido trocada ou revogada.");
      ws.AdiarProxima(60000);
   }
   else if(codigo == "login") {
      estado_hub = "licença de outra conta";
      PrintFormat("Esta chave não é desta conta (%I64d): %s", login, motivo);
      ws.AdiarProxima(60000);
   }
   else if(codigo == "revoked") {
      estado_hub = "chave trocada ou licença removida";
      Print("A chave desta licença foi trocada ou a licença foi removida: informe a chave nova no EA.");
      ws.AdiarProxima(60000);
   }
   else if(codigo == "rate" || codigo == "busy") {
      estado_hub = "hub recusou a conexão: " + motivo;
      ws.AdiarProxima(300000);
   }
   else {
      estado_hub = "hub: " + motivo;
      PrintFormat("Hub encerrou a conexão (%s): %s", codigo, motivo);
   }
}

void MostrarEstado() {
   if(GetTickCount64() < proximo_comentario) return;
   proximo_comentario = GetTickCount64() + 1000;
   int abertas = 0;
   for(int i = 0; i < ArraySize(copias); i++) if(!copias[i].done) abertas++;
   string licenca = !autenticado ? "-" :
                    licenca_ativa ? StringFormat("ativa, limite %s lotes", DoubleToString(max_lots_limit, 2)) :
                                    "revogada ou expirada (só gere as abertas)";
   Comment(StringFormat("TDM Mirror Slave %s\nHub: %s\nLicença: %s\nCópias abertas: %d%s",
                        VERSAO, estado_hub, licenca, abertas, need_snap && autenticado ? "\nSincronizando..." : ""));
}

//+------------------------------------------------------------------+
//| Mensagens do hub                                                  |
//+------------------------------------------------------------------+
void Processar(string payload) {
   string f[];
   int n = StringSplit(payload, '|', f);
   if(n < 3) return;

   if(f[0] == "HB") {
      if(f[1] != last_epoch || StringToInteger(f[2]) != last_seq) MarcarLacuna();
      return;
   }
   if(f[0] == "POS" && n == 12) {
      long seq = StringToInteger(f[2]);
      if(f[1] != last_epoch) {
         last_epoch = f[1];
         MarcarLacuna();
      }
      else if(seq != last_seq + 1) MarcarLacuna();
      last_seq = seq;
      AplicarEstado(f[3], (int)StringToInteger(f[4]), f[5], StringToDouble(f[6]), StringToDouble(f[7]),
                    StringToDouble(f[8]), StringToDouble(f[9]), StringToInteger(f[10]), f[11] != "SYNC");
      return;
   }
   if(f[0] == "SNAP" && n >= 4) AplicarSnapshot(f[1], StringToInteger(f[2]), f[3]);
   // Linhas legadas (OPEN|..., CLOSE|...) são para EAs antigos: ignoradas
}

void MarcarLacuna() {
   if(need_snap) return;
   need_snap = true;
   Print("Mensagens perdidas ou hub reiniciado: sincronizando no próximo snapshot");
}

void AplicarSnapshot(string epoch, long seq, string entries) {
   if(need_snap) PrintFormat("Snapshot aplicado (portfólio %d)", portfolio_id);
   last_epoch = epoch;
   last_seq = seq;
   need_snap = false;
   AtualizarVinculos();

   string items[], vistos[];
   int k = StringSplit(entries, ';', items);
   for(int i = 0; i < k; i++) {
      string p[];
      if(StringSplit(items[i], ',', p) == 8) Adicionar(vistos, p[0]);
   }
   // O que não veio no snapshot foi fechado no master. Fecha antes de abrir: o limite de lotes conta o que
   // está aberto
   for(int i = ArraySize(copias) - 1; i >= 0; i--) {
      if(i < ArraySize(copias) && !Contem(vistos, copias[i].uid))
         AplicarEstado(copias[i].uid, copias[i].type, "", 0, 0, 0, 0, copias[i].magic, false);
   }
   for(int i = 0; i < k; i++) {
      string p[];
      if(StringSplit(items[i], ',', p) != 8) continue;
      AplicarEstado(p[0], (int)StringToInteger(p[1]), p[2], StringToDouble(p[3]), StringToDouble(p[4]),
                    StringToDouble(p[5]), StringToDouble(p[6]), StringToInteger(p[7]), false);
   }
}

//+------------------------------------------------------------------+
//| Leva a posição local ao estado da posição do master              |
//+------------------------------------------------------------------+
void AplicarEstado(string uid, int type, string master_symbol, double vol, double price_open,
                   double sl, double tp, long magic, bool ao_vivo) {
   if(!MagicPermitido(magic)) return;
   int c = BuscarCopia(uid);

   if(c >= 0 && copias[c].done) {
      // Encerrada fora do EA: não reabre, mas fecha o que restar quando o master fechar
      if(vol <= 0 && FecharTudo(c)) RemoverCopia(c);
      return;
   }

   string sym = c >= 0 ? copias[c].symbol : TraduzirSimbolo(master_symbol);
   if(sym == "") return;
   double escala = c >= 0 ? copias[c].escala : EscalaAtual();
   double cheio = vol > 0 ? CalcularVolume(sym, vol, escala) : 0;
   double alvo = AlvoNoLimite(c, uid, sym, cheio);
   if(cheio - alvo > 1e-9) {
      int vd = VolumeDigits(sym);
      AvisarUmaVez("limite:" + uid + ":" + DoubleToString(cheio, vd),
                   alvo > 0 ? StringFormat("Limite de %s lotes da licença: cópia %s com %s em vez de %s", DoubleToString(max_lots_limit, 2),
                                           uid, DoubleToString(alvo, vd), DoubleToString(cheio, vd))
                            : StringFormat("Limite de %s lotes da licença atingido: posição %s não copiada", DoubleToString(max_lots_limit, 2), uid));
      // A cópia passa a seguir o master na proporção que de fato recebeu: parciais continuam proporcionais
      if(alvo > 0) escala = alvo / vol;
   }

   if(c < 0) {
      if(alvo <= 0) return;
      if(!licenca_ativa) {AvisarUmaVez("lic:" + uid, "Licença inativa: posição " + uid + " não copiada"); return;}
      c = NovaCopia(uid, sym, type, magic, escala);
   }
   copias[c].escala = escala;

   bool pode_abrir = licenca_ativa && (ao_vivo || PrecoPerto(sym, type, price_open));
   bool ok = hedging ? AjustarHedging(c, type, alvo, pode_abrir, sl, tp) : AjustarNetting(c, type, alvo, pode_abrir);

   if(alvo <= 0) {
      if(ok) RemoverCopia(c);
   }
   else if(!TemExposicao(c)) {
      RemoverCopia(c);  // Nada aberto (recusado ou fora do desvio): o próximo snapshot tenta de novo
   }
   else if(inp_copy_sltp) AjustarSLTP(c, sl, tp);
   dirty = true;
}

//+------------------------------------------------------------------+
//| Hedging: uma ou mais posições locais por cópia                   |
//+------------------------------------------------------------------+
bool AjustarHedging(int c, int type, double alvo, bool pode_abrir, double sl, double tp) {
   string uid = copias[c].uid;
   string sym = copias[c].symbol;
   double half_step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP) / 2.0;
   int tipo_atual = copias[c].type;
   double atual = VolumeHedging(uid);

   if(atual > 0 && tipo_atual != type) {  // Reversão
      if(!FecharTudo(c)) return false;
      atual = 0;
   }
   copias[c].type = type;
   copias[c].alvo = alvo;

   if(alvo > atual + half_step) {
      if(atual <= 0 && AdotarPorComentario(c)) return AjustarHedging(c, type, alvo, pode_abrir, sl, tp);
      if(!pode_abrir) {AvisarAtrasada(c); return true;}
      return Abrir(c, type, NormalizarVolume(sym, alvo - atual, true), sl, tp, atual > 0 ? "ADD" : "OPEN");
   }
   if(alvo < atual - half_step) {
      if(alvo <= 0) return FecharTudo(c);
      return Reduzir(c, atual - alvo);
   }
   return true;
}

double VolumeHedging(string uid) {
   double total = 0;
   for(int i = 0; i < ArraySize(vinculos); i++) {
      if(vinculos[i].uid != uid) continue;
      if(TicketDaPosicao(vinculos[i].pos) > 0) total += PositionGetDouble(POSITION_VOLUME);
   }
   for(int i = 0; i < ArraySize(pendentes); i++)
      if(pendentes[i].uid == uid) total += pendentes[i].vol;
   return total;
}

// Fecha posições inteiras da mais nova para a mais antiga e faz parcial no resto
bool Reduzir(int c, double qty) {
   string uid = copias[c].uid;
   string sym = copias[c].symbol;
   double half_step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP) / 2.0;
   for(int i = ArraySize(vinculos) - 1; i >= 0 && qty > half_step; i--) {
      if(i >= ArraySize(vinculos) || vinculos[i].uid != uid) continue;
      long pos = vinculos[i].pos;
      ulong ticket = TicketDaPosicao(pos);
      if(ticket == 0) continue;
      double v = PositionGetDouble(POSITION_VOLUME);
      if(v <= qty + half_step) {
         if(!FecharTicket(uid, ticket, 0, "PARTIAL")) return false;
         RemoverVinculo(i);
         qty -= v;
      }
      else {
         double part = NormalizarVolume(sym, qty, false);
         if(part <= 0) return true;  // Menor que o volume mínimo: não dá para reduzir
         if(!FecharTicket(uid, ticket, part, "PARTIAL")) return false;
         qty = 0;
      }
   }
   return true;
}

bool FecharTudo(int c) {
   string uid = copias[c].uid;
   if(!hedging) {
      double alvo_antigo = copias[c].alvo;
      copias[c].alvo = 0;
      if(copias[c].done) return true;  // A posição líquida já foi fechada fora do EA
      if(!AjustarNetting(c, copias[c].type, 0, false)) {copias[c].alvo = alvo_antigo; return false;}
      return true;
   }
   for(int i = ArraySize(vinculos) - 1; i >= 0; i--) {
      if(i >= ArraySize(vinculos) || vinculos[i].uid != uid) continue;
      ulong ticket = TicketDaPosicao(vinculos[i].pos);
      if(ticket > 0 && !FecharTicket(uid, ticket, 0, "CLOSE")) return false;
      RemoverVinculo(i);
   }
   return true;
}

bool Abrir(int c, int type, double vol, double sl, double tp, string action) {
   if(vol <= 0) return true;
   string sym = copias[c].symbol;
   ENUM_ORDER_TYPE ot = type == 0 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(!TemMargem(sym, ot, vol)) {
      AvisarUmaVez("margin:" + copias[c].uid, StringFormat("Margem insuficiente para %s %s %s", action, sym, DoubleToString(vol, 2)));
      Reportar(copias[c].uid, action, 0, vol, 0, TRADE_RETCODE_NO_MONEY);
      return false;
   }
   trade.SetExpertMagicNumber(inp_keep_original_magic ? (ulong)copias[c].magic : standard_magic_number);
   PrintFormat("Abrindo cópia %s: %s %s %s", copias[c].uid, action, sym, DoubleToString(vol, VolumeDigits(sym)));
   long pos; ulong order;
   if(!Executar(copias[c].uid, sym, ot, vol, inp_copy_sltp ? sl : 0, inp_copy_sltp ? tp : 0, Comentario(copias[c].uid), action, pos, order))
      return false;
   if(pos > 0) AdicionarVinculo(copias[c].uid, pos);
   else AdicionarPendente(copias[c].uid, sym, type == 0 ? 1 : -1, vol, order);
   return true;
}

//+------------------------------------------------------------------+
//| Netting: uma posição líquida por símbolo, soma de todas as cópias|
//+------------------------------------------------------------------+
bool AjustarNetting(int c, int type, double alvo, bool pode_abrir) {
   string sym = copias[c].symbol;
   double half_step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP) / 2.0;
   int tipo_antigo = copias[c].type;
   double alvo_antigo = copias[c].alvo;
   copias[c].type = type;
   copias[c].alvo = alvo;

   double alvo_liq = AlvoLiquido(sym);
   double atual = NetAtual(sym);
   double delta = alvo_liq - atual;
   if(MathAbs(delta) <= half_step) return true;

   if(MathAbs(alvo_liq) > MathAbs(atual) + half_step && !pode_abrir) {
      copias[c].type = tipo_antigo;  // Não aumenta exposição fora do desvio
      copias[c].alvo = alvo_antigo;
      AvisarAtrasada(c);
      return true;
   }

   string action = alvo <= 0 ? "CLOSE" : (MathAbs(alvo_liq) < MathAbs(atual) ? "PARTIAL" : "OPEN");
   double vol = NormalizarVolume(sym, MathAbs(delta), MathAbs(alvo_liq) > MathAbs(atual));
   if(vol <= 0) return true;
   ENUM_ORDER_TYPE ot = delta > 0 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(MathAbs(alvo_liq) > MathAbs(atual) && !TemMargem(sym, ot, vol)) {
      AvisarUmaVez("margin:" + copias[c].uid, StringFormat("Margem insuficiente para %s %s", sym, DoubleToString(vol, 2)));
      Reportar(copias[c].uid, action, 0, vol, 0, TRADE_RETCODE_NO_MONEY);
      copias[c].type = tipo_antigo;
      copias[c].alvo = alvo_antigo;
      return false;
   }
   trade.SetExpertMagicNumber(inp_keep_original_magic ? (ulong)copias[c].magic : standard_magic_number);
   PrintFormat("Ajustando %s para %s (cópia %s, %s)", sym, DoubleToString(alvo_liq, VolumeDigits(sym)), copias[c].uid, action);
   long pos; ulong order;
   if(!Executar(copias[c].uid, sym, ot, vol, 0, 0, Comentario(copias[c].uid), action, pos, order)) {
      copias[c].type = tipo_antigo;
      copias[c].alvo = alvo_antigo;
      return false;
   }
   if(pos > 0) DefinirLiquido(sym, pos);
   else AdicionarPendente(copias[c].uid, sym, delta > 0 ? 1 : -1, vol, order);
   return true;
}

double AlvoLiquido(string sym) {
   double total = 0;
   for(int i = 0; i < ArraySize(copias); i++)
      if(copias[i].symbol == sym && !copias[i].done) total += (copias[i].type == 0 ? 1 : -1) * copias[i].alvo;
   return total;
}

double NetAtual(string sym) {
   double net = 0;
   if(PositionSelect(sym)) {
      net = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? 1 : -1) * PositionGetDouble(POSITION_VOLUME);
      DefinirLiquido(sym, PositionGetInteger(POSITION_IDENTIFIER));
   }
   for(int i = 0; i < ArraySize(pendentes); i++)
      if(pendentes[i].symbol == sym) net += pendentes[i].dir * pendentes[i].vol;
   return net;
}

int CopiasAtivasNoSimbolo(string sym) {
   int n = 0;
   for(int i = 0; i < ArraySize(copias); i++)
      if(copias[i].symbol == sym && !copias[i].done && copias[i].alvo > 0) n++;
   return n;
}

void AvisarAtrasada(int c) {
   if(!licenca_ativa) return;
   AvisarUmaVez("late:" + copias[c].uid, StringFormat("Entrada atrasada de %s em %s adiada: preço fora do desvio de %d pontos (tenta de novo a cada snapshot)",
                                                   copias[c].uid, copias[c].symbol, inp_late_max_deviation_points));
}

bool TemExposicao(int c) {
   if(hedging) return VolumeHedging(copias[c].uid) > 0;
   return copias[c].alvo > 0;
}

//+------------------------------------------------------------------+
//| SL/TP                                                            |
//+------------------------------------------------------------------+
void AjustarSLTP(int c, double sl, double tp) {
   string sym = copias[c].symbol;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double half_point = SymbolInfoDouble(sym, SYMBOL_POINT) / 2.0;
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);
   string chave = copias[c].uid + "|" + DoubleToString(sl, digits) + "|" + DoubleToString(tp, digits);
   if(Contem(falhas_sltp, chave)) return;

   ulong tickets[];
   if(hedging) {
      for(int i = 0; i < ArraySize(vinculos); i++) {
         if(vinculos[i].uid != copias[c].uid) continue;
         ulong t = TicketDaPosicao(vinculos[i].pos);
         if(t > 0) {int n = ArraySize(tickets); ArrayResize(tickets, n + 1); tickets[n] = t;}
      }
   }
   else {
      // Netting: SL/TP é da posição líquida inteira; só faz sentido com uma única cópia no símbolo
      if(CopiasAtivasNoSimbolo(sym) != 1) {
         AvisarUmaVez("sltp-net:" + sym, "Várias cópias em " + sym + " numa conta netting: SL/TP não é copiado");
         return;
      }
      if(PositionSelect(sym)) {ArrayResize(tickets, 1); tickets[0] = (ulong)PositionGetInteger(POSITION_TICKET);}
   }

   for(int i = 0; i < ArraySize(tickets); i++) {
      if(!PositionSelectByTicket(tickets[i])) continue;
      if(MathAbs(PositionGetDouble(POSITION_SL) - sl) <= half_point && MathAbs(PositionGetDouble(POSITION_TP) - tp) <= half_point) continue;
      if(!trade.PositionModify(tickets[i], sl, tp)) {
         PrintFormat("SL/TP de %s recusado (%u %s); não será tentado de novo com esses valores",
                     copias[c].uid, trade.ResultRetcode(), trade.ResultRetcodeDescription());
         Reportar(copias[c].uid, "MODIFY", 0, 0, 0, trade.ResultRetcode());
         if(ArraySize(falhas_sltp) > 500) ArrayResize(falhas_sltp, 0);
         Adicionar(falhas_sltp, chave);
         return;
      }
      Reportar(copias[c].uid, "MODIFY", (long)tickets[i], 0, 0, trade.ResultRetcode());
   }
}

//+------------------------------------------------------------------+
//| Execução com retry                                               |
//+------------------------------------------------------------------+
bool Executar(string uid, string sym, ENUM_ORDER_TYPE ot, double vol, double sl, double tp,
              string comment, string action, long &pos_out, ulong &order_out) {
   pos_out = 0;
   order_out = 0;
   trade.SetTypeFillingBySymbol(sym);
   uint rc = 0;
   for(int attempt = 0; attempt < 3; attempt++) {
      double price = ot == ORDER_TYPE_BUY ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
      trade.PositionOpen(sym, ot, vol, price, sl, tp, comment);
      rc = trade.ResultRetcode();
      if(rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL || rc == TRADE_RETCODE_PLACED) {
         order_out = trade.ResultOrder();
         pos_out = PosicaoDoResultado();
         Reportar(uid, action, pos_out, trade.ResultVolume() > 0 ? trade.ResultVolume() : vol, trade.ResultPrice(), rc);
         return true;
      }
      if(rc == TRADE_RETCODE_INVALID_STOPS && (sl != 0 || tp != 0)) {
         sl = 0;  // Abre sem SL/TP; AjustarSLTP tenta colocar depois
         tp = 0;
         attempt--;
         continue;
      }
      if(rc == TRADE_RETCODE_REQUOTE || rc == TRADE_RETCODE_PRICE_CHANGED || rc == TRADE_RETCODE_PRICE_OFF ||
         rc == TRADE_RETCODE_TIMEOUT || rc == TRADE_RETCODE_CONNECTION) {
         Sleep(200);
         continue;
      }
      break;
   }
   PrintFormat("Falha em %s %s %s: %u %s", action, sym, DoubleToString(vol, VolumeDigits(sym)), rc, trade.ResultRetcodeDescription());
   Reportar(uid, action, 0, vol, 0, rc);
   return false;
}

bool FecharTicket(string uid, ulong ticket, double vol, string action) {
   uint rc = 0;
   for(int attempt = 0; attempt < 3; attempt++) {
      bool sent = vol > 0 ? trade.PositionClosePartial(ticket, vol) : trade.PositionClose(ticket);
      rc = trade.ResultRetcode();
      if(sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL || rc == TRADE_RETCODE_PLACED)) {
         Reportar(uid, action, (long)ticket, trade.ResultVolume(), trade.ResultPrice(), rc);
         return true;
      }
      if(rc == TRADE_RETCODE_POSITION_CLOSED) return true;
      if(rc == TRADE_RETCODE_REQUOTE || rc == TRADE_RETCODE_PRICE_CHANGED || rc == TRADE_RETCODE_PRICE_OFF ||
         rc == TRADE_RETCODE_TIMEOUT || rc == TRADE_RETCODE_CONNECTION) {
         Sleep(200);
         continue;
      }
      break;
   }
   PrintFormat("Falha ao fechar #%I64u (%s): %u %s", ticket, uid, rc, trade.ResultRetcodeDescription());
   Reportar(uid, action, (long)ticket, vol, 0, rc);
   return false;
}

// POSITION_IDENTIFIER da posição criada/alterada pela última ordem (0 = ainda não se sabe)
long PosicaoDoResultado() {
   ulong deal = trade.ResultDeal();
   if(deal > 0 && HistoryDealSelect(deal)) {
      long pos = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      if(pos > 0) return pos;
   }
   ulong order = trade.ResultOrder();
   if(order > 0 && HistoryOrderSelect(order)) return HistoryOrderGetInteger(order, ORDER_POSITION_ID);
   return 0;
}

bool TemMargem(string sym, ENUM_ORDER_TYPE ot, double vol) {
   double price = ot == ORDER_TYPE_BUY ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
   double margin;
   if(!OrderCalcMargin(ot, sym, vol, price, margin)) return true;  // Sem como calcular: deixa o broker decidir
   return margin <= AccountInfoDouble(ACCOUNT_MARGIN_FREE);
}

void Reportar(string uid, string action, long pos, double vol, double price, uint rc) {
   // A sessão já identifica conta e licença: a chave não vai na mensagem
   if(autenticado)
      ws.Enviar(StringFormat("EXEC|%I64d|-|%s|%s|%I64d|%s|%s|%u|%I64d", login, uid, action, pos,
                             DoubleToString(vol, 8), DoubleToString(price, 8), rc, last_seq));
}

// Ordens aceitas cuja posição ainda não apareceu (execução em bolsa devolve PLACED)
void ResolverPendentes() {
   for(int i = ArraySize(pendentes) - 1; i >= 0; i--) {
      ulong order = pendentes[i].order;
      bool resolvida = false;
      if(order > 0 && HistoryOrderSelect(order)) {
         long state = HistoryOrderGetInteger(order, ORDER_STATE);
         long pos = HistoryOrderGetInteger(order, ORDER_POSITION_ID);
         if(pos > 0 && (state == ORDER_STATE_FILLED || state == ORDER_STATE_PARTIAL)) {
            if(hedging) AdicionarVinculo(pendentes[i].uid, pos);
            else DefinirLiquido(pendentes[i].symbol, pos);
            resolvida = true;
         }
         else if(state == ORDER_STATE_CANCELED || state == ORDER_STATE_REJECTED || state == ORDER_STATE_EXPIRED) {
            PrintFormat("Ordem #%I64u da cópia %s não executou (estado %d)", order, pendentes[i].uid, state);
            resolvida = true;
         }
      }
      if(!resolvida && GetTickCount64() - pendentes[i].since > PENDING_TIMEOUT_MS) {
         PrintFormat("Ordem #%I64u da cópia %s sem confirmação após 60 s; o próximo snapshot reconcilia", order, pendentes[i].uid);
         resolvida = true;
      }
      if(resolvida) {
         for(int j = i; j < ArraySize(pendentes) - 1; j++) pendentes[j] = pendentes[j+1];
         ArrayResize(pendentes, ArraySize(pendentes) - 1);
         dirty = true;
      }
   }
}

//+------------------------------------------------------------------+
//| Fechamentos fora do EA (SL/TP/stop out/manual) viram "done"      |
//+------------------------------------------------------------------+
void AtualizarVinculos() {
   if(hedging) {
      for(int i = ArraySize(vinculos) - 1; i >= 0; i--) {
         if(i >= ArraySize(vinculos) || TicketDaPosicao(vinculos[i].pos) > 0) continue;
         int reason = MotivoFechamento(vinculos[i].pos);
         if(reason < 0) continue;  // Histórico ainda não carregou: não conclui nada
         string uid = vinculos[i].uid;
         RemoverVinculo(i);
         if(reason != DEAL_REASON_EXPERT) MarcarDone(uid, reason);
      }
      return;
   }
   for(int i = ArraySize(liquidos) - 1; i >= 0; i--) {
      string sym = liquidos[i].symbol;
      if(PositionSelect(sym)) {
         liquidos[i].pos = PositionGetInteger(POSITION_IDENTIFIER);
         continue;
      }
      int reason = MotivoFechamento(liquidos[i].pos);
      if(reason < 0) continue;
      for(int j = i; j < ArraySize(liquidos) - 1; j++) liquidos[j] = liquidos[j+1];
      ArrayResize(liquidos, ArraySize(liquidos) - 1);
      dirty = true;
      if(reason == DEAL_REASON_EXPERT) continue;
      for(int c = 0; c < ArraySize(copias); c++)
         if(copias[c].symbol == sym) MarcarDone(copias[c].uid, reason);
   }
}

void MarcarDone(string uid, int reason) {
   int c = BuscarCopia(uid);
   if(c < 0 || copias[c].done) return;
   copias[c].done = true;
   dirty = true;
   PrintFormat("Cópia %s fechada fora do EA (motivo %d): não será reaberta", uid, reason);
}

// DEAL_REASON do negócio que fechou a posição; -1 se o histórico não mostra fechamento
int MotivoFechamento(long pos) {
   if(!HistorySelectByPosition(pos)) return -1;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--) {
      ulong deal = HistoryDealGetTicket(i);
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT)
         return (int)HistoryDealGetInteger(deal, DEAL_REASON);
   }
   return -1;
}

// Seleciona a posição pelo identificador (o ticket pode mudar; o identificador não)
ulong TicketDaPosicao(long id) {
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong t = PositionGetTicket(i);
      if(t > 0 && PositionGetInteger(POSITION_IDENTIFIER) == id) return t;
   }
   return 0;
}

//+------------------------------------------------------------------+
//| Comentário "T<tag>:<login36>.<pos36>" (até 31 caracteres)        |
//| A tag vem da chave do portfólio: dois EAs de portfólios          |
//| diferentes na mesma conta não adotam as posições um do outro.    |
//+------------------------------------------------------------------+
string Base36(long v) {
   string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
   if(v <= 0) return "0";
   string s = "";
   while(v > 0) {
      s = StringSubstr(digits, (int)(v % 36), 1) + s;
      v /= 36;
   }
   return s;
}

string TagDaChave(string key) {
   uint h = 0;
   for(int i = 0; i < StringLen(key); i++) h = h * 31 + StringGetCharacter(key, i);
   string tag = Base36((long)(h % 1296));
   return StringLen(tag) < 2 ? "0" + tag : tag;
}

string Comentario(string uid) {
   int sep = StringFind(uid, "_");
   if(sep < 0) return "T" + comment_tag + ":" + uid;
   return "T" + comment_tag + ":" + Base36(StringToInteger(StringSubstr(uid, 0, sep))) + "." +
          Base36(StringToInteger(StringSubstr(uid, sep + 1)));
}

// Mapeamento perdido (arquivo apagado, outra máquina): reencontra a posição pelo comentário
bool AdotarPorComentario(int c) {
   string comment = Comentario(copias[c].uid);
   bool adotou = false;
   for(int i = 0; i < PositionsTotal(); i++) {
      if(PositionGetTicket(i) == 0 || PositionGetString(POSITION_COMMENT) != comment) continue;
      long pos = PositionGetInteger(POSITION_IDENTIFIER);
      if(BuscarVinculo(pos) >= 0) continue;
      AdicionarVinculo(copias[c].uid, pos);
      copias[c].type = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? 0 : 1;
      adotou = true;
   }
   if(adotou) PrintFormat("Cópia %s reencontrada pelo comentário", copias[c].uid);
   return adotou;
}

void AvisarPosicoesAntigas() {
   int antigas = 0;
   for(int i = 0; i < PositionsTotal(); i++)
      if(PositionGetTicket(i) > 0 && PositionGetString(POSITION_COMMENT) == "Copy ZMQ") antigas++;
   if(antigas > 0)
      PrintFormat("AVISO: %d posições abertas pela versão anterior do EA (comentário \"Copy ZMQ\") não são geridas por esta versão. Feche-as manualmente.", antigas);
}

//+------------------------------------------------------------------+
//| Símbolo, volume, preço                                           |
//+------------------------------------------------------------------+
string TraduzirSimbolo(string master) {
   for(int i = 0; i < ArraySize(traducoes); i++)
      if(traducoes[i].master == master) return traducoes[i].local;

   string local = "";
   string pairs[];
   int n = StringSplit(inp_symbol_map, ';', pairs);
   for(int i = 0; i < n && local == ""; i++) {
      string kv[];
      if(StringSplit(pairs[i], '=', kv) == 2 && kv[0] == master) local = kv[1];
   }
   n = StringSplit(inp_suffix_map, ';', pairs);
   for(int i = 0; i < n && local == ""; i++) {
      int eq = StringFind(pairs[i], "=");
      if(eq < 0) continue;
      string src = StringSubstr(pairs[i], 0, eq);
      string dst = StringSubstr(pairs[i], eq + 1);
      int len = StringLen(master), slen = StringLen(src);
      if(slen > 0 && (len <= slen || StringSubstr(master, len - slen) != src)) continue;
      string cand = StringSubstr(master, 0, len - slen) + dst;
      bool custom;
      if(SymbolExist(cand, custom)) local = cand;
   }
   if(local == "") local = master;

   bool is_custom;
   if(!SymbolExist(local, is_custom) || !SymbolSelect(local, true)) {
      PrintFormat("Símbolo %s (do master: %s) não existe nesta conta. Configure inp_symbol_map / inp_suffix_map.", local, master);
      local = "";
   }
   int k = ArraySize(traducoes);
   ArrayResize(traducoes, k + 1);
   traducoes[k].master = master;
   traducoes[k].local = local;
   return local;
}

int VolumeDigits(string symbol) {
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   int d = 0;
   while(d < 8 && MathAbs(step * MathPow(10, d) - MathRound(step * MathPow(10, d))) > 1e-9) d++;
   return d;
}

// Arredonda para baixo no step do símbolo; com aplicar_minimo, sobe para o mínimo em vez de zerar
double NormalizarVolume(string sym, double vol, bool aplicar_minimo) {
   if(vol <= 0) return 0;
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(step <= 0) step = 0.01;
   vol = MathFloor(vol / step + 1e-9) * step;
   if(vol < vmin) vol = aplicar_minimo ? vmin : 0;
   if(vmax > 0 && vol > vmax) vol = vmax;
   return NormalizeDouble(vol, VolumeDigits(sym));
}

// Volume local por lote do master, no momento em que uma cópia nasce
double EscalaAtual() {
   if(inp_sizing_mode == sizing_factor) return lots_factor;
   double capital = AccountInfoDouble(inp_sizing_mode == sizing_equity ? ACCOUNT_EQUITY : ACCOUNT_BALANCE);
   return lots_factor * MathMax(capital, 0) / inp_reference_capital;
}

double CalcularVolume(string sym, double master_volume, double escala) {
   return NormalizarVolume(sym, master_volume * escala, true);
}

// O limite de lotes da licença vale para a soma das cópias abertas, em todos os símbolos. Uma cópia nova ou
// um ADD ocupa no máximo o que sobra; abaixo do volume mínimo, não abre. Reduções seguem sempre o master, e
// o que já está aberto não é reduzido por causa do limite: baixá-lo só barra o que vem depois.
double AlvoNoLimite(int c, string uid, string sym, double alvo) {
   if(max_lots_limit <= 0 || alvo <= 0) return alvo;
   double antes = c >= 0 ? copias[c].alvo : 0;
   double half_step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP) / 2.0;
   if(alvo <= antes + half_step) return alvo;
   double livre = max_lots_limit - VolumeDasOutrasCopias(uid);
   if(alvo <= livre + half_step) return alvo;
   return MathMax(NormalizarVolume(sym, livre, false), antes);
}

double VolumeDasOutrasCopias(string uid) {
   double total = 0;
   for(int i = 0; i < ArraySize(copias); i++)
      if(copias[i].uid != uid && !copias[i].done) total += copias[i].alvo;
   return total;
}

bool PrecoPerto(string sym, int type, double price_open) {
   if(inp_late_max_deviation_points <= 0 || price_open <= 0) return false;
   double price = type == 0 ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
   return MathAbs(price - price_open) <= inp_late_max_deviation_points * SymbolInfoDouble(sym, SYMBOL_POINT);
}

bool MagicPermitido(long magic) {
   if(inp_magic_to_copy == "0") return true;
   for(int i = ArraySize(s_magic_to_copy) - 1; i >= 0; i--)
      if(StringToInteger(s_magic_to_copy[i]) == magic) return true;
   return false;
}

//+------------------------------------------------------------------+
//| Mapeamento persistido em MQL5\Files\TDM_Mirror                   |
//+------------------------------------------------------------------+
void SalvarMapa() {
   string tmp = map_file + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) {Print("Não foi possível gravar o mapeamento: ", GetLastError()); return;}
   for(int i = 0; i < ArraySize(copias); i++)
      FileWriteString(h, StringFormat("C|%s|%s|%d|%s|%I64d|%d|%s\r\n", copias[i].uid, copias[i].symbol, copias[i].type,
                                      DoubleToString(copias[i].alvo, 8), copias[i].magic, copias[i].done ? 1 : 0,
                                      DoubleToString(copias[i].escala, 8)));
   for(int i = 0; i < ArraySize(vinculos); i++)
      FileWriteString(h, StringFormat("V|%s|%I64d\r\n", vinculos[i].uid, vinculos[i].pos));
   for(int i = 0; i < ArraySize(liquidos); i++)
      FileWriteString(h, StringFormat("N|%s|%I64d\r\n", liquidos[i].symbol, liquidos[i].pos));
   FileClose(h);
   // Troca atômica: um terminal que cai no meio da gravação não corrompe o arquivo
   if(!FileMove(tmp, 0, map_file, FILE_REWRITE)) {Print("Falha ao gravar o mapeamento: ", GetLastError()); return;}
   dirty = false;
}

void CarregarMapa() {
   ArrayResize(copias, 0);
   ArrayResize(vinculos, 0);
   ArrayResize(liquidos, 0);
   if(!FileIsExist(map_file)) return;
   int h = FileOpen(map_file, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) {Print("Não foi possível ler o mapeamento: ", GetLastError()); return;}
   while(!FileIsEnding(h)) {
      string f[];
      int n = StringSplit(FileReadString(h), '|', f);
      if((n == 7 || n == 8) && f[0] == "C") {
         // Mapeamento anterior ao EA-08 (7 campos): a cópia foi aberta com o fator fixo
         double escala = n == 8 ? StringToDouble(f[7]) : lots_factor;
         int c = NovaCopia(f[1], f[2], (int)StringToInteger(f[3]), StringToInteger(f[5]), escala);
         copias[c].alvo = StringToDouble(f[4]);
         copias[c].done = f[6] == "1";
      }
      else if(n == 3 && f[0] == "V") AdicionarVinculo(f[1], StringToInteger(f[2]));
      else if(n == 3 && f[0] == "N") DefinirLiquido(f[1], StringToInteger(f[2]));
   }
   FileClose(h);
   dirty = false;
}

// Uma instância por conta + chave: duas escreveriam o mesmo arquivo e dobrariam as ordens
bool AdquirirTrava() {
   if(!GlobalVariableCheck(lock_name)) GlobalVariableTemp(lock_name);
   double owner = GlobalVariableGet(lock_name);
   if(owner != 0 && (long)owner != ChartID() && ChartSymbol((long)owner) != "") return false;
   return GlobalVariableSetOnCondition(lock_name, (double)ChartID(), owner);
}

void LiberarTrava() {
   if(GlobalVariableCheck(lock_name) && (long)GlobalVariableGet(lock_name) == ChartID())
      GlobalVariableSet(lock_name, 0);
}

//+------------------------------------------------------------------+
//| Listas                                                           |
//+------------------------------------------------------------------+
int BuscarCopia(string uid) {
   for(int i = 0; i < ArraySize(copias); i++) if(copias[i].uid == uid) return i;
   return -1;
}

int NovaCopia(string uid, string sym, int type, long magic, double escala) {
   int c = ArraySize(copias);
   ArrayResize(copias, c + 1);
   copias[c].uid = uid;
   copias[c].symbol = sym;
   copias[c].type = type;
   copias[c].alvo = 0;
   copias[c].escala = escala;
   copias[c].magic = magic;
   copias[c].done = false;
   return c;
}

void RemoverCopia(int c) {
   string uid = copias[c].uid;
   for(int i = ArraySize(vinculos) - 1; i >= 0; i--) if(vinculos[i].uid == uid) RemoverVinculo(i);
   for(int i = c; i < ArraySize(copias) - 1; i++) copias[i] = copias[i+1];
   ArrayResize(copias, ArraySize(copias) - 1);
   dirty = true;
}

int BuscarVinculo(long pos) {
   for(int i = 0; i < ArraySize(vinculos); i++) if(vinculos[i].pos == pos) return i;
   return -1;
}

void AdicionarVinculo(string uid, long pos) {
   if(BuscarVinculo(pos) >= 0) return;
   int n = ArraySize(vinculos);
   ArrayResize(vinculos, n + 1);
   vinculos[n].uid = uid;
   vinculos[n].pos = pos;
   dirty = true;
}

void RemoverVinculo(int i) {
   for(int j = i; j < ArraySize(vinculos) - 1; j++) vinculos[j] = vinculos[j+1];
   ArrayResize(vinculos, ArraySize(vinculos) - 1);
   dirty = true;
}

void DefinirLiquido(string sym, long pos) {
   for(int i = 0; i < ArraySize(liquidos); i++) {
      if(liquidos[i].symbol != sym) continue;
      if(liquidos[i].pos != pos) {liquidos[i].pos = pos; dirty = true;}
      return;
   }
   int n = ArraySize(liquidos);
   ArrayResize(liquidos, n + 1);
   liquidos[n].symbol = sym;
   liquidos[n].pos = pos;
   dirty = true;
}

void AdicionarPendente(string uid, string sym, int dir, double vol, ulong order) {
   int n = ArraySize(pendentes);
   ArrayResize(pendentes, n + 1);
   pendentes[n].uid = uid;
   pendentes[n].symbol = sym;
   pendentes[n].dir = dir;
   pendentes[n].vol = vol;
   pendentes[n].order = order;
   pendentes[n].since = GetTickCount64();
}

bool Contem(const string &list[], string value) {
   for(int i = 0; i < ArraySize(list); i++) if(list[i] == value) return true;
   return false;
}

void Adicionar(string &list[], string value) {
   int n = ArraySize(list);
   ArrayResize(list, n + 1);
   list[n] = value;
}

void AvisarUmaVez(string key, string message) {
   if(Contem(avisados, key)) return;
   if(ArraySize(avisados) > 1000) ArrayResize(avisados, 0);
   Adicionar(avisados, key);
   Print(message);
}
//+------------------------------------------------------------------+
