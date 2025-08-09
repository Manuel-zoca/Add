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

// Middleware
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// Pasta para autenticação por sessão
const AUTH_BASE_DIR = "./auth";

// Estado global: armazenar instâncias por sessão
const sessions = new Map(); // { sessionId: { sock, qr, connected, fila, emAdicao, ... } }

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

  let ultimoQRCodeBase64 = null;
  let connected = false;
  let emAdicao = false;
  let fila = [];
  let ultimoLote = 0;
  let totalAdicionados = 0;

  const LOTE_TAMANHO = 5;
  const INTERVALO_LOTES_MIN = [10, 12, 15];
  const INTERVALO_MINILOTE_SEG = [20, 30, 60, 90, 120, 180];

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        ultimoQRCodeBase64 = qrImage;
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
      } else {
        console.log(`🔄 ${sessionId}: Tentando reconectar...`);
        setTimeout(() => criarSessao(sessionId), 3000);
      }
      connected = false;
      broadcast(sessionId, { type: "disconnected", sessionId });
    } else if (connection === "open") {
      console.log(`✅ ${sessionId} conectado ao WhatsApp!`);
      connected = true;
      broadcast(sessionId, { type: "connected", sessionId });
      processarFila(sessionId);
    }
  });

  // Armazenar estado da sessão
  sessions.set(sessionId, {
    sock,
    saveCreds,
    qr: ultimoQRCodeBase64,
    connected,
    fila,
    emAdicao,
    ultimoLote,
    totalAdicionados,
    authPath,
    LOTE_TAMANHO,
    INTERVALO_LOTES_MIN,
    INTERVALO_MINILOTE_SEG,
  });

  return sock;
}

// Verificar se número já está no grupo
async function isMember(sock, groupId, number) {
  try {
    const groupInfo = await sock.groupMetadata(groupId);
    return groupInfo.participants.some((p) => p.id === number + "@s.whatsapp.net");
  } catch (err) {
    console.error("❌ Erro ao verificar participante:", err);
    return false;
  }
}

// Processar fila da sessão
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
        const isAlready = await isMember(session.sock, groupId, num);
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
        } else if (result.status === 403) {
          resultadosDoMini.push({ number: num, status: "sem permissão para adicionar" });
        } else if (result.status === 408) {
          resultadosDoMini.push({ number: num, status: "tempo esgotado" });
        } else {
          resultadosDoMini.push({ number: num, status: `erro ${result.status}` });
        }
      } catch (err) {
        console.error(`❌ Erro ao adicionar ${num} em ${sessionId}:`, err.message);
        resultadosDoMini.push({
          number: num,
          status: "erro",
          error: err.message,
        });
      }
    }

    resultadosMini = resultadosMini.concat(resultadosDoMini);

    broadcast(sessionId, {
      type: "mini_lote_concluido",
      lote: i + 1,
      totalMiniLotes: miniLotes.length,
      resultados: resultadosDoMini,
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

  console.log(`✅ ${sessionId}: Lote concluído. Total adicionados: ${session.totalAdicionados}`);
  broadcast(sessionId, {
    type: "batch_done",
    lastBatchCount: numeros.length,
    nextAddInMs: proximoLoteMs,
    results: resultadosMini,
    sessionId,
  });

  if (session.fila.length > 0) {
    console.log(`🕒 ${sessionId}: Próximo lote em ${proximoLoteMin} minutos...`);
    setTimeout(() => {
      session.emAdicao = false;
      processarFila(sessionId);
    }, proximoLoteMs);
  } else {
    session.emAdicao = false;
  }
}

// Adicionar à fila da sessão
function adicionarAFila(sessionId, groupId, numbers) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error(`❌ Sessão ${sessionId} não encontrada.`);
    return;
  }

  numbers.forEach((num) => session.fila.push({ groupId, number: num }));

  // Salvar fila em disco (opcional)
  fs.writeJson(`${session.authPath}/fila.json`, session.fila).catch(console.error);

  if (!session.emAdicao && session.connected) {
    processarFila(sessionId);
  }
}

// Broadcast para clientes da sessão
function broadcast(sessionId, data) {
  const json = JSON.stringify({ ...data, sessionId });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
      client.send(json);
    }
  });
}

// Rotas

// Rota dinâmica para QR: /qr/:sessionId
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

  const qrCode = session?.qr;

  if (qrCode) {
    res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>📱 Escaneie o QR Code - Conta: ${sessionId}</h3>
          <img src="${qrCode}" style="width: 250px; height: 250px;" />
          <p><small>Sessão: ${sessionId}</small></p>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>⏳ Aguardando geração do QR Code...</h3>
          <p>Conecte-se ao WhatsApp escaneando o QR.</p>
          <p><strong>Conta:</strong> ${sessionId}</p>
        </body>
      </html>
    `);
  }
});

// Adicionar números à sessão específica
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

  console.log(`📥 ${sessionId}: ${numbers.length} números adicionados à fila`);
  adicionarAFila(sessionId, groupId, numbers);

  res.json({
    success: true,
    message: `Processo iniciado. Números na fila: ${session.fila.length}`,
    sessionId,
  });
});

// Listar grupos da sessão
app.get("/grupos/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session || !session.connected) {
    return res.status(503).json({ error: "Não conectado ao WhatsApp." });
  }

  try {
    const chats = await session.sock.groupFetchAllParticipating();
    const grupos = Object.values(chats).map((g) => ({ id: g.id, nome: g.subject }));
    res.json({ grupos, sessionId });
  } catch (err) {
    console.error(`❌ Erro ao buscar grupos para ${sessionId}:`, err);
    res.status(500).json({ error: "Erro ao carregar grupos." });
  }
});

// Iniciar servidor
server.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  await fs.ensureDir(AUTH_BASE_DIR);

  // Restaurar sessões existentes (opcional)
  const pastas = await fs.readdir(AUTH_BASE_DIR);
  for (const pasta of pastas) {
    const path = `${AUTH_BASE_DIR}/${pasta}`;
    const stat = await fs.stat(path);
    if (stat.isDirectory()) {
      console.log(`🔁 Restaurando sessão: ${pasta}`);
      await criarSessao(pasta);
    }
  }
});

// WebSocket com rota por sessão
wss.on("connection", (ws, req) => {
  const pathname = req.url;
  const match = pathname.match(/\/ws\/([^\/]+)/);
  const sessionId = match ? match[1] : "default";

  ws.sessionId = sessionId;
  console.log(`🟢 Cliente conectado à sessão: ${sessionId}`);

  const session = sessions.get(sessionId);
  if (session?.qr) {
    ws.send(JSON.stringify({ type: "qr_code", qr: session.qr, sessionId }));
  }
  if (session?.connected) {
    ws.send(JSON.stringify({ type: "connected", sessionId }));
  }
});

