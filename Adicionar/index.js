const express = require("express");
const fs = require("fs-extra");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Pasta para autenticação por sessão
const AUTH_BASE_DIR = "./auth";

// Estado global
const sessions = new Map();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// Funções auxiliares
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function dividirEmLotes(array, tamanho) {
  const lotes = [];
  for (let i = 0; i < array.length; i += tamanho) {
    lotes.push(array.slice(i, i + tamanho));
  }
  return lotes;
}

function aleatorio(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}

// Inicializar sessão
async function criarSessao(sessionId) {
  const authPath = `${AUTH_BASE_DIR}/${sessionId}`;
  await fs.ensureDir(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    browser: [`${sessionId}`, "Safari", "3.0"],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    emitOwnEvents: true,
  });

  sock.ev.on("creds.update", saveCreds);

  // Estado da sessão
  let connected = false;
  let emAdicao = false;
  let fila = [];
  let ultimoLote = 0;
  let totalAdicionados = 0;

  const LOTE_TAMANHO = 5;
  const INTERVALO_LOTES_MIN = [10, 12, 15];
  const INTERVALO_MINILOTE_SEG = [20, 30, 60, 90, 120, 180];

  // Armazenar antes de escutar eventos
  const session = {
    sock,
    saveCreds,
    qr: null, // vai ser atualizado
    connected,
    fila,
    emAdicao,
    ultimoLote,
    totalAdicionados,
    authPath,
    LOTE_TAMANHO,
    INTERVALO_LOTES_MIN,
    INTERVALO_MINILOTE_SEG,
  };
  sessions.set(sessionId, session);

  // Agora escute eventos
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        session.qr = qrImage; // ✅ Atualiza diretamente no objeto da sessão
        broadcast(sessionId, { type: "qr_code", qr: qrImage, sessionId });
        console.log(`📱 QR Code gerado para ${sessionId}. Escaneie em /qr/${sessionId}`);
      } catch (err) {
        console.error(`❌ Erro ao gerar QR Code para ${sessionId}:`, err);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`⛔ Sessão ${sessionId} encerrada. Limpando...`);
        await fs.remove(authPath);
        sessions.delete(sessionId);
      } else {
        console.log(`🔄 ${sessionId}: Tentando reconectar...`);
        setTimeout(() => criarSessao(sessionId), 3000);
      }
      session.connected = false;
      broadcast(sessionId, { type: "disconnected", sessionId });
    } else if (connection === "open") {
      console.log(`✅ ${sessionId} conectado ao WhatsApp!`);
      session.connected = true;
      session.qr = null; // limpa QR após login
      broadcast(sessionId, { type: "connected", sessionId });
      processarFila(sessionId);
    }
  });

  return sock;
}

// Processar fila (mantido igual)
async function processarFila(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.emAdicao || !session.sock || session.fila.length === 0) return;

  session.emAdicao = true;
  const lote = session.fila.splice(0, session.LOTE_TAMANHO);
  const groupId = lote[0].groupId;
  const numeros = lote.map((x) => x.number);
  const miniLotes = dividirEmLotes(numeros, Math.random() < 0.5 ? 2 : 3);

  console.log(`🚀 ${sessionId}: Iniciando lote com ${numeros.length} números para o grupo ${groupId}`);
  broadcast(sessionId, {
    type: "batch_start",
    count: numeros.length,
    groupId,
    sessionId,
  });

  let resultadosMini = [];

  for (let i = 0; i < miniLotes.length; i++) {
    const miniLote = miniLotes[i];
    const resultadosDoMini = [];

    for (const num of miniLote) {
      broadcast(sessionId, { type: "adding_now", numberAtual: num, sessionId });

      try {
        const isAlready = await session.sock.groupMetadata(groupId)
          .then(g => g.participants.some(p => p.id === num + "@s.whatsapp.net"))
          .catch(() => false);

        if (isAlready) {
          resultadosDoMini.push({ number: num, status: "já está no grupo" });
          continue;
        }

        const response = await session.sock.groupParticipantsUpdate(
          groupId,
          [num + "@s.whatsapp.net"],
          "add"
        );

        const result = response[0];
        if (result.status === 200) {
          resultadosDoMini.push({ number: num, status: "adicionado com sucesso" });
          session.totalAdicionados++;
        } else {
          resultadosDoMini.push({ number: num, status: `erro ${result.status}` });
        }
      } catch (err) {
        resultadosDoMini.push({ number: num, status: "erro", error: err.message });
      }
    }

    resultadosMini = resultadosMini.concat(resultadosDoMini);

    broadcast(sessionId, {
      type: "mini_lote_concluido",
      lote: i + 1,
      totalMiniLotes: miniLotes.length,
      resultados: resultadosMini,
      sessionId,
    });

    if (i < miniLotes.length - 1) {
      const intervalo = aleatorio(session.INTERVALO_MINILOTE_SEG) * 1000;
      console.log(`⏳ ${sessionId}: Pausa de ${intervalo / 1000}s antes do próximo mini-lote...`);
      await delay(intervalo);
    }
  }

  const proximoLoteMin = aleatorio(session.INTERVALO_LOTES_MIN);
  const proximoLoteMs = proximoLoteMin * 60 * 1000;
  session.ultimoLote = Date.now();

  broadcast(sessionId, {
    type: "batch_done",
    lastBatchCount: numeros.length,
    nextAddInMs: proximoLoteMs,
    results: resultadosMini,
    sessionId,
  });

  if (session.fila.length > 0) {
    setTimeout(() => {
      session.emAdicao = false;
      processarFila(sessionId);
    }, proximoLoteMs);
  } else {
    session.emAdicao = false;
  }
}

// Broadcast
function broadcast(sessionId, data) {
  const json = JSON.stringify({ ...data, sessionId });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
      client.send(json);
    }
  });
}

// Rota /qr/:sessionId — MOSTRA QR OU TEXTO BASE64
app.get("/qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return res.status(400).send("ID de sessão inválido.");
  }

  let session = sessions.get(sessionId);
  if (!session) {
    console.log(`🆕 Iniciando nova sessão: ${sessionId}`);
    await criarSessao(sessionId);
    session = sessions.get(sessionId);
  }

  // Forçar reconexão se já conectado
  if (session.connected) {
    return res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>✅ Conectado!</h3>
          <p>Conta <strong>${sessionId}</strong> já está logada.</p>
        </body>
      </html>
    `);
  }

  // Mostrar QR ou Base64
  const qrCode = session.qr;

  if (qrCode) {
    res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>📱 Escaneie o QR Code - ${sessionId}</h3>
          <img src="${qrCode}" style="width: 250px; height: 250px;" />
          <p><small>Sessão: ${sessionId}</small></p>
        </body>
      </html>
    `);
  } else {
    // Mostra mensagem + espaço para Base64 aparecer depois
    res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>⏳ Aguardando geração do QR Code...</h3>
          <p>Conecte-se ao WhatsApp escaneando o QR.</p>
          <p><strong>Conta:</strong> ${sessionId}</p>
          <div id="qr-base64" style="margin: 20px; font-size: 0.9rem; background: #eee; color: #000; padding: 10px; border-radius: 8px; display: none;">
            <strong>QR Base64 (copie e cole em um gerador):</strong><br/>
            <textarea id="base64-text" rows="6" style="width:90%; font-size:0.8rem;"></textarea>
          </div>
          <script>
            const ws = new WebSocket((window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host + "/ws/${sessionId}");
            ws.onmessage = (event) => {
              const data = JSON.parse(event.data);
              if (data.type === "qr_code" && data.qr) {
                document.body.innerHTML = \`
                  <h3>📱 Escaneie o QR Code - ${sessionId}</h3>
                  <img src="\${data.qr}" style="width: 250px; height: 250px;" />
                  <p><small>Sessão: ${sessionId}</small></p>
                  <button onclick="copyBase64()" style="margin-top:10px;">Copiar Base64</button>
                  <script>
                    function copyBase64() {
                      navigator.clipboard.writeText('\${data.qr}');
                      alert("Base64 copiado!");
                    }
                  <\/script>
                \`;
              }
            };
          </script>
        </body>
      </html>
    `);
  }
});

// Rotas POST e GET (mantidas)
app.post("/adicionar/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { groupId, numbers } = req.body;

  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return res.status(400).json({ error: "ID de sessão inválido." });
  }

  if (!groupId || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "Grupo ou números inválidos." });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(503).json({ error: "Sessão não encontrada. Gere o QR primeiro." });
  }

  if (!session.connected) {
    return res.status(503).json({ error: "WhatsApp não conectado. Escaneie o QR." });
  }

  if (session.emAdicao) {
    const tempoRestante = Math.max(0, (session.ultimoLote + 5 * 60 * 1000) - Date.now());
    return res.status(429).json({
      error: "Adição em andamento. Aguarde.",
      nextAddInSeconds: Math.ceil(tempoRestante / 1000),
    });
  }

  numbers.forEach((num) => session.fila.push({ groupId, number: num }));
  if (!session.emAdicao && session.connected) {
    processarFila(sessionId);
  }

  res.json({
    success: true,
    message: `Processo iniciado. Números na fila: ${session.fila.length}`,
    sessionId,
  });
});

// WebSocket
wss.on("connection", (ws, req) => {
  const pathname = req.url;
  const match = pathname.match(/\/ws\/([^\/]+)/);
  const sessionId = match ? match[1] : "default";

  ws.sessionId = sessionId;
  const session = sessions.get(sessionId);

  if (session?.qr) {
    ws.send(JSON.stringify({ type: "qr_code", qr: session.qr, sessionId }));
  }
  if (session?.connected) {
    ws.send(JSON.stringify({ type: "connected", sessionId }));
  }
});

// Iniciar servidor
server.listen(PORT, async () => {
  await fs.ensureDir(AUTH_BASE_DIR);
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
