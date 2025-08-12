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
  Browsers,
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// 🔌 Porta dinâmica do Render
const PORT = process.env.PORT || 3000;
const AUTH_BASE_DIR = "./auth";
const BASE_URL = process.env.BASE_URL || `https://seu-projeto.onrender.com`; // 🔥 IMPORTANTE: Substitua!

// 🧠 Sessões ativas
const sessions = new Map();

// 🛠️ Middleware
app.use(
  cors({
    origin: true, // Aceita qualquer origem (ou defina seu domínio)
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// 🔧 Funções auxiliares
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dividirEmLotes = (array, tamanho) => {
  const lotes = [];
  for (let i = 0; i < array.length; i += tamanho) {
    lotes.push(array.slice(i, i + tamanho));
  }
  return lotes;
};

const aleatorio = (lista) => lista[Math.floor(Math.random() * lista.length)];

// 🔄 Criar sessão WhatsApp
async function criarSessao(sessionId) {
  const authPath = `${AUTH_BASE_DIR}/${sessionId}`;
  await fs.ensureDir(authPath);

  if (sessions.has(sessionId)) {
    console.log(`🔁 Reutilizando sessão existente: ${sessionId}`);
    return;
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      browser: Browsers.ubuntu("Chrome"),
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 30_000,
      emitOwnEvents: true,
      retryRequestDelayMs: 3000,
    });

    const session = {
      sock,
      saveCreds,
      qr: null,
      connected: false,
      fila: [],
      emAdicao: false,
      pararAdicao: false,
      totalAdicionados: 0,
      authPath,
      LOTE_TAMANHO: 5,
      INTERVALO_LOTES_MIN: [10, 12, 15],
      INTERVALO_MINILOTE_SEG: [20, 30, 60, 90, 120, 180],
    };

    sessions.set(sessionId, session);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      console.log("📡 [EVENTO] connection.update:", { connection, qr: !!qr });

      if (qr) {
        try {
          const qrImage = await QRCode.toDataURL(qr);
          session.qr = qrImage;
          session.connected = false;
          broadcast(sessionId, { type: "qr_code", qr: qrImage, sessionId });
          console.log(`📱 QR gerado para ${sessionId}. Acesse: ${BASE_URL}/qr/${sessionId}`);
        } catch (err) {
          console.error(`❌ Erro ao gerar QR:`, err.message);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`🔌 Fechado (${sessionId}):`, DisconnectReason[statusCode], statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("🧹 Limpando sessão por logout...");
          await fs.remove(authPath).catch(console.error);
          sessions.delete(sessionId);
          broadcast(sessionId, { type: "disconnected", reason: "logged_out", sessionId });
        } else {
          console.log("🔁 Reconectando em 5s...");
          broadcast(sessionId, { type: "disconnected", reason: "reconnecting", sessionId });
          setTimeout(() => {
            if (sessions.has(sessionId)) sessions.delete(sessionId);
            criarSessao(sessionId);
          }, 5000);
        }
      }

      if (connection === "open") {
        session.connected = true;
        session.qr = null;
        session.emAdicao = false;
        session.pararAdicao = false;

        console.log(`✅ ${sessionId} CONECTADO!`);
        console.log(`👤 Usuário: ${sock.user?.id || "Desconhecido"}`);

        broadcast(sessionId, {
          type: "connected",
          user: sock.user,
          totalAdicionados: session.totalAdicionados,
          sessionId,
        });

        setImmediate(() => processarFila(sessionId));
      }
    });
  } catch (err) {
    console.error(`❌ Erro ao criar sessão ${sessionId}:`, err.message);
    sessions.delete(sessionId);
    await fs.remove(authPath).catch(() => {});
  }
}

// 🚚 Processar fila
async function processarFila(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.emAdicao || !session.sock || session.pararAdicao || session.fila.length === 0) {
    return;
  }

  session.emAdicao = true;
  const lote = session.fila.splice(0, session.LOTE_TAMANHO);
  const groupId = lote[0].groupId;
  const numeros = lote.map((item) => item.number);
  const miniLotes = dividirEmLotes(numeros, Math.random() < 0.5 ? 2 : 3);

  broadcast(sessionId, { type: "batch_start", count: numeros.length, groupId, sessionId });

  let resultadosTotais = [];

  for (let i = 0; i < miniLotes.length; i++) {
    if (session.pararAdicao) break;

    const miniLote = miniLotes[i];
    const resultadosMini = [];

    for (const num of miniLote) {
      if (session.pararAdicao) break;

      broadcast(sessionId, { type: "adding_now", numberAtual: num, sessionId });

      try {
        const metadata = await session.sock.groupMetadata(groupId).catch(() => null);
        if (!metadata) {
          resultadosMini.push({ number: num, status: "erro ao buscar grupo" });
          continue;
        }

        const isAlready = metadata.participants.some((p) => p.id === `${num}@s.whatsapp.net`);
        if (isAlready) {
          resultadosMini.push({ number: num, status: "já está no grupo" });
          continue;
        }

        const response = await session.sock.groupParticipantsUpdate(
          groupId,
          [`${num}@s.whatsapp.net`],
          "add"
        );

        const result = response[0];
        if (result.status === 200) {
          resultadosMini.push({ number: num, status: "adicionado" });
          session.totalAdicionados++;
        } else {
          resultadosMini.push({ number: num, status: `erro ${result.status}` });
        }
      } catch (err) {
        resultadosMini.push({ number: num, status: "erro", error: err.message });
      }
    }

    resultadosTotais = resultadosTotais.concat(resultadosMini);

    if (i < miniLotes.length - 1 && !session.pararAdicao) {
      const intervaloSeg = aleatorio(session.INTERVALO_MINILOTE_SEG);
      await delay(intervaloSeg * 1000);
    }
  }

  const proximoLoteMin = aleatorio(session.INTERVALO_LOTES_MIN);
  const proximoLoteMs = proximoLoteMin * 60 * 1000;

  broadcast(sessionId, {
    type: "batch_done",
    lastBatchCount: numeros.length,
    nextAddInMs: proximoLoteMs,
    results: resultadosTotais,
    totalAdicionados: session.totalAdicionados,
    sessionId,
  });

  session.emAdicao = false;

  if (session.fila.length > 0 && !session.pararAdicao) {
    setTimeout(() => processarFila(sessionId), proximoLoteMs);
  } else if (session.pararAdicao) {
    broadcast(sessionId, { type: "stopped", sessionId });
  }
}

// 📡 Broadcast via WebSocket
function broadcast(sessionId, data) {
  const payload = JSON.stringify({ ...data, sessionId });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
      client.send(payload);
    }
  });
}

// 🌐 Rota: Listar sessões
app.get("/sessions", (req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    connected: s.connected,
    qr: !!s.qr,
    totalAdicionados: s.totalAdicionados,
    fila: s.fila.length,
    emAdicao: s.emAdicao,
  }));
  res.json(list);
});

// 🖼️ Nova rota: Obter QR em Base64
app.get("/api/qr-base64/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session?.qr) {
    const base64Data = session.qr.replace(/^data:image\/png;base64,/, "");
    return res.json({ base64: base64Data, sessionId });
  }
  return res.status(404).json({ error: "QR não disponível." });
});

// 📱 Página do QR
app.get("/qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return res.status(400).send("ID inválido.");
  }

  let session = sessions.get(sessionId);
  if (!session) {
    console.log(`🆕 Iniciando sessão: ${sessionId}`);
    await criarSessao(sessionId);
    session = sessions.get(sessionId);
  }

  if (session?.connected) {
    return res.send(`
      <html><body style="text-align:center;">
        <h3>✅ Conectado!</h3>
        <a href="/">Voltar</a>
      </body></html>
    `);
  }

  if (session?.qr) {
    res.send(`
      <html><body style="text-align:center;">
        <h3>📱 Escaneie o QR</h3>
        <img src="${session.qr}" width="250" />
        <p><button onclick="copy()">📋 Copiar Base64</button></p>
        <script>
          const base64 = \`${session.qr.replace("data:image/png;base64,", "")}\`;
          function copy() { navigator.clipboard.writeText(base64).then(() => alert("Copiado!")); }
        </script>
      </body></html>
    `);
  } else {
    res.send(`
      <html><body style="text-align:center;">
        <h3>⏳ Gerando QR...</h3>
        <div id="status">Aguardando conexão...</div>
        <script>
          function connect() {
            const ws = new WebSocket("wss://" + window.location.host + "/ws/${sessionId}");
            ws.onmessage = (e) => {
              const data = JSON.parse(e.data);
              if (data.qr) {
                document.getElementById("status").innerHTML = '<img src="' + data.qr + '" width="250" /><p><button onclick="copy()">📋 Copiar Base64</button></p>';
                window.qrBase64 = data.qr.replace("data:image/png;base64,", "");
              } else if (data.type === "connected") {
                document.body.innerHTML = "<h3>✅ Conectado!</h3><a href='/'>Voltar</a>";
              }
            };
            ws.onclose = () => setTimeout(connect, 3000);
          }
          function copy() {
            if (window.qrBase64) navigator.clipboard.writeText(window.qrBase64);
          }
          connect();
        </script>
      </body></html>
    `);
  }
});

// 🌐 WebSocket upgrade (CRUCIAL para Render)
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `https://${request.headers.host}`).pathname;
  const match = pathname.match(/\/ws\/([^\/]+)/);
  const sessionId = match ? match[1] : null;

  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.sessionId = sessionId;
    const session = sessions.get(sessionId);

    if (session?.qr) {
      ws.send(JSON.stringify({ type: "qr_code", qr: session.qr, sessionId }));
    } else if (session?.connected) {
      ws.send(JSON.stringify({ type: "connected", sessionId }));
    }

    ws.on("close", () => console.log(`🔌 WS fechado: ${sessionId}`));
  });
});

// 🏠 Página inicial
app.get("/", (req, res) => {
  res.send(`
    <html><body>
      <h1>🔐 Painel WhatsApp (Render)</h1>
      <button onclick="addSession()">➕ Nova Sessão</button>
      <div id="sessions"></div>
      <script>
        function addSession() {
          const id = prompt("ID da sessão:");
          if (id) location.href = '/qr/' + encodeURIComponent(id);
        }
        setInterval(() => fetch('/sessions').then(r => r.json()).then(s => {
          document.getElementById('sessions').innerHTML = s.map(x => 
            '<div style="border:1px solid #ccc; margin:10px; padding:10px;">' +
            x.sessionId + ' - ' + (x.connected ? '🟢' : '🔴') +
            ' | Adicionados: ' + x.totalAdicionados +
            ' | <a href="/qr/'+x.sessionId+'" target="_blank">QR</a>' +
            '</div>'
          ).join('');
        }), 3000);
      </script>
    </body></html>
  `);
});

// 🚀 Iniciar servidor
server.listen(PORT, async () => {
  await fs.ensureDir(AUTH_BASE_DIR);
  console.log(`🚀 Servidor rodando em ${BASE_URL}`);
  console.log(`👉 Acesse: ${BASE_URL}`);
});

// 🧹 Limpeza
process.on("SIGINT", () => {
  console.log("Encerrando...");
  wss.close();
  server.close(() => process.exit(0));
});
