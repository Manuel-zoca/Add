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
const AUTH_DIR = path.join(__dirname, "auth");
const DATA_DIR = path.join(__dirname, "data");

// 🧠 Estado Global (para múltiplas sessões)
const sessions = new Map(); // Map<sessionId, SessionData>

// Estrutura de cada sessão
class Session {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.sock = null;
    this.saveCreds = null;
    this.qrCode = null;
    this.connected = false;
    this.fila = [];
    this.emAdicao = false;
    this.emPausa = false;
    this.totalAdicionados = 0;
    this.totalJaExistem = 0;
    this.totalFalhas = 0;

    this.authPath = path.join(AUTH_DIR, `session-${sessionId}`);
    this.filaFile = path.join(DATA_DIR, `fila-${sessionId}.json`);
  }

  async loadFila() {
    await fs.ensureDir(DATA_DIR);
    if (await fs.pathExists(this.filaFile)) {
      try {
        this.fila = await fs.readJson(this.filaFile);
        console.log(`✅ [${this.sessionId}] Fila carregada: ${this.fila.length} números`);
      } catch (err) {
        console.error(`❌ [${this.sessionId}] Erro ao carregar fila:`, err);
        this.fila = [];
      }
    }
  }

  async saveFila() {
    try {
      await fs.ensureDir(DATA_DIR);
      await fs.writeJson(this.filaFile, this.fila, { spaces: 2 });
    } catch (err) {
      console.error(`❌ [${this.sessionId}] Erro ao salvar fila:`, err);
    }
  }

  broadcast(data) {
    broadcast({ sessionId: this.sessionId, ...data });
  }
}

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

// 🔧 Conectar WhatsApp (por sessão)
async function connectToWhatsApp(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.sock) return;

  try {
    await fs.ensureDir(session.authPath);
    const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(session.authPath);
    session.saveCreds = _saveCreds;

    const { version } = await fetchLatestBaileysVersion();

    session.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 30_000,
      emitOwnEvents: true,
    });

    session.sock.ev.on("creds.update", session.saveCreds);

    session.sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        try {
          session.qrCode = await QRCode.toDataURL(qr);
          session.connected = false;
          session.broadcast({ type: "qr", qr: session.qrCode });
        } catch (err) {
          console.error(`❌ [${sessionId}] Erro ao gerar QR:`, err);
        }
      }

      if (connection === "open") {
        session.connected = true;
        session.qrCode = null;
        console.log(`✅ [${sessionId}] WhatsApp conectado!`);
        session.broadcast({
          type: "connected",
          user: session.sock.user,
          stats: {
            totalAdicionados: session.totalAdicionados,
            totalJaExistem: session.totalJaExistem,
            totalFalhas: session.totalFalhas,
          },
          queue: session.fila.length,
          paused: session.emPausa,
        });

        if (session.fila.length > 0 && !session.emAdicao && !session.emPausa) {
          console.log(`🔄 [${sessionId}] Retomando processamento da fila...`);
          setTimeout(() => processarFila(sessionId), 1000);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`🔌 [${sessionId}] Desconectado:`, DisconnectReason[statusCode]);

        if (statusCode === DisconnectReason.loggedOut) {
          await fs.remove(session.authPath).catch(console.error);
          session.sock = null;
          session.broadcast({ type: "disconnected", reason: "logged_out" });
        } else {
          session.sock = null;
          session.broadcast({ type: "disconnected", reason: "reconnecting" });
          setTimeout(() => connectToWhatsApp(sessionId), 5000);
        }
      }
    });
  } catch (err) {
    console.error(`❌ [${sessionId}] Erro ao conectar:`, err);
    session.broadcast({ type: "error", message: "Falha ao iniciar: " + err.message });
  }
}

// 🚚 Processar fila com pausa segura (por sessão)
async function processarFila(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.emAdicao || !session.sock || session.fila.length === 0 || session.emPausa) return;

  // ✅ Limite diário para evitar banimento
  if (session.totalAdicionados >= 100) {
    session.broadcast({
      type: "daily_limit",
      message: "Limite diário de 100 contatos atingido. Reinicie amanhã.",
    });
    session.emAdicao = false;
    return;
  }

  session.emAdicao = true;

  // ✅ Aumentado para 15-30 minutos entre lotes
  const proximoLoteDelay = 60_000 * (15 + Math.random() * 15); // 15 a 30 minutos

  while (session.fila.length > 0) {
    if (session.emPausa || !session.connected) {
      session.emAdicao = false;
      session.broadcast({ type: "paused", message: "Processamento pausado pelo usuário." });
      return;
    }

    // ✅ Máximo 3 por vez
    const lote = session.fila.splice(0, Math.min(3, session.fila.length));
    const groupId = lote[0].groupId;

    session.broadcast({
      type: "batch_start",
      count: lote.length,
      message: `Iniciando lote de ${lote.length} números...`,
    });

    const miniLotes = criarMiniLotes(lote);

    for (const miniLote of miniLotes) {
      for (const item of miniLote.numeros) {
        if (session.emPausa || !session.connected) {
          session.emAdicao = false;
          session.broadcast({ type: "paused", message: "Pausado durante mini-lote." });
          return;
        }

        const num = item.number;
        try {
          const metadata = await session.sock.groupMetadata(groupId).catch(() => null);
          if (!metadata) throw new Error("Grupo não encontrado");

          const exists = metadata.participants.some((p) => p.id === `${num}@s.whatsapp.net`);
          if (exists) {
            session.totalJaExistem++;
            session.broadcast({
              type: "number",
              number: num,
              status: "exists",
              message: "Já no grupo",
            });
          } else {
            const res = await session.sock.groupParticipantsUpdate(
              groupId,
              [`${num}@s.whatsapp.net`],
              "add"
            );
            if (res[0]?.status === 200) {
              session.totalAdicionados++;
              session.broadcast({
                type: "number",
                number: num,
                status: "success",
                message: "Adicionado",
              });
            } else {
              session.totalFalhas++;
              session.broadcast({
                type: "number",
                number: num,
                status: "error",
                message: "Erro no envio",
              });
            }
          }
        } catch (err) {
          session.totalFalhas++;
          const message = err.message.includes("timeout")
            ? "Timeout ao adicionar"
            : err.message || "Erro desconhecido";
          session.broadcast({
            type: "number",
            number: num,
            status: "error",
            message,
          });
        }

        // ✅ Aumentado para 8-20 segundos entre adições
        const delay = 8000 + Math.random() * 12000;
        await new Promise((r) => setTimeout(r, delay));
      }

      if (miniLote.pausa) {
        const pausaMs = miniLote.pausa * 1000;
        session.broadcast({
          type: "mini_batch_pause",
          message: `Pausa de ${miniLote.pausa}s...`,
          pauseSeconds: miniLote.pausa,
        });

        for (let i = miniLote.pausa; i > 0; i--) {
          if (session.emPausa || !session.connected) {
            session.emAdicao = false;
            return;
          }
          session.broadcast({
            type: "countdown",
            seconds: i,
            message: `Próxima ação em ${i}s...`,
          });
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    await session.saveFila();

    // ✅ Simular atividade humana (leitura, navegação)
    session.broadcast({
      type: "simulating_activity",
      message: "Revisando grupo e mensagens... (simulado)",
    });
    await new Promise((r) => setTimeout(r, 12000 + Math.random() * 8000)); // 12-20s

    session.broadcast({
      type: "batch_done",
      stats: {
        totalAdicionados: session.totalAdicionados,
        totalJaExistem: session.totalJaExistem,
        totalFalhas: session.totalFalhas,
      },
      nextAddInMs: session.fila.length > 0 ? proximoLoteDelay : 0,
    });

    if (session.fila.length > 0 && !session.emPausa) {
      const totalSeconds = Math.floor(proximoLoteDelay / 1000);
      session.broadcast({
        type: "next_batch_countdown_start",
        message: `Próximo lote em ${totalSeconds}s...`,
        totalSeconds,
      });

      for (let i = totalSeconds; i > 0; i--) {
        if (session.emPausa || !session.connected) {
          session.emAdicao = false;
          return;
        }
        session.broadcast({ type: "countdown", seconds: i, message: `Próximo lote em ${i}s...` });
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else {
      break;
    }
  }

  session.emAdicao = false;
  session.broadcast({ type: "queue_completed" });
  await session.saveFila();
}

// 🔁 Cria mini-lotes com pausas humanizadas e aleatórias
function criarMiniLotes(numeros) {
  const lotes = [];

  if (numeros.length === 1) {
    lotes.push({ numeros: numeros, pausa: 0 });
  } else if (numeros.length === 2) {
    lotes.push({ numeros: [numeros[0]], pausa: 60 + Math.floor(Math.random() * 30) }); // 60-90s
    lotes.push({ numeros: [numeros[1]], pausa: 0 });
  } else if (numeros.length >= 3) {
    lotes.push({ numeros: [numeros[0]], pausa: 90 + Math.floor(Math.random() * 60) }); // 90-150s
    lotes.push({ numeros: [numeros[1]], pausa: 60 + Math.floor(Math.random() * 60) }); // 60-120s
    lotes.push({ numeros: [numeros[2]], pausa: 0 });
  }

  return lotes;
}

// 🌐 Rotas com sessionId
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Listar todas as sessões
app.get("/sessions", (req, res) => {
  const list = Array.from(sessions.keys());
  res.json({ sessions: list });
});

// Criar nova sessão
app.post("/session/create", (req, res) => {
  const { sessionId = `device-${Date.now()}` } = req.body;
  if (sessions.has(sessionId)) {
    return res.json({ success: false, error: "Sessão já existe." });
  }

  const session = new Session(sessionId);
  sessions.set(sessionId, session);
  session.loadFila();

  res.json({ success: true, sessionId });
});

// Conectar sessão
app.post("/session/:sessionId/connect", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

  await connectToWhatsApp(sessionId);
  res.json({ success: true });
});

// Adicionar números à fila de uma sessão
app.post("/session/:sessionId/add", async (req, res) => {
  const { sessionId } = req.params;
  const { groupId, numbers } = req.body;

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada" });
  if (!session.connected) return res.json({ error: "Não conectado" });

  // ✅ Filtro mais rigoroso: apenas números válidos (10-13 dígitos) e sem duplicados
  const validos = numbers
    .map((n) => n.toString().replace(/\D/g, ""))
    .filter((n) => n.length >= 10 && n.length <= 13)
    .filter((n, i, arr) => arr.indexOf(n) === i); // Remove duplicados

  validos.forEach((num) => session.fila.push({ groupId, number: num }));
  await session.saveFila();

  if (!session.emAdicao && !session.emPausa && session.totalAdicionados < 50) {
    processarFila(sessionId);
  }

  res.json({ success: true, total: validos.length });
});

// Pausar sessão
app.post("/session/:sessionId/pause", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

  if (session.emAdicao && !session.emPausa) {
    session.emPausa = true;
    session.broadcast({ type: "paused", message: "Processamento pausado." });
  }
  res.json({ success: true, paused: session.emPausa });
});

// Retomar sessão
app.post("/session/:sessionId/resume", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

  if (session.emPausa) {
    session.emPausa = false;
    session.broadcast({ type: "resumed", message: "Processamento retomado." });
    if (session.fila.length > 0 && !session.emAdicao && session.totalAdicionados < 50) {
      setImmediate(() => processarFila(sessionId));
    }
  }
  res.json({ success: true, paused: session.emPausa });
});

// Parar sessão (limpa fila)
app.post("/session/:sessionId/stop", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

  session.fila = [];
  session.emAdicao = false;
  session.emPausa = false;
  await session.saveFila();
  session.broadcast({ type: "stopped" });
  res.json({ success: true });
});

// Desconectar sessão (logout)
app.post("/session/:sessionId/logout", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

  if (session.sock) await session.sock.logout();
  session.sock = null;
  session.emAdicao = false;
  session.emPausa = false;
  await fs.remove(session.authPath).catch(console.error);
  await fs.remove(session.filaFile).catch(console.error);
  session.broadcast({ type: "disconnected", reason: "manual" });
  res.json({ success: true });
});

// WebSocket
server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/ws")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  for (const session of sessions.values()) {
    if (session.qrCode) {
      ws.send(JSON.stringify({ sessionId: session.sessionId, type: "qr", qr: session.qrCode }));
    }
    if (session.connected) {
      ws.send(
        JSON.stringify({
          sessionId: session.sessionId,
          type: "connected",
          user: session.sock?.user,
          stats: {
            totalAdicionados: session.totalAdicionados,
            totalJaExistem: session.totalJaExistem,
            totalFalhas: session.totalFalhas,
          },
          queue: session.fila.length,
          paused: session.emPausa,
        })
      );
    }
    ws.send(
      JSON.stringify({
        sessionId: session.sessionId,
        type: "queue_update",
        count: session.fila.length,
        stats: {
          totalAdicionados: session.totalAdicionados,
          totalJaExistem: session.totalJaExistem,
          totalFalhas: session.totalFalhas,
        },
        paused: session.emPausa,
      })
    );
  }
});

// 🚀 Iniciar servidor
async function startServer() {
  await fs.ensureDir(AUTH_DIR);
  await fs.ensureDir(DATA_DIR);

  const authDirs = await fs.readdir(AUTH_DIR);
  const filaFiles = await fs.readdir(DATA_DIR);

  const sessionIds = new Set();

  authDirs.forEach((dir) => {
    if (dir.startsWith("session-")) {
      const id = dir.replace("session-", "");
      sessionIds.add(id);
    }
  });

  filaFiles.forEach((file) => {
    if (file.startsWith("fila-") && file.endsWith(".json")) {
      const id = file.replace("fila-", "").replace(".json", "");
      sessionIds.add(id);
    }
  });

  for (const id of sessionIds) {
    const sessionId = `device-${id}`.replace("device-device-", "device-");
    const session = new Session(sessionId);
    sessions.set(sessionId, session);
    await session.loadFila();
    console.log(`🔁 [${sessionId}] Sessão recuperada.`);
  }

  server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`👉 Acesse: http://localhost:${PORT}`);
    console.log(`✅ Sessões carregadas: ${sessions.size}`);
  });
}

startServer();
