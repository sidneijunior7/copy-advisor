//+------------------------------------------------------------------+
//|                                     Trademetric Spike Probe.mq5 |
//|                                 Copyright 2026, Trademetric Inc. |
//|                                   https://www.trademetric.com.br |
//+------------------------------------------------------------------+
// Hosted-terminal spike (tools/spike): tells, without a trading account, whether a terminal
// started by tools/spike/pod.sh can load the ZMQ DLL, reach the hub and call WebRequest.
// Every line it logs starts with PROBE so pod.sh can grep the experts log.
#property copyright "Copyright 2026, Trademetric Inc."
#property link      "https://www.trademetric.com.br"
#property version   "1.00"

#include <Zmq/Zmq.mqh>

input string InpUrl = "http://tdm-spike-api:8000/health"; // WebRequest target
input string InpHub = "tcp://tdm-spike-hub:5556";         // Hub PUB

Context context;
Socket  sub(context, ZMQ_SUB);
string  sub_endpoint = "";
int     msgs = 0;
int     seconds = 0;

//+------------------------------------------------------------------+
int OnInit()
  {
   PrintFormat("PROBE start dlls=%d trade_allowed=%d", MQLInfoInteger(MQL_DLLS_ALLOWED),
               TerminalInfoInteger(TERMINAL_TRADE_ALLOWED));
   Conta();
   Web();
   sub.setLinger(0);
   bool ok = sub.connect(InpHub) && sub.subscribe("");
   if(ok) sub_endpoint = InpHub;
   PrintFormat("PROBE zmq connect=%s %s", ok ? "ok" : "fail", InpHub);
   EventSetTimer(1);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(sub_endpoint != "") {
      sub.disconnect(sub_endpoint);
      sub_endpoint = "";
   }
  }
//+------------------------------------------------------------------+
void OnTimer()
  {
   ZmqMsg m;
   while(sub.recv(m, true)) msgs++;
   seconds++;
   if(seconds % 60 == 0) {
      PrintFormat("PROBE zmq msgs=%d", msgs);
      Conta();  // Positions can still be loading during OnInit
      Web();
   }
  }
//+------------------------------------------------------------------+
//| Margin mode and open positions: on a netting account the Slave   |
//| adjusts the whole symbol, so test signals must avoid these       |
//+------------------------------------------------------------------+
void Conta()
  {
   bool hedging = AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING;
   string pos = "";
   for(int i = 0; i < PositionsTotal(); i++) {
      if(PositionGetTicket(i) == 0) continue;
      pos += StringFormat("%s%s %s %g", pos == "" ? "" : "; ", PositionGetString(POSITION_SYMBOL),
                          PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell",
                          PositionGetDouble(POSITION_VOLUME));
   }
   PrintFormat("PROBE account %s %s positions=%d [%s]", AccountInfoString(ACCOUNT_SERVER),
               hedging ? "hedging" : "netting", PositionsTotal(), pos);
  }
//+------------------------------------------------------------------+
//| 4014 = URL not in the allowed list (Tools > Options > Experts)   |
//+------------------------------------------------------------------+
void Web()
  {
   char data[], result[];
   string headers;
   ResetLastError();
   int res = WebRequest("GET", InpUrl, "", 5000, data, result, headers);
   int err = GetLastError();  // Before anything else: MQL5 evaluates arguments right to left
   PrintFormat("PROBE webrequest res=%d err=%d %s", res, err, StringSubstr(CharArrayToString(result), 0, 60));
  }
//+------------------------------------------------------------------+
