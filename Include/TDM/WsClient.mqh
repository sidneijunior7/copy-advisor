//+------------------------------------------------------------------+
//|                                                     WsClient.mqh |
//|                                 Copyright 2026, Trademetric Inc. |
//|                                   https://www.trademetric.com.br |
//+------------------------------------------------------------------+
// Cliente WebSocket (RFC 6455) sobre os sockets nativos do MQL5, com ou sem
// TLS. Sem DLL.
//
// Uso, sempre na thread do EA (OnTimer):
//   CWsClient ws;
//   ws.Configurar("signals.trademetric.com.br", 443, "/v1/slave", true);
//   OnTimer: ws.Processar();  string msg; while(ws.Receber(msg)) {...}
//            if(ws.NovaConexao()) ws.Enviar("HELLO|...");
//
// Processar() conecta quando é hora (backoff de 1 a 30 s com jitter), lê sem
// bloquear tudo que chegou, monta os frames (inclusive fragmentados), responde
// ping e close, e derruba a conexão se nada chegar em idle_ms. A conexão e o
// upgrade HTTP bloqueiam por até timeout_ms; o resto nunca bloqueia.
//
// O domínio precisa estar em Ferramentas > Opções > Expert Advisors > "Permitir
// WebRequest para as URLs listadas" (vale também para SocketConnect). Sem isso,
// SocketConnect falha com o erro 4014.

#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
#define WS_OP_CONT 0x0
#define WS_OP_TEXT 0x1
#define WS_OP_BINARY 0x2
#define WS_OP_CLOSE 0x8
#define WS_OP_PING 0x9
#define WS_OP_PONG 0xA

enum ENUM_WS_ESTADO { WS_DESCONECTADO = 0, WS_ABERTO = 1 };

class CWsClient {
private:
  string m_host;
  uint m_port;
  string m_path;
  bool m_tls;
  uint m_timeout_ms; // Conexão, TLS e upgrade
  uint m_idle_ms;    // Sem bytes recebidos por esse tempo = conexão morta
  uint m_max_msg;    // Maior mensagem aceita (bytes)

  int m_sock;
  ENUM_WS_ESTADO m_estado;
  ulong m_aberto_em;
  ulong m_ultimo_rx;
  ulong m_proxima_tentativa;
  uint m_backoff_ms;
  bool m_nova;
  int m_conexoes;
  string m_erro;

  uchar m_rx[]; // Bytes recebidos ainda não consumidos, de m_rx_ini a m_rx_fim
  int m_rx_ini;
  int m_rx_fim;
  uchar m_msg[]; // Mensagem fragmentada em montagem
  int m_msg_len;
  int m_msg_op; // Opcode da mensagem em montagem, -1 = nenhuma

  string m_fila[]; // Mensagens completas aguardando Receber()
  int m_fila_ini;
  int m_fila_fim;

  bool Conectar();
  bool Upgrade();
  bool EnviarBytes(const uchar &buf[], int len);
  int LerDisponivel(uchar &buf[], int max);
  bool EnviarFrame(int opcode, const uchar &payload[], int len);
  bool LerFrames();
  void Enfileirar(const string msg);
  void Fechar(const string motivo, bool reconectar);
  void Acrescentar(const uchar &src[], int ini, int len);
  static string Base64(const uchar &data[]);
  static int Utf8(const string s, uchar &out[]);

public:
  CWsClient();
  ~CWsClient() { Desconectar(); }
  void Configurar(string host, uint port, string path, bool tls,
                  uint timeout_ms = 5000, uint idle_ms = 15000,
                  uint max_msg = 4194304);
  void Processar();
  bool Receber(string &msg);
  bool Enviar(const string msg);
  void Desconectar();
  bool NovaConexao() {
    bool n = m_nova;
    m_nova = false;
    return n;
  } // true uma vez por conexão aberta
  bool Aberto() { return m_estado == WS_ABERTO; }
  int Conexoes() { return m_conexoes; }
  string UltimoErro() { return m_erro; }
  ulong SemDadosMs() {
    return m_estado == WS_ABERTO ? GetTickCount64() - m_ultimo_rx : 0;
  }
};

CWsClient::CWsClient() {
  m_sock = INVALID_HANDLE;
  m_estado = WS_DESCONECTADO;
  m_backoff_ms = 1000;
  m_proxima_tentativa = 0;
  m_nova = false;
  m_conexoes = 0;
  m_rx_ini = m_rx_fim = 0;
  m_msg_len = 0;
  m_msg_op = -1;
  m_fila_ini = m_fila_fim = 0;
  m_timeout_ms = 5000;
  m_idle_ms = 15000;
  m_max_msg = 4194304;
}

void CWsClient::Configurar(string host, uint port, string path, bool tls,
                           uint timeout_ms, uint idle_ms, uint max_msg) {
  m_host = host;
  m_port = port;
  m_path = path == "" ? "/" : path;
  m_tls = tls;
  m_timeout_ms = timeout_ms;
  m_idle_ms = idle_ms;
  m_max_msg = max_msg;
  m_backoff_ms = 1000;
  m_proxima_tentativa = 0;
}

//+------------------------------------------------------------------+
//| Ciclo: conectar quando é hora, ler, detectar conexão morta       |
//+------------------------------------------------------------------+
void CWsClient::Processar() {
  if (m_estado == WS_DESCONECTADO) {
    if (m_host == "" || GetTickCount64() < m_proxima_tentativa)
      return;
    if (!Conectar())
      Fechar(m_erro, true);
    return;
  }
  if (!LerFrames())
    return; // LerFrames já fechou
  if (GetTickCount64() - m_ultimo_rx > m_idle_ms)
    Fechar(StringFormat("nada recebido em %u ms", m_idle_ms), true);
}

bool CWsClient::Conectar() {
  ResetLastError();
  m_sock = SocketCreate();
  if (m_sock == INVALID_HANDLE) {
    m_erro = StringFormat("SocketCreate falhou (%d)", GetLastError());
    return false;
  }
  if (!SocketConnect(m_sock, m_host, m_port, m_timeout_ms)) {
    int e = GetLastError();
    m_erro = e == 4014
                 ? StringFormat("conexão bloqueada pelo terminal: adicione "
                                "%s://%s em Ferramentas > Opções > Expert "
                                "Advisors > Permitir WebRequest",
                                m_tls ? "https" : "http", m_host)
                 : StringFormat("SocketConnect %s:%u falhou (%d)", m_host,
                                m_port, e);
    return false;
  }
  SocketTimeouts(m_sock, m_timeout_ms, m_timeout_ms);
  if (m_tls) {
    // Na porta 443 o terminal já faz o handshake no SocketConnect; nas outras,
    // é explícito
    string subject, issuer, serial, thumbprint;
    datetime expira;
    if (!SocketTlsCertificate(m_sock, subject, issuer, serial, thumbprint,
                              expira) &&
        !SocketTlsHandshake(m_sock, m_host)) {
      m_erro = StringFormat("handshake TLS com %s falhou (%d)", m_host,
                            GetLastError());
      return false;
    }
  }
  m_rx_ini = m_rx_fim = 0;
  m_msg_len = 0;
  m_msg_op = -1;
  if (!Upgrade())
    return false;

  m_estado = WS_ABERTO;
  m_aberto_em = m_ultimo_rx = GetTickCount64();
  m_nova = true;
  m_conexoes++;
  m_erro = "";
  return true;
}

// Requisição de upgrade e validação do 101 e do Sec-WebSocket-Accept. Bytes que
// chegarem depois do cabeçalho (o servidor pode mandar a primeira mensagem
// junto) ficam no buffer para LerFrames().
bool CWsClient::Upgrade() {
  uchar nonce[16];
  for (int i = 0; i < 16; i++)
    nonce[i] = (uchar)(MathRand() & 0xFF);
  string key = Base64(nonce);
  string host = (m_tls && m_port == 443) || (!m_tls && m_port == 80)
                    ? m_host
                    : m_host + ":" + (string)m_port;
  string req = "GET " + m_path + " HTTP/1.1\r\n" + "Host: " + host + "\r\n" +
               "Upgrade: websocket\r\n" + "Connection: Upgrade\r\n" +
               "Sec-WebSocket-Key: " + key + "\r\n" +
               "Sec-WebSocket-Version: 13\r\n" +
               "User-Agent: TDM-Mirror-MQL5\r\n\r\n";
  uchar out[];
  int n = Utf8(req, out);
  if (!EnviarBytes(out, n))
    return false;

  ulong limite = GetTickCount64() + m_timeout_ms;
  int fim_cabecalho = -1;
  uchar buf[];
  while (fim_cabecalho < 0) {
    if (GetTickCount64() > limite) {
      m_erro = "sem resposta ao upgrade";
      return false;
    }
    int lidos = LerDisponivel(buf, 65536);
    if (lidos < 0)
      return false;
    if (lidos == 0) {
      Sleep(10);
      continue;
    }
    Acrescentar(buf, 0, lidos);
    for (int i = MathMax(m_rx_ini, m_rx_fim - lidos - 3); i + 3 < m_rx_fim; i++)
      if (m_rx[i] == '\r' && m_rx[i + 1] == '\n' && m_rx[i + 2] == '\r' &&
          m_rx[i + 3] == '\n') {
        fim_cabecalho = i + 4;
        break;
      }
    if (m_rx_fim > 16384 && fim_cabecalho < 0) {
      m_erro = "cabeçalho de upgrade grande demais";
      return false;
    }
  }
  string cabecalho = CharArrayToString(m_rx, 0, fim_cabecalho, CP_UTF8);
  m_rx_ini = fim_cabecalho;

  string linhas[];
  int k = StringSplit(cabecalho, '\n', linhas);
  if (k < 1 || StringFind(linhas[0], " 101") < 0) {
    StringTrimRight(linhas[0]);
    m_erro = "upgrade recusado: " + linhas[0];
    return false;
  }
  uchar src[], vazio[], hash[];
  Utf8(key + WS_GUID, src);
  if (CryptEncode(CRYPT_HASH_SHA1, src, vazio, hash) != 20) {
    m_erro = "SHA1 falhou";
    return false;
  }
  string aceite = Base64(hash);
  for (int i = 1; i < k; i++) {
    int p = StringFind(linhas[i], ":");
    if (p < 0)
      continue;
    string nome = StringSubstr(linhas[i], 0, p);
    string valor = StringSubstr(linhas[i], p + 1);
    StringToLower(nome);
    StringTrimLeft(valor);
    StringTrimRight(valor);
    if (nome == "sec-websocket-accept") {
      if (valor == aceite)
        return true;
      m_erro = "Sec-WebSocket-Accept inválido";
      return false;
    }
  }
  m_erro = "resposta sem Sec-WebSocket-Accept";
  return false;
}

//+------------------------------------------------------------------+
//| Leitura e montagem de frames                                     |
//+------------------------------------------------------------------+
// Retorna false se a conexão foi fechada.
bool CWsClient::LerFrames() {
  uchar buf[];
  int total = 0;
  while (total <
         4194304) { // Não segura o terminal indefinidamente sob fluxo contínuo
    int lidos = LerDisponivel(buf, 65536);
    if (lidos < 0) {
      Fechar(m_erro, true);
      return false;
    }
    if (lidos == 0)
      break;
    Acrescentar(buf, 0, lidos);
    total += lidos;
  }
  if (total > 0)
    m_ultimo_rx = GetTickCount64();
  else if (!SocketIsConnected(m_sock)) {
    Fechar("conexão encerrada pelo servidor", true);
    return false;
  }

  while (m_rx_fim - m_rx_ini >= 2) {
    int b0 = m_rx[m_rx_ini], b1 = m_rx[m_rx_ini + 1];
    bool fin = (b0 & 0x80) != 0;
    int op = b0 & 0x0F;
    if ((b0 & 0x70) != 0 || (b1 & 0x80) != 0) {
      Fechar("frame inválido (RSV ou máscara do servidor)", true);
      return false;
    }
    int cab = 2;
    ulong len = b1 & 0x7F;
    if (len == 126) {
      if (m_rx_fim - m_rx_ini < 4)
        break;
      len = ((ulong)m_rx[m_rx_ini + 2] << 8) | m_rx[m_rx_ini + 3];
      cab = 4;
    } else if (len == 127) {
      if (m_rx_fim - m_rx_ini < 10)
        break;
      len = 0;
      for (int i = 0; i < 8; i++)
        len = (len << 8) | m_rx[m_rx_ini + 2 + i];
      cab = 10;
    }
    if (len > m_max_msg) {
      Fechar(StringFormat("frame de %I64u bytes excede o limite", len), true);
      return false;
    }
    if ((ulong)(m_rx_fim - m_rx_ini - cab) < len)
      break; // Frame incompleto: espera o resto
    int ini = m_rx_ini + cab, n = (int)len;
    m_rx_ini = ini + n;

    if (op >= WS_OP_CLOSE) {
      if (!fin || n > 125) {
        Fechar("frame de controle inválido", true);
        return false;
      }
      if (op == WS_OP_PING) {
        uchar p[];
        ArrayResize(p, n);
        if (n > 0)
          ArrayCopy(p, m_rx, 0, ini, n);
        EnviarFrame(WS_OP_PONG, p, n);
      } else if (op == WS_OP_CLOSE) {
        int code = n >= 2 ? ((int)m_rx[ini] << 8) | m_rx[ini + 1] : 1005;
        string motivo =
            n > 2 ? CharArrayToString(m_rx, ini + 2, n - 2, CP_UTF8) : "";
        Fechar(StringFormat("servidor fechou (%d %s)", code, motivo), true);
        return false;
      }
      continue; // pong: só conta como tráfego
    }
    if (op == WS_OP_CONT) {
      if (m_msg_op < 0) {
        Fechar("continuação sem mensagem aberta", true);
        return false;
      }
    } else if (op == WS_OP_TEXT || op == WS_OP_BINARY) {
      if (m_msg_op >= 0) {
        Fechar("mensagem nova antes de terminar a fragmentada", true);
        return false;
      }
      m_msg_op = op;
      m_msg_len = 0;
    } else {
      Fechar(StringFormat("opcode desconhecido %d", op), true);
      return false;
    }

    if ((ulong)m_msg_len + len > m_max_msg) {
      Fechar("mensagem excede o limite", true);
      return false;
    }
    if (fin &&
        m_msg_len ==
            0) // Caso comum: mensagem num frame só, sem cópia intermediária
      Enfileirar(n > 0 ? CharArrayToString(m_rx, ini, n, CP_UTF8) : "");
    else {
      if (ArraySize(m_msg) < m_msg_len + n)
        ArrayResize(m_msg, m_msg_len + n, 65536);
      if (n > 0)
        ArrayCopy(m_msg, m_rx, m_msg_len, ini, n);
      m_msg_len += n;
      if (fin)
        Enfileirar(CharArrayToString(m_msg, 0, m_msg_len, CP_UTF8));
    }
    if (fin) {
      m_msg_op = -1;
      m_msg_len = 0;
    }
  }
  // Compacta: o que sobrou (frame parcial) vai para o início do buffer
  if (m_rx_ini == m_rx_fim)
    m_rx_ini = m_rx_fim = 0;
  else if (m_rx_ini > 0) {
    ArrayCopy(m_rx, m_rx, 0, m_rx_ini, m_rx_fim - m_rx_ini);
    m_rx_fim -= m_rx_ini;
    m_rx_ini = 0;
  }
  return true;
}

void CWsClient::Acrescentar(const uchar &src[], int ini, int len) {
  if (ArraySize(m_rx) < m_rx_fim + len)
    ArrayResize(m_rx, m_rx_fim + len, 65536);
  ArrayCopy(m_rx, src, m_rx_fim, ini, len);
  m_rx_fim += len;
}

void CWsClient::Enfileirar(const string msg) {
  if (m_fila_ini == m_fila_fim)
    m_fila_ini = m_fila_fim = 0;
  if (ArraySize(m_fila) <= m_fila_fim)
    ArrayResize(m_fila, m_fila_fim + 1, 256);
  m_fila[m_fila_fim++] = msg;
}

bool CWsClient::Receber(string &msg) {
  if (m_fila_ini >= m_fila_fim)
    return false;
  msg = m_fila[m_fila_ini];
  m_fila[m_fila_ini++] = NULL;
  return true;
}

//+------------------------------------------------------------------+
//| Envio                                                            |
//+------------------------------------------------------------------+
bool CWsClient::Enviar(const string msg) {
  if (m_estado != WS_ABERTO)
    return false;
  uchar p[];
  int n = Utf8(msg, p);
  return EnviarFrame(WS_OP_TEXT, p, n);
}

// Frames do cliente são sempre mascarados (RFC 6455, 5.3)
bool CWsClient::EnviarFrame(int opcode, const uchar &payload[], int len) {
  uchar f[];
  int cab = len < 126 ? 2 : (len <= 65535 ? 4 : 10);
  ArrayResize(f, cab + 4 + len);
  f[0] = (uchar)(0x80 | opcode);
  if (len < 126)
    f[1] = (uchar)(0x80 | len);
  else if (len <= 65535) {
    f[1] = (uchar)(0x80 | 126);
    f[2] = (uchar)(len >> 8);
    f[3] = (uchar)(len & 0xFF);
  } else {
    f[1] = (uchar)(0x80 | 127);
    for (int i = 0; i < 8; i++)
      f[2 + i] = (uchar)(((ulong)len >> (8 * (7 - i))) & 0xFF);
  }
  uchar mask[4];
  for (int i = 0; i < 4; i++) {
    mask[i] = (uchar)(MathRand() & 0xFF);
    f[cab + i] = mask[i];
  }
  for (int i = 0; i < len; i++)
    f[cab + 4 + i] = (uchar)(payload[i] ^ mask[i & 3]);
  if (EnviarBytes(f, ArraySize(f)))
    return true;
  Fechar(m_erro, opcode != WS_OP_CLOSE); // CLOSE só sai do Desconectar: não
                                         // reconecta nem avisa nova tentativa
  return false;
}

bool CWsClient::EnviarBytes(const uchar &buf[], int len) {
  int enviado = 0;
  ulong limite = GetTickCount64() + m_timeout_ms;
  uchar resto[];
  while (enviado < len) {
    int r;
    if (enviado == 0)
      r = m_tls ? SocketTlsSend(m_sock, buf, len)
                : SocketSend(m_sock, buf, len);
    else {
      ArrayCopy(resto, buf, 0, enviado, len - enviado);
      ArrayResize(resto, len - enviado);
      r = m_tls ? SocketTlsSend(m_sock, resto, len - enviado)
                : SocketSend(m_sock, resto, len - enviado);
    }
    if (r < 0) {
      m_erro = StringFormat("envio falhou (%d)", GetLastError());
      return false;
    }
    enviado += r;
    if (enviado < len) {
      if (GetTickCount64() > limite) {
        m_erro = "envio excedeu o tempo limite";
        return false;
      }
      Sleep(1);
    }
  }
  return true;
}

// Lê o que já chegou, sem bloquear. Retorna os bytes lidos (0 = nada) ou -1 em
// erro.
int CWsClient::LerDisponivel(uchar &buf[], int max) {
  if (m_tls) {
    int r = SocketTlsReadAvailable(m_sock, buf, max);
    if (r < 0)
      m_erro = StringFormat("leitura TLS falhou (%d)", GetLastError());
    return r;
  }
  uint disponivel = SocketIsReadable(m_sock);
  if (disponivel == 0)
    return 0;
  int r = SocketRead(m_sock, buf, MathMin(disponivel, (uint)max), 1);
  if (r < 0)
    m_erro = StringFormat("leitura falhou (%d)", GetLastError());
  return r;
}

//+------------------------------------------------------------------+
//| Encerramento e reconexão                                         |
//+------------------------------------------------------------------+
void CWsClient::Fechar(const string motivo, bool reconectar) {
  if (m_sock != INVALID_HANDLE)
    SocketClose(m_sock);
  m_sock = INVALID_HANDLE;
  bool estava_aberto = m_estado == WS_ABERTO;
  m_estado = WS_DESCONECTADO;
  m_nova = false;
  m_erro = motivo;
  m_rx_ini = m_rx_fim = 0;
  m_msg_op = -1;
  m_msg_len = 0;
  if (!reconectar) {
    m_proxima_tentativa = ULONG_MAX;
    return;
  }
  // Conexão que durou 30 s conta como estável: recomeça o backoff. Sem isso, um
  // servidor que aceita e derruba em seguida faria o EA reconectar a cada
  // segundo.
  if (estava_aberto && GetTickCount64() - m_aberto_em >= 30000)
    m_backoff_ms = 1000;
  uint jitter = (uint)(m_backoff_ms * (MathRand() / 32767.0) * 0.4);
  m_proxima_tentativa =
      GetTickCount64() + m_backoff_ms - m_backoff_ms / 5 + jitter; // ±20%
  PrintFormat("[ws] %s%s; nova tentativa em %.1f s",
              estava_aberto ? "conexão perdida: " : "falha ao conectar: ",
              motivo, (m_proxima_tentativa - GetTickCount64()) / 1000.0);
  m_backoff_ms = MathMin(m_backoff_ms * 2, 30000);
}

void CWsClient::Desconectar() {
  if (m_estado == WS_ABERTO) {
    uchar p[2] = {0x03, 0xE8}; // 1000 = encerramento normal
    EnviarFrame(WS_OP_CLOSE, p, 2);
  }
  if (m_sock != INVALID_HANDLE)
    SocketClose(m_sock);
  m_sock = INVALID_HANDLE;
  m_estado = WS_DESCONECTADO;
  m_proxima_tentativa = ULONG_MAX;
}

//+------------------------------------------------------------------+
//| Utilitários                                                      |
//+------------------------------------------------------------------+
string CWsClient::Base64(const uchar &data[]) {
  uchar vazio[], out[];
  CryptEncode(CRYPT_BASE64, data, vazio, out);
  return CharArrayToString(out, 0, ArraySize(out), CP_ACP);
}

// UTF-8 sem o terminador nulo que StringToCharArray acrescenta
int CWsClient::Utf8(const string s, uchar &out[]) {
  int n = StringToCharArray(s, out, 0, -1, CP_UTF8);
  if (n > 0 && out[n - 1] == 0)
    n--;
  ArrayResize(out, n);
  return n;
}
