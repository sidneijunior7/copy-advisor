//+------------------------------------------------------------------+
//|                               Trademetric Copy Trader Master.mq5 |
//|                                 Copyright 2026, Trademetric Inc. |
//|                                   https://www.trademetric.com.br |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Trademetric Inc."
#property link      "https://www.trademetric.com.br"
#property version   "2.00"

#include <Zmq/Zmq.mqh>

// Inputs
input string InpSecretKey = "YOUR_STRATEGY_SECRET_KEY"; // Strategy Secret Key provided by Manager

// Globals
Context context;
Socket socket(context, ZMQ_PUSH);

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
//---
   Print("Connecting to ZMQ Pull Server...");
   if(!socket.connect("tcp://127.0.0.1:5555")) { //tcp://trademetric-mirror-server.dletnt.easypanel.host:5555
      Print("Failed to connect to ZMQ Server!");
      return(INIT_FAILED);
   }
   Print("ZMQ Connected (PUSH -> 5555)");
//---
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
//---
   // socket.close();
  }
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD) {
      
      if(HistoryDealSelect(trans.deal)) {
         long entryType = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
         long magic     = HistoryDealGetInteger(trans.deal, DEAL_MAGIC);
         string symbol  = HistoryDealGetString(trans.deal, DEAL_SYMBOL);
         double volume  = HistoryDealGetDouble(trans.deal, DEAL_VOLUME);
         double price   = HistoryDealGetDouble(trans.deal, DEAL_PRICE);
         
         string action = "NONE";
         if(entryType == DEAL_ENTRY_IN)    action = "OPEN";
         if(entryType == DEAL_ENTRY_OUT)   action = "CLOSE";
         if(entryType == DEAL_ENTRY_INOUT) action = "REVERSE";

         if(action == "NONE") return;

         long posID = HistoryDealGetInteger(trans.deal, DEAL_POSITION_ID);
         long type  = HistoryDealGetInteger(trans.deal, DEAL_TYPE); 

         // Protocol Update: KEY|ACTION|...
         // The Server will split by first '|' to isolate Key
         string msg = StringFormat("%s|%s|%d|%d|%s|%.2f|%.5f|%.5f|%.5f|%d", 
                                   InpSecretKey,
                                   action,
                                   posID,
                                   type,
                                   symbol, 
                                   volume, 
                                   price,
                                   trans.price_sl, 
                                   trans.price_tp,
                                   magic);
         
         EnviarParaInfo(msg);
      }
   }
}
void OnChartEvent(const int id,         // Evento ID 
                  const long& lparam,   // Parâmetro de evento de tipo long 
                  const double& dparam, // Parâmetro de evento de tipo double 
                  const string& sparam  // Parâmetro de evento de tipo string 
                  )
   {
      if(id==CHARTEVENT_KEYDOWN) 
         {
            if(lparam==12) 
            {
               // Test Message
               string msg = StringFormat("%s|OPEN|12345|0|EURUSD|1.0|1.1000|0|0|99999", InpSecretKey);
               EnviarParaInfo(msg);
               Print("Test message sent via ZMQ");
            }
         }
   }
//+------------------------------------------------------------------+
void EnviarParaInfo(string mensagem) {
   bool res = socket.send(mensagem);
   if(res) {
      Print("ZMQ Enviado: ", mensagem);
   } else {
      Print("Erro ao enviar ZMQ");
   }
}