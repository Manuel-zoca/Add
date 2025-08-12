// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const QRCode = require("qrcode");
const fs = require("fs-extra");
const path = require("path");
const { randomBytes } = require("crypto");

const {
  default: makeWASocket,
  useSingleFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

// 🔌 Configurações
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth");
fs.ensureDirSync(AUTH_DIR);

// 🧠 Armazenamento em memória
const sessions = new Map(); // sessionId → { sock, state, saveCreds, qr, connected, ... }

// 🛠️ Inicialização
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public")); // Serve index.html de /public

// Gerar ID de sessão
function generateSessionId() {
  return "session_" + randomBytes(4).toString("hex");
}

// 📡 Broadcast para WebSocket da sessão
function broadcast(sessionId, data) {
  data.sessionId = sessionId;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
      client.send(JSON.stringify(data));
    }
  });
}

// 🔧 Criar sessão (sem recriar se já existe)
async function createSession(sessionId) {
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const authFile = path.join(AUTH_DIR, `${sessionId}.json`);
  const { state, saveCreds } = await useSingleFileAuthState(authFile);

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    emitOwnEvents: true,
  });

  const sessionData = {
    sessionId,
    sock,
    state,
    saveCreds,
    qr: null,
    connected: false,
    pendingNumbers: [],
    emAdicao: false,
    totalAdicionados: 0,
    totalJaExistem: 0,
    totalFalhas: 0,
  };

  sessions.set(sessionId, sessionData);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      try {
        const qrCodeUrl = await QRCode.toDataURL(qr);
        sessionData.qr = qrCodeUrl;
        sessionData.connected = false;
        broadcast(sessionId, { type: "qr_code", qr: qrCodeUrl });
      } catch (err) {
        console.error("❌ Erro ao gerar QR:", err);
      }
    }

    if (connection === "open") {
      sessionData.connected = true;
      sessionData.qr = null;
      sessionData.emAdicao = false;
      console.log(`✅ WhatsApp conectado: ${sessionId}`);
      broadcast(sessionId, {
        type: "connected",
        user: sock.user,
        totalAdicionados: sessionData.totalAdicionados,
        totalJaExistem: sessionData.totalJaExistem,
        totalFalhas: sessionData.totalFalhas,
      });
      processarFila(sessionId);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔌 Desconectado (${sessionId}):`, DisconnectReason[statusCode]);

      if (statusCode === DisconnectReason.loggedOut) {
        sessions.delete(sessionId);
        await fs.remove(authFile).catch(console.error);
        broadcast(sessionId, { type: "disconnected", reason: "logged_out" });
      } else {
        broadcast(sessionId, { type: "disconnected", reason: "reconnecting" });
        setTimeout(() => {
          if (sessions.has(sessionId)) {
            sessions.delete(sessionId);
          }
          createSession(sessionId);
        }, 5000);
      }
    }
  });

  return sessionData;
}

// 🚚 Processar fila
async function processarFila(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.emAdicao || session.pendingNumbers.length === 0) return;

  session.emAdicao = true;
  const lote = session.pendingNumbers.splice(0, 5);
  const groupId = lote[0].groupId;

  broadcast(sessionId, { type: "batch_start", count: lote.length });

  for (const item of lote) {
    const num = item.number;
    try {
      const metadata = await session.sock.groupMetadata(groupId).catch(() => null);
      if (!metadata) throw new Error("Grupo não encontrado");

      const exists = metadata.participants.some((p) => p.id === `${num}@s.whatsapp.net`);
      if (exists) {
        session.totalJaExistem++;
        broadcast(sessionId, { type: "number_processed", number: num, status: "ja_existe", message: "Já no grupo" });
        continue;
      }

      const res = await session.sock.groupParticipantsUpdate(groupId, [`${num}@s.whatsapp.net`], "add");
      if (res[0]?.status === 200) {
        session.totalAdicionados++;
        broadcast(sessionId, { type: "number_processed", number: num, status: "sucesso", message: "Adicionado" });
      } else {
        session.totalFalhas++;
        broadcast(sessionId, { type: "number_processed", number: num, status: "erro", message: `Erro ${res[0]?.status}` });
      }
    } catch (err) {
      session.totalFalhas++;
      broadcast(sessionId, { type: "number_processed", number: num, status: "erro", message: err.message });
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  session.emAdicao = false;

  const nextDelay = 60000;
  broadcast(sessionId, {
    type: "batch_done",
    nextAddInMs: session.pendingNumbers.length > 0 ? nextDelay : 0,
    totalAdicionados: session.totalAdicionados,
    totalJaExistem: session.totalJaExistem,
    totalFalhas: session.totalFalhas,
  });

  if (session.pendingNumbers.length > 0) {
    broadcast(sessionId, { type: "waiting_minilote", seconds: 60 });
    setTimeout(() => processarFila(sessionId), nextDelay);
  } else {
    broadcast(sessionId, { type: "queue_completed" });
  }
}

// 🌐 Rotas

// Listar sessões
app.get("/sessions", (req, res) => {
  const list = Array.from(sessions.entries()).map(([id, s]) => ({
    sessionId: id,
    connected: s.connected,
    user: s.sock?.user?.name || null,
  }));
  res.json(list);
});

// Criar nova sessão
app.post("/session", async (req, res) => {
  const sessionId = generateSessionId();
  await createSession(sessionId);
  res.json({ sessionId });
});

// Página do QR — ✅ Não recria sessão se já existe
app.get("/qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  // ✅ Garante que a sessão existe, mas não recria o socket
  if (!sessions.has(sessionId)) {
    await createSession(sessionId);
  }

  const session = sessions.get(sessionId);

  res.send(`
    <html>
    <body style="text-align:center; padding:40px; font-family:Arial;">
      <h2>📱 Escaneie o QR Code</h2>
      <div id="qr">${session.qr ? `<img src="${session.qr}" width="250" />` : "Gerando QR..."}</div>
      <p><a href="/">← Voltar</a></p>
      <script>
        function update() {
          const ws = new WebSocket("wss://" + window.location.host + "/ws/${sessionId}");
          ws.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.sessionId === "${sessionId}" && data.type === "qr_code" && data.qr) {
              document.getElementById("qr").innerHTML = "<img src='" + data.qr + "' width='250' />";
            } else if (data.type === "connected") {
              document.body.innerHTML = "<h2 style='color:green;'>✅ Conectado!</h2><p>O WhatsApp foi conectado com sucesso.</p><a href='/'>Voltar ao painel</a>";
            }
          };
          ws.onclose = () => setTimeout(update, 3000);
        }
        update();
      </script>
    </body>
    </html>
  `);
});

// Adicionar números
app.post("/adicionar/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { groupId, numbers } = req.body;

  const session = sessions.get(sessionId);
  if (!session) return res.json({ error: "Sessão não encontrada" });
  if (!session.connected) return res.json({ error: "Não conectado" });

  const validos = numbers
    .map((n) => n.toString().replace(/\D/g, ""))
    .filter((n) => n.length >= 8 && n.length <= 15);

  validos.forEach((num) => session.pendingNumbers.push({ groupId, number: num }));

  if (!session.emAdicao) processarFila(sessionId);

  res.json({ success: true, total: validos.length });
});

// Parar fila
app.post("/stop/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session) {
    session.pendingNumbers = [];
    session.emAdicao = false;
    broadcast(sessionId, { type: "stopped" });
  }
  res.json({ success: true });
});

// Desconectar
app.post("/disconnect/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session) {
    session.sock.logout();
    sessions.delete(sessionId);
    const authFile = path.join(AUTH_DIR, `${sessionId}.json`);
    await fs.remove(authFile).catch(console.error);
    broadcast(sessionId, { type: "disconnected" });
  }
  res.json({ success: true });
});

// Página principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 🌐 WebSocket por sessão
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;
  const match = pathname.match(/^\/ws\/(.+)$/);
  if (match) {
    const sessionId = match[1];
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.sessionId = sessionId;
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  const sessionId = ws.sessionId;
  const session = sessions.get(sessionId);
  if (session?.qr) {
    ws.send(JSON.stringify({ sessionId, type: "qr_code", qr: session.qr }));
  }
  if (session?.connected) {
    ws.send(JSON.stringify({ sessionId, type: "connected" }));
  }
});

// 🚀 Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`👉 Acesse: http://localhost:${PORT}`);
});
