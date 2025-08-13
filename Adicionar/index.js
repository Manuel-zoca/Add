// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const QRCode = require("qrcode");
const fs = require("fs-extra");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

// 🔌 Configurações
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth", "session");
const FILA_FILE = path.join(__dirname, "data", "fila.json");

// 🧠 Estado global
let sock = null;
let saveCreds = null;
let qrCode = null;
let connected = false;
let fila = [];
let emAdicao = false;
let totalAdicionados = 0;
let totalJaExistem = 0;
let totalFalhas = 0;

// 🛠️ Inicialização
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// 📡 Broadcast para todos os clientes
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// 🔁 Carregar fila salva
async function carregarFila() {
  await fs.ensureDir(path.dirname(FILA_FILE));
  if (await fs.pathExists(FILA_FILE)) {
    try {
      fila = await fs.readJson(FILA_FILE);
      console.log(`✅ Fila carregada: ${fila.length} números`);
      // ✅ Se houver fila e estiver conectado, inicie o processamento
      if (connected && fila.length > 0 && !emAdicao) {
        console.log("🔄 Retomando processamento da fila...");
        setImmediate(processarFila);
      }
    } catch (err) {
      console.error("❌ Erro ao carregar fila:", err);
    }
  }
}

// 💾 Salvar fila
async function salvarFila() {
  try {
    await fs.writeJson(FILA_FILE, fila, { spaces: 2 });
  } catch (err) {
    console.error("❌ Erro ao salvar fila:", err);
  }
}

// 🔧 Conectar WhatsApp
async function connectToWhatsApp() {
  if (sock) return;

  try {
    await fs.ensureDir(AUTH_DIR);
    const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    saveCreds = _saveCreds;

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 30_000,
      emitOwnEvents: true,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        try {
          qrCode = await QRCode.toDataURL(qr);
          connected = false;
          broadcast({ type: "qr", qr: qrCode });
        } catch (err) {
          console.error("❌ Erro ao gerar QR:", err);
        }
      }

      if (connection === "open") {
        connected = true;
        qrCode = null;
        emAdicao = false;
        console.log("✅ WhatsApp conectado!");
        broadcast({
          type: "connected",
          user: sock.user,
          stats: { totalAdicionados, totalJaExistem, totalFalhas },
        });
        // ✅ Após conectar, retoma a fila se houver
        if (fila.length > 0 && !emAdicao) {
          processarFila();
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log("🔌 Desconectado:", DisconnectReason[statusCode]);

        if (statusCode === DisconnectReason.loggedOut) {
          await fs.remove(path.join(__dirname, "auth")).catch(console.error);
          sock = null;
          broadcast({ type: "disconnected", reason: "logged_out" });
        } else {
          sock = null;
          broadcast({ type: "disconnected", reason: "reconnecting" });
          setTimeout(connectToWhatsApp, 5000);
        }
      }
    });
  } catch (err) {
    console.error("❌ Erro ao conectar:", err);
    broadcast({ type: "error", message: "Falha ao iniciar: " + err.message });
  }
}

// 🚚 Processar fila com comportamento humano realista
async function processarFila() {
  if (emAdicao || !sock || fila.length === 0) return;

  emAdicao = true;

  // ⏳ Intervalo entre lotes: 10 a 15 minutos
  const proximoLoteDelay = 60_000 * (10 + Math.random() * 5); // 10 a 15 min

  while (fila.length > 0) {
    const lote = fila.splice(0, 5);
    const groupId = lote[0].groupId;

    broadcast({
      type: "batch_start",
      count: lote.length,
      message: `Iniciando lote de ${lote.length} números...`,
    });

    const miniLotes = criarMiniLotes(lote);

    for (const miniLote of miniLotes) {
      for (const item of miniLote.numeros) {
        const num = item.number;
        try {
          const metadata = await sock.groupMetadata(groupId).catch(() => null);
          if (!metadata) throw new Error("Grupo não encontrado");

          const exists = metadata.participants.some((p) => p.id === `${num}@s.whatsapp.net`);
          if (exists) {
            totalJaExistem++;
            broadcast({ type: "number", number: num, status: "exists", message: "Já no grupo" });
          } else {
            const res = await sock.groupParticipantsUpdate(groupId, [`${num}@s.whatsapp.net`], "add");
            if (res[0]?.status === 200) {
              totalAdicionados++;
              broadcast({ type: "number", number: num, status: "success", message: "Adicionado" });
            } else {
              totalFalhas++;
              broadcast({ type: "number", number: num, status: "error", message: "Erro no envio" });
            }
          }
        } catch (err) {
          totalFalhas++;
          broadcast({
            type: "number",
            number: num,
            status: "error",
            message: err.message || "Erro desconhecido",
          });
        }

        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000));
      }

      if (miniLote.pausa) {
        const pausaMs = miniLote.pausa * 1000;
        broadcast({
          type: "mini_batch_pause",
          message: `Pausa de ${miniLote.pausa}s...`,
          pauseSeconds: miniLote.pausa,
        });

        for (let i = miniLote.pausa; i > 0; i--) {
          broadcast({ type: "countdown", seconds: i, message: `Próxima ação em ${i}s...` });
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    // ✅ Salva fila após cada lote (para sobreviver a reinícios)
    await salvarFila();

    broadcast({
      type: "batch_done",
      stats: { totalAdicionados, totalJaExistem, totalFalhas },
      nextAddInMs: fila.length > 0 ? proximoLoteDelay : 0,
    });

    if (fila.length > 0) {
      const totalSeconds = Math.floor(proximoLoteDelay / 1000);
      broadcast({
        type: "next_batch_countdown_start",
        message: `Próximo lote em ${totalSeconds}s...`,
        totalSeconds,
      });

      for (let i = totalSeconds; i > 0; i--) {
        broadcast({ type: "countdown", seconds: i, message: `Próximo lote em ${i}s...` });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  emAdicao = false;
  broadcast({ type: "queue_completed" });
  await salvarFila(); // Salva fila vazia
}

// 🔁 Cria mini-lotes com pausas humanizadas
function criarMiniLotes(numeros) {
  const total = numeros.length;
  const lotes = [];

  if (total === 5) {
    lotes.push({ numeros: numeros.slice(0, 2), pausa: 120 });
    lotes.push({ numeros: [numeros[2]], pausa: 60 });
    lotes.push({ numeros: [numeros[3]], pausa: 30 });
    lotes.push({ numeros: [numeros[4]], pausa: 0 });
  } else if (total === 4) {
    lotes.push({ numeros: numeros.slice(0, 2), pausa: 120 });
    lotes.push({ numeros: [numeros[2]], pausa: 60 });
    lotes.push({ numeros: [numeros[3]], pausa: 0 });
  } else if (total === 3) {
    lotes.push({ numeros: [numeros[0]], pausa: 60 });
    lotes.push({ numeros: [numeros[1]], pausa: 30 });
    lotes.push({ numeros: [numeros[2]], pausa: 0 });
  } else if (total === 2) {
    lotes.push({ numeros: [numeros[0]], pausa: 60 });
    lotes.push({ numeros: [numeros[1]], pausa: 0 });
  } else {
    lotes.push({ numeros, pausa: 0 });
  }

  return lotes;
}

// 🌐 Rotas
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/connect", async (req, res) => {
  await connectToWhatsApp();
  res.json({ success: true });
});

app.post("/add", async (req, res) => {
  const { groupId, numbers } = req.body;

  if (!connected) return res.json({ error: "Não conectado" });

  const validos = numbers
    .map((n) => n.toString().replace(/\D/g, ""))
    .filter((n) => n.length >= 8 && n.length <= 15);

  validos.forEach((num) => fila.push({ groupId, number: num }));
  await salvarFila();

  if (!emAdicao) processarFila();

  res.json({ success: true, total: validos.length });
});

app.post("/stop", async (req, res) => {
  fila = [];
  emAdicao = false;
  await salvarFila();
  broadcast({ type: "stopped" });
  res.json({ success: true });
});

app.post("/logout", async (req, res) => {
  if (sock) await sock.logout();
  sock = null;
  await fs.remove(path.join(__dirname, "auth")).catch(console.error);
  await fs.remove(FILA_FILE).catch(console.error);
  broadcast({ type: "disconnected", reason: "manual" });
  res.json({ success: true });
});

// 🌐 WebSocket
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  if (qrCode) ws.send(JSON.stringify({ type: "qr", qr: qrCode }));
  if (connected) {
    ws.send(
      JSON.stringify({
        type: "connected",
        user: sock?.user,
        stats: { totalAdicionados, totalJaExistem, totalFalhas },
      })
    );
  }
  // ✅ Envia estado atual da fila
  ws.send(JSON.stringify({ 
    type: "queue_update", 
    count: fila.length,
    stats: { totalAdicionados, totalJaExistem, totalFalhas }
  }));
});

// 🚀 Iniciar servidor
async function startServer() {
  await carregarFila(); // ✅ Carrega fila ao iniciar
  server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`👉 Acesse: http://localhost:${PORT}`);
  });

  // ✅ Reconecta automaticamente ao iniciar
  connectToWhatsApp();
}

startServer();
