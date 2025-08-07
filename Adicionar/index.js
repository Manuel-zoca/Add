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

// Estado global
let sock;
let ultimoQRCodeBase64 = null;
const FILA_PATH = "./fila.json";
let fila = [];
let emAdicao = false;
let ultimoLote = 0;
let totalAdicionados = 0;
const LOTE_TAMANHO = 5;
const INTERVALO_LOTES_MIN = [10, 12, 15];
const INTERVALO_MINILOTE_SEG = [20, 30, 60, 90, 120, 180];

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

async function salvarFila() {
  try {
    await fs.writeJson(FILA_PATH, fila);
  } catch (err) {
    console.error("❌ Erro ao salvar fila:", err);
  }
}

async function carregarFila() {
  try {
    const existe = await fs.pathExists(FILA_PATH);
    fila = existe ? await fs.readJson(FILA_PATH) : [];
  } catch (err) {
    console.error("❌ Erro ao carregar fila:", err);
    fila = [];
  }
}

// Conexão com WhatsApp
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    browser: ["Render WhatsApp Bot", "Safari", "3.0"],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    emitOwnEvents: true,
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        ultimoQRCodeBase64 = qrImage;
        broadcast({ type: "qr_code", qr: qrImage });
        console.log("📱 QR Code gerado. Escaneie em /qr");
      } catch (err) {
        console.error("❌ Erro ao gerar QR Code:", err);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("⛔ Sessão encerrada. Limpe 'auth_info' para reautenticar.");
        fs.removeSync("./auth_info");
      } else {
        console.log("🔄 Tentando reconectar...");
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      broadcast({ type: "connected" });
      processarFila();
    }
  });

  return sock;
}

// Verificar se número já está no grupo
async function isMember(groupId, number) {
  try {
    const groupInfo = await sock.groupMetadata(groupId);
    return groupInfo.participants.some((p) => p.id === number + "@s.whatsapp.net");
  } catch (err) {
    console.error("❌ Erro ao verificar participante:", err);
    return false;
  }
}

// Processar fila
async function processarFila() {
  if (emAdicao || !sock || fila.length === 0) return;

  emAdicao = true;
  const lote = fila.splice(0, LOTE_TAMANHO);
  await salvarFila();

  const groupId = lote[0].groupId;
  const numeros = lote.map((x) => x.number);
  const miniLotes = dividirEmLotes(numeros, Math.random() < 0.5 ? 2 : 3);

  console.log(`🚀 Iniciando lote com ${numeros.length} números para o grupo ${groupId}`);
  broadcast({
    type: "batch_start",
    count: numeros.length,
    groupId,
  });

  // ✅ Declaração correta de resultadosMini
  let resultadosMini = [];

  for (let i = 0; i < miniLotes.length; i++) {
    const miniLote = miniLotes[i];
    const resultadosDoMini = []; // ✅ Variável corrigida

    for (const num of miniLote) {
      broadcast({ type: "adding_now", numberAtual: num });

      try {
        const isAlready = await isMember(groupId, num);
        if (isAlready) {
          resultadosDoMini.push({ number: num, status: "já está no grupo" });
          continue;
        }

        const response = await sock.groupParticipantsUpdate(
          groupId,
          [num + "@s.whatsapp.net"],
          "add"
        );

        const result = response[0];
        if (result.status === 200) {
          resultadosDoMini.push({ number: num, status: "adicionado com sucesso" });
          totalAdicionados++;
        } else if (result.status === 403) {
          resultadosDoMini.push({ number: num, status: "sem permissão para adicionar" });
        } else if (result.status === 408) {
          resultadosDoMini.push({ number: num, status: "tempo esgotado" });
        } else {
          resultadosDoMini.push({ number: num, status: `erro ${result.status}` });
        }
      } catch (err) {
        console.error("❌ Erro ao adicionar", num, ":", err.message);
        resultadosDoMini.push({
          number: num,
          status: "erro",
          error: err.message,
        });
      }
    }

    // ✅ Atualiza resultadosMini
    resultadosMini = resultadosMini.concat(resultadosDoMini);

    broadcast({
      type: "mini_lote_concluido",
      lote: i + 1,
      totalMiniLotes: miniLotes.length,
      resultados: resultadosDoMini,
    });

    if (i < miniLotes.length - 1) {
      const intervalo = aleatorio(INTERVALO_MINILOTE_SEG) * 1000;
      console.log(`⏳ Pausa de ${intervalo / 1000}s antes do próximo mini-lote...`);
      await delay(intervalo);
    }
  }

  const proximoLoteMin = aleatorio(INTERVALO_LOTES_MIN);
  const proximoLoteMs = proximoLoteMin * 60 * 1000;
  ultimoLote = Date.now();

  console.log(`✅ Lote concluído. Total adicionados: ${totalAdicionados}`);
  broadcast({
    type: "batch_done",
    lastBatchCount: numeros.length,
    nextAddInMs: proximoLoteMs,
    results: resultadosMini, // ✅ Agora está definido
  });

  if (fila.length > 0) {
    console.log(`🕒 Próximo lote em ${proximoLoteMin} minutos...`);
    setTimeout(() => {
      emAdicao = false;
      processarFila();
    }, proximoLoteMs);
  } else {
    emAdicao = false;
  }
}

// Adicionar à fila
function adicionarAFila(groupId, numbers) {
  numbers.forEach((num) => fila.push({ groupId, number: num }));
  salvarFila();
  processarFila();
}

// Broadcast para todos os clientes
function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

// Rotas
app.post("/adicionar", async (req, res) => {
  const { groupId, numbers } = req.body;

  if (!groupId || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "Grupo ou números inválidos." });
  }

  if (!sock) {
    return res.status(503).json({ error: "WhatsApp não conectado. Aguarde o QR." });
  }

  if (emAdicao) {
    const tempoRestante = Math.max(0, (ultimoLote + 5 * 60 * 1000) - Date.now());
    return res.status(429).json({
      error: "Adição em andamento. Aguarde.",
      nextAddInSeconds: Math.ceil(tempoRestante / 1000),
    });
  }

  console.log("📥 Números adicionados à fila:", numbers);
  adicionarAFila(groupId, numbers);

  res.json({
    success: true,
    message: `Processo iniciado. Números na fila: ${fila.length}`,
  });
});

app.get("/qr", (req, res) => {
  if (ultimoQRCodeBase64) {
    res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>📱 Escaneie o QR Code</h3>
          <img src="${ultimoQRCodeBase64}" style="width: 250px; height: 250px;" />
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>⏳ Aguardando geração do QR Code...</h3>
          <p>Conecte-se ao WhatsApp escaneando o QR.</p>
        </body>
      </html>
    `);
  }
});

app.get("/grupos", async (req, res) => {
  if (!sock) {
    return res.status(503).json({ error: "Não conectado ao WhatsApp." });
  }
  try {
    const chats = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats).map((g) => ({ id: g.id, nome: g.subject }));
    res.json({ grupos });
  } catch (err) {
    console.error("❌ Erro ao buscar grupos:", err);
    res.status(500).json({ error: "Erro ao carregar grupos." });
  }
});

// Iniciar servidor
server.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  await carregarFila();
  await connectToWhatsApp();

  if (fila.length > 0) {
    console.log(`♻️ Fila carregada com ${fila.length} números. Iniciando...`);
    processarFila();
  }
});

// WebSocket
wss.on("connection", (ws) => {
  console.log("🟢 Cliente WebSocket conectado");
  if (ultimoQRCodeBase64) {
    ws.send(JSON.stringify({ type: "qr_code", qr: ultimoQRCodeBase64 }));
  }
  if (sock?.user) {
    ws.send(JSON.stringify({ type: "connected" }));
  }
});
