//+------------------------------------------------------------------+
//|                               Trademetric Copy Trader Master.mq5 |
//|                                 Copyright 2026, Trademetric Inc. |
//|                                   https://www.trademetric.com.br |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Trademetric Inc."
#property link      "https://www.trademetric.com.br"
#property version   "4.00"
#define VERSAO "4.00"

#include "Include/TDM/WsClient.mqh"

// Inputs
input string InpSecretKey   = "YOUR_MASTER_KEY";             // Master key (dashboard: Master keys)
input string InpWsHost      = "signals.trademetric.com.br";  // Server
input int    InpWsPort      = 443;                           // Port
input bool   InpWsTls       = true;                          // TLS
input int    InpSyncSeconds = 10;                            // Full position refresh interval (seconds)

// Protocol v2: every message carries the full state of one position (volume 0 = closed).
//   V2|login|reason|pos_id|type|symbol|vol|price_open|sl|tp|magic
//   V2SYNC|login|pos_id,type,symbol,vol,price_open,sl,tp,magic;...
//   V2HELLO|login|trade_mode|server|company   (trade_mode: demo, contest, real)
// pos_id is POSITION_IDENTIFIER, never the ticket: on netting accounts a reversal changes the
// ticket but keeps the identifier.
// Transport: wss://<InpWsHost>/v1/master. The first message authenticates
//   HELLO|master|v1|<key>|<login>|<version>   ->   WELCOME|epoch|hb_s   (or ERR|code|reason)
// and the lines above follow. No DLL, so the terminal runs it with "Allow DLL imports" off.

struct PosState {
   long   id;
   long   type;
   string symbol;
   double volume;
   double price_open;
   double sl;
   double tp;
   long   magic;
};

// Globals
// Changing the inputs re-runs OnInit without reloading the EA: OnInit resets the connection state
CWsClient ws;
bool     autenticado = false;  // WELCOME received on this connection
bool     parado = false;       // Another terminal took over this key and account
string   fila[];               // Live messages produced while disconnected...
ulong    fila_em[];            // ...and when
string   estado_hub = "";
ulong    proximo_comentario = 0;

PosState sent[];           // Last state sent to the hub
bool     seeded = false;   // sent[] initialised from the terminal
bool     was_connected = false;
ulong    ready_at = 0;     // GetTickCount64() after which positions are trusted
ulong    next_sync = 0;
ulong    next_hello = 0;

const int WARMUP_MS = 10000; // Positions can read as empty right after start or a broker reconnect
const int HELLO_MS  = 300000; // Account details are re-sent so a hub that restarted learns them again
// A live event older than this when the connection comes back is not sent as live: the V2SYNC that
// follows reports the position, and slaves apply their late-entry price guard to it
const ulong FILA_MAX_MS = 10000;
const int   FILA_MAX = 1000;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   ArrayResize(sent, 0);
   ArrayResize(fila, 0);
   ArrayResize(fila_em, 0);
   seeded = false;
   was_connected = false;
   autenticado = false;
   parado = false;
   MathSrand((uint)(GetTickCount() ^ (uint)AccountInfoInteger(ACCOUNT_LOGIN)));
   ws.Configurar(InpWsHost, InpWsPort, "/v1/master", InpWsTls);
   estado_hub = "connecting...";
   Print("Master ", VERSAO, " | ", InpWsHost);
   EventSetMillisecondTimer(250);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   ws.Desconectar();
   Comment("");
  }
//+------------------------------------------------------------------+
void OnTrade()
  {
   DiffEEnviar();
  }
//+------------------------------------------------------------------+
void OnTimer()
  {
   ProcessarHub();
   DiffEEnviar();
   if(seeded && Pronto() && GetTickCount64() >= next_sync) {
      EnviarSync();
      next_sync = GetTickCount64() + (ulong)MathMax(InpSyncSeconds, 1) * 1000;
   }
   if(seeded && Pronto() && GetTickCount64() >= next_hello) EnviarHello();
   MostrarEstado();
  }
//+------------------------------------------------------------------+
//| Terminal connected, logged in and past the warm-up window        |
//+------------------------------------------------------------------+
bool Pronto()
  {
   bool connected = TerminalInfoInteger(TERMINAL_CONNECTED) != 0 && AccountInfoInteger(ACCOUNT_LOGIN) > 0;
   if(!connected) {
      was_connected = false;
      return false;
   }
   if(!was_connected) {
      was_connected = true;
      ready_at = GetTickCount64() + WARMUP_MS;
   }
   return GetTickCount64() >= ready_at;
  }
//+------------------------------------------------------------------+
//| Compare current positions with the last state sent               |
//+------------------------------------------------------------------+
void DiffEEnviar()
  {
   if(!Pronto()) return;

   PosState cur[];
   LerPosicoes(cur);

   if(!seeded) {
      // The hub learns the account before its first position
      EnviarHello();
      PrintFormat("Account %I64d: %s, %s (%s)", AccountInfoInteger(ACCOUNT_LOGIN), ModoConta(),
                  AccountInfoString(ACCOUNT_SERVER), AccountInfoString(ACCOUNT_COMPANY));
      // Positions that already existed are announced by V2SYNC, not as live events:
      // slaves must not treat them as fresh entries.
      CopiarEstado(cur, sent);
      seeded = true;
      next_sync = 0;
      PrintFormat("Tracking %d open positions", ArraySize(sent));
      return;
   }

   for(int i = 0; i < ArraySize(cur); i++) {
      int j = Procurar(sent, cur[i].id);
      if(j < 0) {
         Enviar("OPEN", cur[i]);
         continue;
      }
      double half_step  = SymbolInfoDouble(cur[i].symbol, SYMBOL_VOLUME_STEP) / 2.0;
      double half_point = SymbolInfoDouble(cur[i].symbol, SYMBOL_POINT) / 2.0;
      string reason = "";
      if(cur[i].type != sent[j].type)                            reason = "REVERSE";
      else if(cur[i].volume > sent[j].volume + half_step)        reason = "ADD";
      else if(cur[i].volume < sent[j].volume - half_step)        reason = "PARTIAL";
      else if(MathAbs(cur[i].sl - sent[j].sl) > half_point ||
              MathAbs(cur[i].tp - sent[j].tp) > half_point)      reason = "MODIFY";
      if(reason != "") Enviar(reason, cur[i]);
   }

   for(int j = 0; j < ArraySize(sent); j++) {
      if(Procurar(cur, sent[j].id) < 0) {
         PosState closed = sent[j];
         closed.volume = 0;
         Enviar("CLOSE", closed);
      }
   }

   CopiarEstado(cur, sent);
  }
//+------------------------------------------------------------------+
void LerPosicoes(PosState &out[])
  {
   int total = PositionsTotal();
   ArrayResize(out, 0, total);
   for(int i = 0; i < total; i++) {
      if(PositionGetTicket(i) == 0) continue;  // Also selects the position
      int n = ArraySize(out);
      ArrayResize(out, n + 1, total);
      out[n].id         = PositionGetInteger(POSITION_IDENTIFIER);
      out[n].type       = PositionGetInteger(POSITION_TYPE);
      out[n].symbol     = PositionGetString(POSITION_SYMBOL);
      out[n].volume     = PositionGetDouble(POSITION_VOLUME);
      out[n].price_open = PositionGetDouble(POSITION_PRICE_OPEN);
      out[n].sl         = PositionGetDouble(POSITION_SL);
      out[n].tp         = PositionGetDouble(POSITION_TP);
      out[n].magic      = PositionGetInteger(POSITION_MAGIC);
   }
  }
//+------------------------------------------------------------------+
int Procurar(const PosState &list[], long id)
  {
   for(int i = ArraySize(list) - 1; i >= 0; i--)
      if(list[i].id == id) return i;
   return -1;
  }
//+------------------------------------------------------------------+
void CopiarEstado(const PosState &from[], PosState &to[])
  {
   ArrayResize(to, ArraySize(from));
   for(int i = 0; i < ArraySize(from); i++) to[i] = from[i];
  }
//+------------------------------------------------------------------+
//| Decimal places of the symbol's volume step (0.01 -> 2, 1 -> 0)   |
//+------------------------------------------------------------------+
int VolumeDigits(string symbol)
  {
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   int d = 0;
   while(d < 8 && MathAbs(step * MathPow(10, d) - MathRound(step * MathPow(10, d))) > 1e-9) d++;
   return d;
  }
//+------------------------------------------------------------------+
//| pos_id,type,symbol,vol,price_open,sl,tp,magic                    |
//+------------------------------------------------------------------+
string Campos(const PosState &p, string sep)
  {
   int digits = (int)SymbolInfoInteger(p.symbol, SYMBOL_DIGITS);
   return StringFormat("%I64d%s%I64d%s%s%s%s%s%s%s%s%s%s%s%I64d",
                       p.id, sep, p.type, sep, p.symbol, sep,
                       DoubleToString(p.volume, VolumeDigits(p.symbol)), sep,
                       DoubleToString(p.price_open, digits), sep,
                       DoubleToString(p.sl, digits), sep,
                       DoubleToString(p.tp, digits), sep,
                       p.magic);
  }
//+------------------------------------------------------------------+
//| One line to the hub. Live events wait for a reconnection; the    |
//| others are periodic and the next one carries the same state.     |
//+------------------------------------------------------------------+
bool Transmitir(string body, bool ao_vivo)
  {
   if(autenticado && ws.Enviar(body)) return true;
   if(ao_vivo && ArraySize(fila) < FILA_MAX) {
      int n = ArraySize(fila);
      ArrayResize(fila, n + 1);
      ArrayResize(fila_em, n + 1);
      fila[n] = body;
      fila_em[n] = GetTickCount64();
   }
   return false;
  }
//+------------------------------------------------------------------+
void Enviar(string reason, const PosState &p)
  {
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(Transmitir(StringFormat("V2|%I64d|%s|%s", login, reason, Campos(p, "|")), true))
      Print("Sent: ", reason, " ", p.symbol, " #", p.id);
   else Print("Hub disconnected: ", reason, " #", p.id, " goes out on reconnection");
  }
//+------------------------------------------------------------------+
void EnviarSync()
  {
   string body = "";
   for(int i = 0; i < ArraySize(sent); i++) {
      if(i > 0) body += ";";
      body += Campos(sent[i], ",");
   }
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   // Dropped when it can't go out: the next one carries the same information
   Transmitir(StringFormat("V2SYNC|%I64d|%s", login, body), false);
  }
//+------------------------------------------------------------------+
string ModoConta()
  {
   switch((ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE)) {
      case ACCOUNT_TRADE_MODE_DEMO:    return "demo";
      case ACCOUNT_TRADE_MODE_CONTEST: return "contest";
      case ACCOUNT_TRADE_MODE_REAL:    return "real";
   }
   return "unknown";
  }
//+------------------------------------------------------------------+
string SemPipe(string s)
  {
   StringReplace(s, "|", "/");
   return s;
  }
//+------------------------------------------------------------------+
//| Trade mode, server and broker of the account                     |
//+------------------------------------------------------------------+
void EnviarHello()
  {
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string body = StringFormat("V2HELLO|%I64d|%s|%s|%s", login, ModoConta(),
                              SemPipe(AccountInfoString(ACCOUNT_SERVER)), SemPipe(AccountInfoString(ACCOUNT_COMPANY)));
   Transmitir(body, false);  // Dropped when it can't go out: the next one carries the same information
   next_hello = GetTickCount64() + HELLO_MS;
  }
//+------------------------------------------------------------------+
//| Connection, authentication, hub messages                         |
//+------------------------------------------------------------------+
void ProcessarHub()
  {
   ws.Processar();
   if(ws.NovaConexao()) {
      autenticado = false;
      ws.Enviar(StringFormat("HELLO|master|v1|%s|%I64d|%s", InpSecretKey, AccountInfoInteger(ACCOUNT_LOGIN), VERSAO));
      estado_hub = "authenticating...";
   }
   string msg;
   while(ws.Receber(msg)) {
      if(StringFind(msg, "WELCOME|") == 0) Welcome();
      else if(StringFind(msg, "ERR|") == 0) ErroDoHub(msg);
      // HB only keeps the connection alive
   }
   if(!ws.Aberto() && !parado && ws.UltimoErro() != "" && StringFind(estado_hub, "refused") < 0)
      estado_hub = ws.UltimoErro();
  }
//+------------------------------------------------------------------+
void Welcome()
  {
   autenticado = true;
   estado_hub = "connected";
   Print("Hub: authenticated");
   // OnTimer sends V2HELLO and V2SYNC right after, once the terminal is trusted (never an empty
   // V2SYNC from a terminal still loading: it would close every position on the hub)
   next_sync = 0;
   next_hello = 0;
   ulong now = GetTickCount64();
   int enviadas = 0, velhas = 0;
   for(int i = 0; i < ArraySize(fila); i++) {
      if(now - fila_em[i] > FILA_MAX_MS) {velhas++; continue;}
      if(ws.Enviar(fila[i])) enviadas++;
   }
   if(enviadas + velhas > 0) PrintFormat("Reconnected: %d live events sent, %d too old (left to the sync)", enviadas, velhas);
   ArrayResize(fila, 0);
   ArrayResize(fila_em, 0);
  }
//+------------------------------------------------------------------+
void ErroDoHub(string msg)
  {
   string f[];
   StringSplit(msg, '|', f);
   string codigo = ArraySize(f) > 1 ? f[1] : "";
   string motivo = ArraySize(f) > 2 ? f[2] : "";
   if(codigo == "replaced") {
      parado = true;
      ws.Desconectar();
      estado_hub = "stopped: another terminal uses this key on this account";
      Print("Another terminal connected with this key and account: this EA stopped sending. Keep one Master per account.");
      return;
   }
   estado_hub = "refused by the hub: " + motivo;
   if(codigo == "auth" || codigo == "revoked") {
      Print("The hub refused the master key (", motivo, "). Create or copy a key in the dashboard (Master keys).");
      ws.AdiarProxima(60000);
   }
   else if(codigo == "rate" || codigo == "busy") ws.AdiarProxima(300000);
   else Print("Hub closed the connection (", codigo, "): ", motivo);
  }
//+------------------------------------------------------------------+
void MostrarEstado()
  {
   if(GetTickCount64() < proximo_comentario) return;
   proximo_comentario = GetTickCount64() + 1000;
   Comment(StringFormat("TDM Mirror Master %s\nHub: %s\nOpen positions: %d%s", VERSAO, estado_hub, ArraySize(sent),
                        ArraySize(fila) > 0 ? StringFormat("\nWaiting to send: %d", ArraySize(fila)) : ""));
  }
//+------------------------------------------------------------------+
