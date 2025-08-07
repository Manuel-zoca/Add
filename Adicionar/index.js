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
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

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

async function connectToWhatsApp() {
  const authFolder = "./auth_info";
  fs.ensureDirSync(authFolder);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  sock = makeWASocket({
    auth: state,
    socketTimeoutMs: 150000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconectando...");
        await connectToWhatsApp();
      } else {
        console.log("⛔ Sessão encerrada.");
      }
    } else if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
    }

    if (qr) {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        ultimoQRCodeBase64 = qrImage;
        broadcast({ type: "qr_code", qr: qrImage });
      } catch (err) {
        console.error("❌ Erro ao gerar QR Code:", err);
      }
    }
  });

  return sock;
}

async function isMember(groupId, number) {
  const groupInfo = await sock.groupMetadata(groupId);
  return groupInfo.participants.some((p) => p.id === number + "@s.whatsapp.net");
}

async function processarFila() {
  if (emAdicao || fila.length === 0) return;

  emAdicao = true;

  const lote = fila.splice(0, LOTE_TAMANHO);
  await salvarFila();

  const groupId = lote[0].groupId;
  const numeros = lote.map((x) => x.number);
  const miniLotes = dividirEmLotes(numeros, Math.random() < 0.5 ? 2 : 3);

  console.log(`🚀 Iniciando lote com ${numeros.length} números para o grupo ${groupId}`);

  for (let i = 0; i < miniLotes.length; i++) {
    const miniLote = miniLotes[i];
    const resultadosMini = [];

    for (const num of miniLote) {
      broadcast({ type: "adding_now", numberAtual: num });
      try {
        const isAlready = await isMember(groupId, num);
        if (isAlready) {
          resultadosMini.push({ number: num, status: "já está no grupo" });
          continue;
        }

        const resp = await sock.groupParticipantsUpdate(
          groupId,
          [num + "@s.whatsapp.net"],
          "add"
        );

        const status = resp?.[0]?.status;
        if (status === 200 || status === 400) {
          resultadosMini.push({ number: num, status: "adicionado com sucesso" });
          totalAdicionados++;
        } else {
          resultadosMini.push({ number: num, status: "falha ao adicionar" });
        }
      } catch (err) {
        resultadosMini.push({ number: num, status: "erro", error: err.message });
      }
    }

    broadcast({
      type: "mini_lote_concluido",
      lote: i + 1,
      totalMiniLotes: miniLotes.length,
      resultados: resultadosMini,
    });

    if (i < miniLotes.length - 1) {
      const intervaloMini = aleatorio(INTERVALO_MINILOTE_SEG) * 1000;
      console.log(`⏳ Esperando ${intervaloMini / 1000}s para próximo mini-lote...`);
      await delay(intervaloMini);
    }
  }

  const intervaloProximoLoteMin = aleatorio(INTERVALO_LOTES_MIN);
  const intervaloProximoLoteMs = intervaloProximoLoteMin * 60 * 1000;
  ultimoLote = Date.now();

  console.log(`✅ Lote finalizado. Total adicionados hoje: ${totalAdicionados}`);

  broadcast({
    type: "batch_done",
    lastBatchCount: numeros.length,
    nextAddInMs: intervaloProximoLoteMs,
    results: miniLotes.flat().map((n) => ({ number: n, status: "finalizado" })),
  });

  if (fila.length > 0) {
    console.log(`🕒 Aguardando ${intervaloProximoLoteMin} min para próximo lote...`);
    setTimeout(() => {
      emAdicao = false;
      processarFila();
    }, intervaloProximoLoteMs);
  } else {
    emAdicao = false;
  }
}

function adicionarAFila(groupId, numbers) {
  numbers.forEach((num) => fila.push({ groupId, number: num }));
  salvarFila();
  processarFila();
}

function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

app.post("/adicionar", (req, res) => {
  const { groupId, numbers } = req.body;

  if (!groupId || !Array.isArray(numbers)) {
    return res.status(400).json({ error: "Dados inválidos." });
  }

  const agora = Date.now();
  const tempoRestante = Math.max(0, (ultimoLote + 5 * 60 * 1000) - agora);

  if (emAdicao && tempoRestante > 0) {
    return res.status(429).json({
      error: "Adição em andamento. Aguarde.",
      nextAddInSeconds: Math.ceil(tempoRestante / 1000),
    });
  }

  adicionarAFila(groupId, numbers);

  res.json({
    success: true,
    message: `Números adicionados à fila. Total: ${fila.length}`,
  });
});

app.get("/qr", (req, res) => {
  if (ultimoQRCodeBase64) {
    res.send(`
      <html>
        <body>
          <h2>Escaneie o QR Code abaixo:</h2>
          <img src="${ultimoQRCodeBase64}" />
        </body>
      </html>
    `);
  } else {
    res.send("QR Code ainda não gerado. Tente novamente em alguns segundos.");
  }
});

app.get("/grupos", async (req, res) => {
  try {
    const chats = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats).map((g) => ({ id: g.id, nome: g.subject }));
    res.json({ grupos });
  } catch (err) {
    console.error("❌ Erro ao buscar grupos:", err);
    res.status(500).json({ error: "Erro ao buscar grupos." });
  }
});

server.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  await carregarFila();
  await connectToWhatsApp();
  if (fila.length > 0) {
    console.log("♻️ Fila existente detectada, iniciando processamento...");
    processarFila();
  }
});
