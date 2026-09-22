//+------------------------------------------------------------------+
//|                                Trademetric Copy Trader Slave.mq5 |
//|                                 Copyright 2026, Trademetric Inc. |
//|                                   https://www.trademetric.com.br |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Trademetric Inc."
#property link      "https://www.trademetric.com.br"
#property version   "3.00"

#include <Trade\Trade.mqh>
#include <Zmq/Zmq.mqh>

// Protocolo v2 (tópico P_<portfolio>), cada mensagem traz o estado completo de uma posição do master:
//   POS|epoch|seq|uid|type|symbol|vol|price_open|sl|tp|magic|reason   (vol 0 = fechada)
//   SNAP|epoch|seq|uid,type,symbol,vol,price_open,sl,tp,magic;...      (estado completo do tópico)
//   HB|epoch|seq                                                        (heartbeat, repete o último seq)
// A mesma função, AplicarEstado(), leva a posição local ao estado do master tanto para POS quanto
// para SNAP. Um slave que perdeu mensagens converge no próximo SNAP.

enum ENUM_OPERATOR_LOTS
   {
      multiply = 0,//Multiply [*]
      divide = 1   //Divide [/]
   };

sinput string inp_host = "127.0.0.1"; // Server Address
sinput int inp_port = 5556; // ZMQ Port (signals)
sinput int inp_push_port = 5555; // ZMQ Port (execution reports)
sinput string inp_api_url = "http://127.0.0.1:8000"; // API URL
sinput string inp_connection_key = "YOUR_PORTFOLIO_KEY"; // Portfolio Public Key
sinput int inp_timer = 100; // Timer (ms)
sinput ulong inp_standard_magic_number = 5457873;
sinput bool inp_keep_original_magic = true;
sinput bool inp_copy_sltp = true;
sinput double inp_lots_factor = 1;
sinput ENUM_OPERATOR_LOTS inp_lots_op = 0;
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
Context context;
Socket socket(context, ZMQ_SUB);
Socket reports(context, ZMQ_PUSH);
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
string topic = "";
bool   licenca_ativa = true;
ulong  next_license_check = 0;

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
const ulong LICENSE_CHECK_MS = 3600000; // Revalida a licença a cada hora
const ulong PENDING_TIMEOUT_MS = 60000;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit() {
   if(!MQLInfoInteger(MQL_DLLS_ALLOWED)) {Print("Allow DLL imports in the EA settings: the ZMQ library needs them."); return(INIT_FAILED);}
   standard_magic_number = inp_standard_magic_number == 0 ? (ulong)MathRand() : inp_standard_magic_number;
   StringSplit(inp_magic_to_copy, ',', s_magic_to_copy);

   if(inp_lots_factor <= 0){Print("Lots Factor must be greater than zero."); return(INIT_FAILED);}
   lots_factor = inp_lots_op==multiply ? inp_lots_factor : (1/inp_lots_factor);

   login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(login <= 0) {Print("Conta não identificada. Faça login e reinicie o EA."); return(INIT_FAILED);}
   hedging = AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING;

   string key8 = StringSubstr(inp_connection_key, 0, 8);
   lock_name = StringFormat("TDM_LOCK_%I64d_%s", login, key8);
   if(!AdquirirTrava()) {
      Print("Já existe outra instância deste EA com a mesma chave nesta conta. Remova a duplicada.");
      return(INIT_FAILED);
   }
   comment_tag = TagDaChave(inp_connection_key);
   FolderCreate("TDM_Mirror");
   map_file = StringFormat("TDM_Mirror\\%I64d_%s.csv", login, key8);
   CarregarMapa();
   AvisarPosicoesAntigas();

   // --- HTTP AUTHENTICATION ---
   Print("Validating License...");
   if(CheckLicense(topic, 5000) != 1) {
      Print("License Validation Failed! Please check your Key and Whitelist status.");
      LiberarTrava();
      return(INIT_FAILED);
   }
   next_license_check = GetTickCount64() + LICENSE_CHECK_MS;
   Print("License Valid! Subscribing to Topic: " + topic);

   // --- ZMQ CONNECTION ---
   socket.setLinger(0);
   socket.setReceiveHighWaterMark(10000);
   socket.setTcpKeepAlive(1);
   socket.setTcpKeepAliveIdle(60);
   socket.setTcpKeepAliveInterval(15);
   string addr = StringFormat("tcp://%s:%d", inp_host, inp_port);
   if(!socket.connect(addr)) {
      Print("Erro ao conectar ao servidor ZMQ!");
      LiberarTrava();
      return(INIT_FAILED);
   }
   // Assina antes de qualquer outra coisa: mensagens chegam na fila enquanto o EA aquece
   if(!socket.subscribe(topic + " ")) {
       Print("Erro ao subscrever topicos!");
       LiberarTrava();
       return(INIT_FAILED);
   }
   reports.setLinger(0);
   reports.setSendHighWaterMark(1000);
   reports.connect(StringFormat("tcp://%s:%d", inp_host, inp_push_port));

   trade.SetExpertMagicNumber(standard_magic_number);
   trade.SetDeviationInPoints(inp_slippage_points);
   EventSetMillisecondTimer(inp_timer <= 0 ? 100 : inp_timer);

   PrintFormat("ZMQ Connected to %s | conta %s | %d cópias no mapeamento",
               addr, hedging ? "hedging" : "netting", ArraySize(copias));
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {
   EventKillTimer();
   if(dirty) SalvarMapa();
   LiberarTrava();
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

void OnTimer() {
   if(!Pronto()) return;

   if(GetTickCount64() >= next_license_check) {
      next_license_check = GetTickCount64() + LICENSE_CHECK_MS;
      string t;
      int status = CheckLicense(t, 3000);
      if(status == 0 && licenca_ativa) Print("Licença revogada: novas posições não serão abertas; as abertas continuam sendo geridas.");
      if(status == 1 && !licenca_ativa) Print("Licença reativada.");
      if(status >= 0) licenca_ativa = (status == 1);
   }

   ResolverPendentes();

   ZmqMsg msg;
   for(int n = 0; n < 500 && socket.recv(msg, true); n++) {
       string full_data = msg.getData();
       // Format: TOPIC MESSAGE
       int space = StringFind(full_data, " ");
       if(space > 0) Processar(StringSubstr(full_data, space+1));
   }
   if(dirty) SalvarMapa();
}

void OnTrade() {
   if(Pronto()) AtualizarVinculos();
}

//+------------------------------------------------------------------+
//| HTTP Check License: 1 = válida, 0 = recusada, -1 = erro de rede  |
//+------------------------------------------------------------------+
int CheckLicense(string &out_topic, int timeout_ms) {
   string headers = "Content-Type: application/json\r\n";
   string url = inp_api_url + "/api/license/check";

   // Create JSON Payload manually
   string body = StringFormat("{\"connection_key\": \"%s\", \"mt5_login\": %I64d}", inp_connection_key, login);

   char data[];
   StringToCharArray(body, data, 0, StringLen(body));
   char result[];
   string result_headers;

   int res = WebRequest("POST", url, headers, timeout_ms, data, result, result_headers);

   if(res == 200) {
      // Parse JSON (Simple parsing for one field)
      string json_res = CharArrayToString(result);

      // Extract "topic": "VALUE"
      int topic_idx = StringFind(json_res, "\"topic\"");
      if(topic_idx > 0) {
         int start = StringFind(json_res, ":", topic_idx);
         int q1 = StringFind(json_res, "\"", start);
         int q2 = StringFind(json_res, "\"", q1+1);
         if(q1 > 0 && q2 > 0) {
             out_topic = StringSubstr(json_res, q1+1, q2-q1-1);

             // Extract "max_lots": VALUE
             int bw_idx = StringFind(json_res, "\"max_lots\"");
             if(bw_idx > 0) {
                int col = StringFind(json_res, ":", bw_idx);
                int end = StringFind(json_res, "}", col);
                int comma = StringFind(json_res, ",", col);
                if(comma > 0 && (end < 0 || comma < end)) end = comma; // Handle if not last
                if(col > 0 && end > 0) {
                   max_lots_limit = StringToDouble(StringSubstr(json_res, col+1, end-col-1));
                   PrintFormat("Max Lots Limit received: %.2f", max_lots_limit);
                }
             }
             return 1;
         }
      }
      return -1;
   }
   Print("HTTP Error: ", res, res == -1 ? StringFormat(" (erro %d; a URL da API está liberada em Ferramentas > Opções > Expert Advisors?)", GetLastError()) : "");
   if(ArraySize(result) > 0) Print(CharArrayToString(result));
   return (res == 401 || res == 403) ? 0 : -1;
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
   if(need_snap) PrintFormat("Snapshot aplicado (%s)", topic);
   last_epoch = epoch;
   last_seq = seq;
   need_snap = false;
   AtualizarVinculos();

   string items[], vistos[];
   int k = StringSplit(entries, ';', items);
   for(int i = 0; i < k; i++) {
      string p[];
      if(StringSplit(items[i], ',', p) != 8) continue;
      Adicionar(vistos, p[0]);
      AplicarEstado(p[0], (int)StringToInteger(p[1]), p[2], StringToDouble(p[3]), StringToDouble(p[4]),
                    StringToDouble(p[5]), StringToDouble(p[6]), StringToInteger(p[7]), false);
   }
   // O que não veio no snapshot foi fechado no master
   for(int i = ArraySize(copias) - 1; i >= 0; i--) {
      if(i < ArraySize(copias) && !Contem(vistos, copias[i].uid))
         AplicarEstado(copias[i].uid, copias[i].type, "", 0, 0, 0, 0, copias[i].magic, false);
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
   double alvo = vol > 0 ? CalcularVolume(sym, vol) : 0;

   if(c < 0) {
      if(alvo <= 0) return;
      if(!licenca_ativa) {AvisarUmaVez("lic:" + uid, "Licença inativa: posição " + uid + " não copiada"); return;}
      c = NovaCopia(uid, sym, type, magic);
   }

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
   reports.send(StringFormat("EXEC|%I64d|%s|%s|%s|%I64d|%s|%s|%u|%I64d", login, inp_connection_key, uid, action, pos,
                             DoubleToString(vol, 8), DoubleToString(price, 8), rc, last_seq), true);
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

double CalcularVolume(string sym, double master_volume) {
   double volume = master_volume * lots_factor;
   if(max_lots_limit > 0 && volume > max_lots_limit) volume = max_lots_limit;
   return NormalizarVolume(sym, volume, true);
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
      FileWriteString(h, StringFormat("C|%s|%s|%d|%s|%I64d|%d\r\n", copias[i].uid, copias[i].symbol, copias[i].type,
                                      DoubleToString(copias[i].alvo, 8), copias[i].magic, copias[i].done ? 1 : 0));
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
      if(n == 7 && f[0] == "C") {
         int c = NovaCopia(f[1], f[2], (int)StringToInteger(f[3]), StringToInteger(f[5]));
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

int NovaCopia(string uid, string sym, int type, long magic) {
   int c = ArraySize(copias);
   ArrayResize(copias, c + 1);
   copias[c].uid = uid;
   copias[c].symbol = sym;
   copias[c].type = type;
   copias[c].alvo = 0;
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
