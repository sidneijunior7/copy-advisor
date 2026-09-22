//+------------------------------------------------------------------+
//|                               Trademetric Copy Trader Master.mq5 |
//|                                 Copyright 2026, Trademetric Inc. |
//|                                   https://www.trademetric.com.br |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Trademetric Inc."
#property link      "https://www.trademetric.com.br"
#property version   "3.00"

#include <Zmq/Zmq.mqh>

// Inputs
input string InpSecretKey   = "YOUR_STRATEGY_SECRET_KEY"; // Master Key provided by Manager
input string InpServer      = "tcp://127.0.0.1:5555";     // Hub address (PUSH)
input int    InpSyncSeconds = 10;                          // Full position refresh interval (seconds)

// Protocol v2: every message carries the full state of one position (volume 0 = closed).
//   KEY|V2|login|reason|pos_id|type|symbol|vol|price_open|sl|tp|magic
//   KEY|V2SYNC|login|pos_id,type,symbol,vol,price_open,sl,tp,magic;...
// pos_id is POSITION_IDENTIFIER, never the ticket: on netting accounts a reversal changes the
// ticket but keeps the identifier.

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
Context context;
Socket socket(context, ZMQ_PUSH);

PosState sent[];           // Last state sent to the hub
bool     seeded = false;   // sent[] initialised from the terminal
bool     was_connected = false;
ulong    ready_at = 0;     // GetTickCount64() after which positions are trusted
ulong    next_sync = 0;

const int WARMUP_MS = 10000; // Positions can read as empty right after start or a broker reconnect

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   if(!MQLInfoInteger(MQL_DLLS_ALLOWED)) {
      Print("Allow DLL imports in the EA settings: the ZMQ library needs them.");
      return(INIT_FAILED);
   }
   socket.setLinger(0);                // Never hang the terminal on removal
   socket.setSendHighWaterMark(1000);  // Queue while the hub is down, then drop instead of blocking
   socket.setTcpKeepAlive(1);
   socket.setTcpKeepAliveIdle(60);
   socket.setTcpKeepAliveInterval(15);

   Print("Connecting to hub ", InpServer, "...");
   if(!socket.connect(InpServer)) {
      Print("Failed to connect to ZMQ Server!");
      return(INIT_FAILED);
   }
   Print("ZMQ Connected (PUSH -> ", InpServer, ")");

   ArrayResize(sent, 0);
   seeded = false;
   was_connected = false;
   EventSetMillisecondTimer(250);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }
//+------------------------------------------------------------------+
void OnTrade()
  {
   DiffEEnviar();
  }
//+------------------------------------------------------------------+
void OnTimer()
  {
   DiffEEnviar();
   if(seeded && Pronto() && GetTickCount64() >= next_sync) {
      EnviarSync();
      next_sync = GetTickCount64() + (ulong)MathMax(InpSyncSeconds, 1) * 1000;
   }
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
void Enviar(string reason, const PosState &p)
  {
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string msg = StringFormat("%s|V2|%I64d|%s|%s", InpSecretKey, login, reason, Campos(p, "|"));
   if(socket.send(msg, true)) Print("ZMQ Enviado: ", reason, " ", p.symbol, " #", p.id);
   else                       Print("Erro ao enviar ZMQ (fila cheia?): ", reason, " #", p.id);
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
   // Dropped when the queue is full: the next one carries the same information
   socket.send(StringFormat("%s|V2SYNC|%I64d|%s", InpSecretKey, login, body), true);
  }
//+------------------------------------------------------------------+
