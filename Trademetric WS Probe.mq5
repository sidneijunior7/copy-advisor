//+------------------------------------------------------------------+
//|                                        Trademetric WS Probe.mq5 |
//|                                 Copyright 2026, Trademetric Inc. |
//|                                   https://www.trademetric.com.br |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Trademetric Inc."
#property link      "https://www.trademetric.com.br"
#property version   "1.00"

#include "Include/TDM/WsClient.mqh"

// Protótipo da troca de transporte (Fase 0): exercita o WsClient.mqh contra o ws_echo.py.
// Não opera. A cada conexão: HELLO -> WELCOME -> SNAP grande -> mensagem fragmentada -> rajada,
// depois ecos até inp_total (acumulado entre conexões), conferindo conteúdo, ordem e latência.
// Com inp_testar_queda, pede ao servidor um CLOSE limpo e depois um DROP (TCP derrubado sem aviso)
// para validar a reconexão. Queda de rede e restart do servidor são testados à mão.

sinput string inp_host = "127.0.0.1";      // Server host
sinput int    inp_port = 8002;             // Port (443 = wss)
sinput string inp_path = "/v1/echo";       // Path
sinput bool   inp_tls = false;             // TLS (wss)
sinput string inp_token = "";              // ECHO_TOKEN
sinput int    inp_total = 10000;           // Echo messages to exchange (total)
sinput int    inp_janela = 50;             // Echo messages in flight
sinput int    inp_snap_bytes = 204800;     // SNAP size (bytes)
sinput bool   inp_testar_queda = true;     // Ask the server for CLOSE and DROP mid-test
sinput int    inp_timer = 50;              // Timer (ms)

enum FASE {F_HELLO, F_SNAP, F_FRAG, F_BURST, F_ECO, F_FIM};

const int BURST = 1000;
const int FRAG_PARTES = 7;
const string PADRAO = "abcdefghijklmnopqrstuvwxyz";

CWsClient ws;
FASE   fase = F_HELLO;
string sessao = "";
double hb_s = 5;

// Contadores acumulados
int    enviados = 0;      // Ecos enviados (seq)
int    esperado = 0;      // Próximo seq de eco que deve voltar
int    ok = 0, erros = 0, perdidos = 0;
int    snaps = 0, frags = 0, bursts = 0, hbs = 0, hb_atrasados = 0;
int    burst_i = 0;
ulong  rtt_soma = 0, rtt_max = 0;
ulong  ultimo_hb = 0;
bool   pediu_close = false, pediu_drop = false;
string em_voo[];
ulong  enviado_em[];
ulong  inicio = 0, fim_em = 0;
ulong  ultimo_comentario = 0;

int OnInit() {
   if(inp_token == "") {Print("Informe o ECHO_TOKEN."); return(INIT_PARAMETERS_INCORRECT);}
   if(inp_janela <= 0 || inp_total <= 0) return(INIT_PARAMETERS_INCORRECT);
   MathSrand((uint)(GetTickCount() ^ (uint)AccountInfoInteger(ACCOUNT_LOGIN)));
   ArrayResize(em_voo, inp_janela);
   ArrayResize(enviado_em, inp_janela);
   ws.Configurar(inp_host, inp_port, inp_path, inp_tls);
   inicio = GetTickCount64();
   EventSetMillisecondTimer(inp_timer);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {
   EventKillTimer();
   if(inicio > 0) Resumo("encerrado");  // OnInit falhou: não há teste para resumir
   ws.Desconectar();
   Comment("");
}

void OnTimer() {
   ws.Processar();
   if(ws.NovaConexao()) {
      // Ecos em voo na conexão anterior não voltam mais
      perdidos += enviados - esperado;
      esperado = enviados;
      fase = F_HELLO;
      ultimo_hb = GetTickCount64();
      ws.Enviar(StringFormat("HELLO|probe|v1|%s|%I64d|%s", inp_token, AccountInfoInteger(ACCOUNT_LOGIN),
                             MQLInfoString(MQL_PROGRAM_NAME)));
   }
   string msg;
   while(ws.Receber(msg)) Tratar(msg);

   if(ws.Aberto() && fase == F_ECO) EnviarEcos();
   if(ws.Aberto() && fase >= F_SNAP && GetTickCount64() - ultimo_hb > (ulong)(hb_s * 2000)) {
      hb_atrasados++;
      ultimo_hb = GetTickCount64();
      PrintFormat("HB atrasado: nada em %.0f s", hb_s * 2);
   }
   if(GetTickCount64() - ultimo_comentario > 500) {ultimo_comentario = GetTickCount64(); Painel();}
}

void Tratar(const string msg) {
   int p = StringFind(msg, "|");
   string tipo = p < 0 ? msg : StringSubstr(msg, 0, p);

   if(tipo == "HB") {hbs++; ultimo_hb = GetTickCount64(); return;}
   if(tipo == "ERR") {PrintFormat("Servidor recusou: %s", msg); return;}
   if(tipo == "WELCOME") {
      string f[];
      StringSplit(msg, '|', f);
      sessao = ArraySize(f) > 1 ? f[1] : "";
      hb_s = ArraySize(f) > 2 ? StringToDouble(f[2]) : 5;
      PrintFormat("Sessão %s aberta (conexão %d)", sessao, ws.Conexoes());
      fase = F_SNAP;
      ws.Enviar(StringFormat("SNAP|%d", inp_snap_bytes));
      return;
   }
   if(tipo == "SNAP" && fase == F_SNAP) {
      if(ConferirPadrao(msg, "SNAP", inp_snap_bytes)) snaps++; else erros++;
      fase = F_FRAG;
      ws.Enviar(StringFormat("FRAG|%d|%d", 100000, FRAG_PARTES));
      return;
   }
   if(tipo == "FRAG" && fase == F_FRAG) {
      if(ConferirPadrao(msg, "FRAG", 100000)) frags++; else erros++;
      fase = F_BURST;
      burst_i = 0;
      ws.Enviar(StringFormat("BURST|%d", BURST));
      return;
   }
   if(tipo == "B" && fase == F_BURST) {
      if(msg != "B|" + (string)burst_i) {PrintFormat("Rajada fora de ordem: esperava %d, veio %s", burst_i, msg); erros++;}
      burst_i++;
      if(burst_i == BURST) {bursts++; fase = F_ECO;}
      return;
   }
   if(tipo == "ECHO") {ConferirEco(msg); return;}
   PrintFormat("Mensagem inesperada na fase %d: %s", fase, StringSubstr(msg, 0, 80));
   erros++;
}

// Payload com acento (UTF-8 de 2 bytes) e tamanhos que cobrem os três formatos de comprimento
string Eco(int seq) {
   int extra = seq % 1000 == 999 ? 70000 : (seq * 37) % 1500;
   string pad = "";
   StringInit(pad, extra, 'x');
   return StringFormat("ECHO|%d|ação|%s", seq, pad);
}

void EnviarEcos() {
   while(enviados - esperado < inp_janela && enviados < inp_total) {
      if(inp_testar_queda && !pediu_close && enviados == inp_total * 3 / 10) {pediu_close = true; ws.Enviar("CLOSE"); return;}
      if(inp_testar_queda && !pediu_drop && enviados == inp_total * 6 / 10) {pediu_drop = true; ws.Enviar("DROP"); return;}
      int i = enviados % inp_janela;
      em_voo[i] = Eco(enviados);
      enviado_em[i] = GetMicrosecondCount();
      if(!ws.Enviar(em_voo[i])) return;
      enviados++;
   }
}

void ConferirEco(const string msg) {
   string f[];
   StringSplit(msg, '|', f);
   int seq = ArraySize(f) > 1 ? (int)StringToInteger(f[1]) : -1;
   if(seq != esperado) {
      PrintFormat("Eco fora de ordem: esperava %d, veio %d", esperado, seq);
      erros++;
      if(seq < esperado || seq >= enviados) return;
      esperado = seq;
   }
   int i = seq % inp_janela;
   if(msg == em_voo[i]) {
      ok++;
      ulong rtt = GetMicrosecondCount() - enviado_em[i];
      rtt_soma += rtt;
      rtt_max = MathMax(rtt_max, rtt);
   }
   else {
      PrintFormat("Eco %d diferente: enviado %d chars, recebido %d", seq, StringLen(em_voo[i]), StringLen(msg));
      erros++;
   }
   em_voo[i] = NULL;
   esperado = seq + 1;
   if(ok % 1000 == 0) Resumo("progresso");
   if(esperado == inp_total && fim_em == 0) {fim_em = GetTickCount64(); Resumo("CONCLUÍDO"); fase = F_FIM;}
}

bool ConferirPadrao(const string msg, const string tipo, int n) {
   string prefixo = StringFormat("%s|%d|", tipo, n);
   int len = StringLen(msg);
   if(StringSubstr(msg, 0, StringLen(prefixo)) != prefixo || len != StringLen(prefixo) + n) {
      PrintFormat("%s com tamanho errado: %d chars, esperado %d", tipo, len, StringLen(prefixo) + n);
      return false;
   }
   int base = StringLen(prefixo);
   for(int i = 0; i < n; i++)
      if(StringGetCharacter(msg, base + i) != StringGetCharacter(PADRAO, i % 26)) {
         PrintFormat("%s corrompido na posição %d", tipo, i);
         return false;
      }
   return true;
}

void Resumo(const string quando) {
   PrintFormat("[%s] ecos %d/%d ok, %d erros, %d perdidos em reconexão | SNAP %d, FRAG %d, rajadas %d | "
               "conexões %d, HB %d (%d atrasados) | RTT médio %.2f ms, máx %.2f ms | %.0f s",
               quando, ok, inp_total, erros, perdidos, snaps, frags, bursts, ws.Conexoes(), hbs, hb_atrasados,
               ok > 0 ? rtt_soma / 1000.0 / ok : 0, rtt_max / 1000.0,
               ((fim_em > 0 ? fim_em : GetTickCount64()) - inicio) / 1000.0);
}

void Painel() {
   Comment(StringFormat("TDM WS Probe  %s://%s:%d%s\n"
                        "Estado: %s  sessão %s  fase %d  conexões %d\n"
                        "Ecos: %d/%d ok  erros %d  perdidos %d\n"
                        "SNAP %d  FRAG %d  rajadas %d  HB %d (%d atrasados)\n"
                        "RTT médio %.2f ms  máx %.2f ms\n%s",
                        inp_tls ? "wss" : "ws", inp_host, inp_port, inp_path,
                        ws.Aberto() ? "ABERTO" : "DESCONECTADO", sessao, fase, ws.Conexoes(),
                        ok, inp_total, erros, perdidos, snaps, frags, bursts, hbs, hb_atrasados,
                        ok > 0 ? rtt_soma / 1000.0 / ok : 0, rtt_max / 1000.0,
                        ws.Aberto() ? "" : "Último erro: " + ws.UltimoErro()));
}
