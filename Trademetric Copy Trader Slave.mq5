#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\OrderInfo.mqh>
#include <Zmq/Zmq.mqh>

// Variáveis Globais
Context context;
Socket socket(context, ZMQ_SUB);

CTrade trade;
CPositionInfo posicao;
COrderInfo ordem;

// Estrutura para mapear ordens Master -> Slave
struct Mapeamento {
   long masterID; // Position ID no Master
   long slaveID;  // Ticket da posição no Slave
};
Mapeamento lista_mapeamento[];

enum ENUM_OPERATOR_LOTS
   {
      multiply = 0,//Multiply [*]
      divide = 1   //Divide [/]
   };
   
int port,timeout, timer;
string host;
ulong standard_magic_number;
double lots_factor;
double max_lots_limit = 0; // Limit from License
string s_magic_to_copy[];

sinput string inp_host = "127.0.0.1"; // Server Address
sinput int inp_port = 5556; // ZMQ Port
sinput string inp_api_url = "http://127.0.0.1:8000"; // API URL
sinput string inp_connection_key = "YOUR_PORTFOLIO_KEY"; // Portfolio Public Key
sinput int inp_timeout = 1000;
sinput int inp_timer = 100;
sinput ulong inp_standard_magic_number = 5457873;
sinput bool inp_keep_original_magic = true;
sinput bool inp_copy_sltp = true;
sinput double inp_lots_factor = 1;
sinput ENUM_OPERATOR_LOTS inp_lots_op = 0;
sinput string inp_magic_to_copy = "0";

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit() {
   host = inp_host == "" ? "127.0.0.1" : inp_host;
   port = inp_port <= 0 ? 5556 : inp_port;
   timeout = inp_timeout <= 0 ? 1000 : inp_timeout;
   timer = inp_timer <= 0 ? 100 : inp_timer;
   standard_magic_number = inp_standard_magic_number <=0 ? MathRand() : inp_standard_magic_number;
   
   StringSplit(inp_magic_to_copy, StringGetCharacter(",",0), s_magic_to_copy);
   
   if(inp_lots_factor == 0){Print("Lots Factor must be greater than zero."); return(INIT_FAILED);}
   lots_factor = inp_lots_op==multiply ? inp_lots_factor : (1/inp_lots_factor);
   
   // --- HTTP AUTHENTICATION ---
   Print("Validating License...");
   string zmq_topic = "";
   if(!CheckLicense(zmq_topic)) {
      Print("License Validation Failed! Please check your Key and Whitelist status.");
      return(INIT_FAILED);
   }
   Print("License Valid! Subscribing to Topic: " + zmq_topic);

   // --- ZMQ CONNECTION ---
   Print("Connecting to ZMQ Subscriber Server...");
   string addr = StringFormat("tcp://%s:%d", host, port);
   if(!socket.connect(addr)) {
      Print("Erro ao conectar ao servidor ZMQ!");
      return(INIT_FAILED);
   }
   
   // Subscribe to Specific Topic
   string sub_topic = zmq_topic + " "; // Add space delimiter
   if(!socket.subscribe(sub_topic)) {
       Print("Erro ao subscrever topicos!");
       return(INIT_FAILED);
   }

   if(inp_keep_original_magic) {trade.SetExpertMagicNumber(standard_magic_number);}
   EventSetMillisecondTimer(timer); 
   
   Print("ZMQ Connected to " + addr);
   
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| HTTP Check License Function                                      |
//+------------------------------------------------------------------+
bool CheckLicense(string &out_topic) {
   string headers = "Content-Type: application/json\r\n";
   string url = inp_api_url + "/api/license/check";
   
   // Create JSON Payload manually
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string body = StringFormat("{\"connection_key\": \"%s\", \"mt5_login\": %d}", inp_connection_key, login);
   
   char data[];
   StringToCharArray(body, data, 0, StringLen(body));
   char result[];
   string result_headers;
   
   int res = WebRequest("POST", url, headers, 5000, data, result, result_headers);
   
   if(res == 200) {
      // Parse JSON (Simple parsing for one field)
      string json_res = CharArrayToString(result);
      Print("Server Response: ", json_res);
      
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
                if(end < 0) end = StringFind(json_res, ",", col); // Handle if not last
                if(col > 0 && end > 0) {
                   string val = StringSubstr(json_res, col+1, end-col-1);
                   max_lots_limit = StringToDouble(val);
                   PrintFormat("Max Lots Limit received: %.2f", max_lots_limit);
                }
             }
             return true;
         }
      }
   } else {
      Print("HTTP Error: ", res);
      if(ArraySize(result) > 0) Print(CharArrayToString(result));
   }
   return false;
}

void OnTimer() {
   ZmqMsg msg;
   while(socket.recv(msg, true)) {
       string full_data = msg.getData();
       if(full_data != "") {
           // Format: TOPIC MESSAGE
           // Remove Topic prefix
           int space = StringFind(full_data, " ");
           if(space > 0) {
              string payload = StringSubstr(full_data, space+1);
              ProcessarSinal(payload);
           }
       }
   }
}

void ProcessarSinal(string raw_msg) {
   string parts[];
   int count = StringSplit(raw_msg, StringGetCharacter("|", 0), parts);
   if(count < 9) return;

   string action    = parts[0];
   long masterID    = (long)parts[1];
   int type         = (int)parts[2];
   string symbol    = parts[3];
   double volume    = StringToDouble(parts[4]);
   volume = NormalizeDouble((volume*lots_factor),2);
   volume = NormalizeDouble(volume, 2);
   
   if(max_lots_limit > 0 && volume > max_lots_limit) {
      PrintFormat("Volume %.2f exceeds limit %.2f. Capped.", volume, max_lots_limit);
      volume = max_lots_limit;
   }
   
   volume = volume == 0 ? SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN) : volume;
   double sl        = inp_copy_sltp ? StringToDouble(parts[6]) : 0;
   double tp        = inp_copy_sltp ? StringToDouble(parts[7]) : 0;
   long magicMaster = (long)parts[8];
   
      if(action == "OPEN") 
      {
         bool copy_it = false;
         if(inp_magic_to_copy != "0")
         {
            for(int i = (int)ArraySize(s_magic_to_copy)-1; i>=0; i--)
            {
               int magic_ = (int)StringToInteger(s_magic_to_copy[i]);
               if(magicMaster == magic_) {
                   copy_it = true; break;
               }
            }
         } else {
             copy_it = true;
         }

         if(copy_it) {
             PrintFormat("Abrindo cópia do Master ID: %d", masterID);
             if(inp_keep_original_magic) trade.SetExpertMagicNumber(magicMaster);
             else trade.SetExpertMagicNumber(standard_magic_number);
             
             double price = (type == 0) ? SymbolInfoDouble(symbol, SYMBOL_ASK) : SymbolInfoDouble(symbol, SYMBOL_BID);
             ENUM_ORDER_TYPE order_type = (type == 0) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
             
             if(trade.PositionOpen(symbol, order_type, volume, price, sl, tp, "Copy ZMQ")) {
                long slaveTicket = (long)trade.ResultOrder();
                AdicionarMapeamento(masterID, slaveTicket);
             }
         }
      }
   else if(action == "CLOSE") {
      PrintFormat("Fechando cópia do Master ID: %d", masterID);
      FecharMapeado(masterID);
   }
}

void AdicionarMapeamento(long mID, long sID) {
   int size = ArraySize(lista_mapeamento);
   ArrayResize(lista_mapeamento, size + 1);
   lista_mapeamento[size].masterID = mID;
   lista_mapeamento[size].slaveID = sID;
}

void FecharMapeado(long mID) {
   for(int i = ArraySize(lista_mapeamento) - 1; i >= 0; i--) {
      if(lista_mapeamento[i].masterID == mID) {
         if(trade.PositionClose(lista_mapeamento[i].slaveID)) {
            for(int j = i; j < ArraySize(lista_mapeamento) - 1; j++)
               lista_mapeamento[j] = lista_mapeamento[j+1];
            ArrayResize(lista_mapeamento, ArraySize(lista_mapeamento) - 1);
            return;
         }
      }
   }
   Print("Aviso: Master ID ", mID, " não encontrado no mapeamento local.");
}

void OnDeinit(const int reason) {
   EventKillTimer();
}

void Saida_por_Horario(int l_hora_zeragem, int l_min_zeragem, ulong magic_number, int l_hora, int min)
   {
      if(l_hora>l_hora_zeragem || ( l_hora==l_hora_zeragem && min>=l_min_zeragem )  )
         {
            Zerar_Posicoes(magic_number);
         }
   }

void Zerar_Posicoes(ulong magic_number)
   {
      for(int i=PositionsTotal()-1; i>=0; i--)
      {
         posicao.SelectByIndex(i);
         if(posicao.Magic()==magic_number){trade.PositionClose(posicao.Ticket(),ulong(SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE)));}
      }
   }
   
int m_TOld;
bool IsNewBar(string symbol,ENUM_TIMEFRAMES timeframe)
   {
      int TNew=(SeriesInfoInteger(_Symbol,timeframe,SERIES_BARS_COUNT));
      
      if(TNew>m_TOld && TNew)
        {
         m_TOld=TNew;
         return(true);
        }
      return(false); 
   }
   