// server.js
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

// 🔌 Configurações
const PORT = process.env.PORT || 3000;
const AUTH_BASE_DIR = "./auth";
const BASE_URL = process.env.BASE_URL || `https://${process.env.RENDER_HOSTNAME}.onrender.com`;

// 🧠 Sessões ativas
const sessions = new Map();

// 🛠️ Inicialização
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// 🧩 Funções auxiliares
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dividirEmLotes = (array, tamanho) => {
  const lotes = [];
  for (let i = 0; i < array.length; i += tamanho) {
    lotes.push(array.slice(i, i + tamanho));
  }
  return lotes;
};

const aleatorio = (lista) => lista[Math.floor(Math.random() * lista.length)];

// 📡 Broadcast via WebSocket com tipo e sessionId
function broadcast(sessionId, data) {
  const payload = JSON.stringify({ ...data, sessionId });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
      client.send(payload);
    }
  });
}

// 🔧 Criar sessão WhatsApp
async function criarSessao(sessionId) {
  const authPath = `${AUTH_BASE_DIR}/${sessionId}`;
  await fs.ensureDir(authPath);

  if (sessions.has(sessionId)) {
    console.log(`🔁 Sessão já ativa: ${sessionId}`);
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
      totalFalhas: 0,
      totalJaExistem: 0,
      authPath,
      LOTE_TAMANHO: 5,
      INTERVALO_LOTES_MIN: [10, 12, 15],
      INTERVALO_MINILOTE_SEG: [20, 30, 60, 90, 120, 180],
    };

    sessions.set(sessionId, session);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        try {
          const qrImage = await QRCode.toDataURL(qr);
          session.qr = qrImage;
          session.connected = false;

          broadcast(sessionId, {
            type: "qr_code",
            qr: qrImage,
            message: "Escaneie o QR para conectar.",
          });
          console.log(`📱 QR gerado para ${sessionId}`);
        } catch (err) {
          console.error(`❌ Erro ao gerar QR:`, err.message);
          broadcast(sessionId, {
            type: "error",
            message: "Erro ao gerar QR Code",
          });
        }
      }

      if (connection === "open") {
        session.connected = true;
        session.qr = null;
        session.emAdicao = false;

        console.log(`✅ ${sessionId} CONECTADO!`);
        broadcast(sessionId, {
          type: "connected",
          user: sock.user,
          totalAdicionados: session.totalAdicionados,
          totalJaExistem: session.totalJaExistem,
          totalFalhas: session.totalFalhas,
          message: "WhatsApp conectado com sucesso.",
        });

        setImmediate(() => processarFila(sessionId));
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`🔌 Fechado (${sessionId}):`, DisconnectReason[statusCode], statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("🧹 Sessão removida por logout.");
          await fs.remove(authPath).catch(console.error);
          sessions.delete(sessionId);
          broadcast(sessionId, {
            type: "disconnected",
            reason: "logged_out",
            message: "Sessão encerrada (logout).",
          });
        } else {
          console.log("🔁 Tentando reconectar...");
          broadcast(sessionId, {
            type: "disconnected",
            reason: "reconnecting",
            message: "Reconectando...",
          });
          setTimeout(() => {
            if (sessions.has(sessionId)) sessions.delete(sessionId);
            criarSessao(sessionId);
          }, 5000);
        }
      }
    });
  } catch (err) {
    console.error(`❌ Erro ao criar sessão ${sessionId}:`, err.message);
    sessions.delete(sessionId);
    await fs.remove(authPath).catch(() => {});
    broadcast(sessionId, {
      type: "error",
      message: "Falha ao iniciar sessão.",
    });
  }
}

// 🚚 Processar fila com detalhes em tempo real
async function processarFila(sessionId) {
  const session = sessions.get(sessionId);
  if (
    !session ||
    session.emAdicao ||
    !session.sock ||
    session.pararAdicao ||
    session.fila.length === 0
  ) {
    return;
  }

  session.emAdicao = true;
  const lote = session.fila.splice(0, session.LOTE_TAMANHO);
  const groupId = lote[0].groupId;
  const numeros = lote.map((item) => item.number);
  const miniLotes = dividirEmLotes(numeros, Math.random() < 0.5 ? 2 : 3);

  // 📊 Início do lote
  broadcast(sessionId, {
    type: "batch_start",
    count: numeros.length,
    groupId,
    message: `Iniciando lote de ${numeros.length} números...`,
  });

  let resultadosTotais = [];

  for (let i = 0; i < miniLotes.length; i++) {
    if (session.pararAdicao) break;

    const miniLote = miniLotes[i];
    const resultadosMini = [];

    // 📦 Início do mini-lote
    broadcast(sessionId, {
      type: "minilote_start",
      miniloteIndex: i + 1,
      totalMinilotes: miniLotes.length,
      numbers: miniLote,
      message: `Processando mini-lote ${i + 1}/${miniLotes.length}...`,
    });

    for (const num of miniLote) {
      if (session.pararAdicao) break;

      try {
        // Buscar metadata do grupo
        const metadata = await session.sock.groupMetadata(groupId).catch((err) => {
          console.error(`Erro ao buscar grupo ${groupId}:`, err.message);
          return null;
        });

        if (!metadata) {
          resultadosMini.push({
            number: num,
            status: "erro_grupo",
            message: "Erro ao buscar grupo.",
          });
          session.totalFalhas++;
          continue;
        }

        // Verificar se já está no grupo
        const isAlready = metadata.participants.some((p) => p.id === `${num}@s.whatsapp.net`);
        if (isAlready) {
          resultadosMini.push({
            number: num,
            status: "ja_existe",
            message: "Número já está no grupo.",
          });
          session.totalJaExistem++;
          continue;
        }

        // Tentar adicionar
        const response = await session.sock.groupParticipantsUpdate(
          groupId,
          [`${num}@s.whatsapp.net`],
          "add"
        );

        const result = response[0];
        if (result.status === 200) {
          resultadosMini.push({
            number: num,
            status: "sucesso",
            message: "Adicionado com sucesso.",
          });
          session.totalAdicionados++;
        } else {
          resultadosMini.push({
            number: num,
            status: "erro",
            message: `Erro HTTP ${result.status}`,
          });
          session.totalFalhas++;
        }
      } catch (err) {
        resultadosMini.push({
          number: num,
          status: "erro",
          message: err.message || "Erro desconhecido",
        });
        session.totalFalhas++;
      }

      // 🕒 Enviar status do número atual
      broadcast(sessionId, {
        type: "number_processed",
        number: num,
        status: resultadosMini[resultadosMini.length - 1].status,
        message: resultadosMini[resultadosMini.length - 1].message,
      });
    }

    resultadosTotais = resultadosTotais.concat(resultadosMini);

    // ⏳ Intervalo entre mini-lotes
    if (i < miniLotes.length - 1 && !session.pararAdicao) {
      const intervaloSeg = aleatorio(session.INTERVALO_MINILOTE_SEG);
      broadcast(sessionId, {
        type: "waiting_minilote",
        seconds: intervaloSeg,
        message: `Aguardando ${intervaloSeg}s antes do próximo mini-lote...`,
      });
      await delay(intervaloSeg * 1000);
    }
  }

  // 🕒 Calcular próximo lote
  const proximoLoteMin = aleatorio(session.INTERVALO_LOTES_MIN);
  const proximoLoteMs = proximoLoteMin * 60 * 1000;

  // 📊 Resultado do lote
  broadcast(sessionId, {
    type: "batch_done",
    results: resultadosTotais,
    lastBatchCount: numeros.length,
    nextAddInMs: proximoLoteMs,
    totalAdicionados: session.totalAdicionados,
    totalJaExistem: session.totalJaExistem,
    totalFalhas: session.totalFalhas,
    message: `Lote concluído. Próximo em ${proximoLoteMin} minutos.`,
  });

  session.emAdicao = false;

  if (session.fila.length > 0 && !session.pararAdicao) {
    // 🕒 Aguardar próximo lote
    broadcast(sessionId, {
      type: "next_batch_scheduled",
      delayMinutes: proximoLoteMin,
      remaining: session.fila.length,
      message: `Próximo lote agendado em ${proximoLoteMin} minutos.`,
    });

    setTimeout(() => processarFila(sessionId), proximoLoteMs);
  } else if (session.pararAdicao) {
    broadcast(sessionId, {
      type: "stopped",
      totalAdicionados: session.totalAdicionados,
      totalJaExistem: session.totalJaExistem,
      totalFalhas: session.totalFalhas,
      message: "Adição interrompida pelo usuário.",
    });
    session.pararAdicao = false;
  } else {
    // ✅ Fila concluída
    broadcast(sessionId, {
      type: "queue_completed",
      totalAdicionados: session.totalAdicionados,
      totalJaExistem: session.totalJaExistem,
      totalFalhas: session.totalFalhas,
      message: "Todos os números foram processados.",
    });
  }
}

// 🌐 Rota: Listar sessões
app.get("/sessions", (req, res) => {
  res.json(
    [...sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      connected: s.connected,
      qr: !!s.qr,
      totalAdicionados: s.totalAdicionados,
      totalJaExistem: s.totalJaExistem,
      totalFalhas: s.totalFalhas,
      fila: s.fila.length,
      emAdicao: s.emAdicao,
    }))
  );
});

// 🖼️ Rota: Obter QR em Base64
app.get("/api/qr-base64/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session?.qr) {
    const base64 = session.qr.replace("data:image/png;base64,", "");
    return res.json({ base64, sessionId });
  }
  res.status(404).json({ error: "QR não disponível." });
});

// 📱 Página do QR
app.get("/qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return res.status(400).send("❌ ID inválido.");
  }

  let session = sessions.get(sessionId);
  if (!session) {
    console.log(`🆕 Iniciando sessão: ${sessionId}`);
    await criarSessao(sessionId);
    session = sessions.get(sessionId);
  }

  if (session?.connected) {
    return res.send(`
      <html><body style="text-align:center; font-family:Arial;">
        <h3>✅ Conectado!</h3>
        <p><a href="/">Voltar</a></p>
      </body></html>
    `);
  }

  if (session?.qr) {
    return res.send(`
      <html><body style="text-align:center; font-family:Arial;">
        <h3>📱 Escaneie o QR</h3>
        <img src="${session.qr}" width="250" />
        <p><button onclick="copy()">📋 Copiar Base64</button></p>
        <script>
          const base64 = \`${session.qr.replace("data:image/png;base64,", "")}\`;
          function copy() { navigator.clipboard.writeText(base64).then(() => alert("Copiado!")); }
        </script>
      </body></html>
    `);
  }

  res.send(`
    <html><body style="text-align:center; font-family:Arial;">
      <h3>⏳ Gerando QR...</h3>
      <div id="qr"></div>
      <script>
        function connect() {
          const ws = new WebSocket("wss://" + window.location.host + "/ws/${sessionId}");
          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              if (data.type === "qr_code" && data.qr) {
                document.getElementById("qr").innerHTML = '<img src="' + data.qr + '" width="250" /><p><button onclick="copy()">📋 Copiar Base64</button></p>';
                window.qrBase64 = data.qr.replace("data:image/png;base64,", "");
              } else if (data.type === "connected") {
                document.body.innerHTML = "<h3>✅ Conectado!</h3><a href='/'>Voltar</a>";
              }
            } catch (err) {
              console.error("Erro ao processar mensagem WebSocket:", err);
            }
          };
          ws.onclose = () => setTimeout(connect, 3000);
          ws.onerror = (err) => console.error("WebSocket error:", err);
        }
        function copy() {
          if (window.qrBase64) navigator.clipboard.writeText(window.qrBase64).then(() => alert("Copiado!"));
        }
        connect();
      </script>
    </body></html>
  `);
});

// 📤 Adicionar números à fila
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
  if (!session) return res.status(404).json({ error: "Sessão não encontrada." });
  if (!session.connected) return res.status(400).json({ error: "WhatsApp não conectado." });
  if (session.emAdicao) return res.status(409).json({ error: "Adição em andamento. Use /stop primeiro." });

  const validos = numbers
    .map((n) => n.toString().replace(/\D/g, ""))
    .filter((n) => n.length >= 8 && n.length <= 15);

  if (validos.length === 0) {
    return res.status(400).json({ error: "Nenhum número válido fornecido." });
  }

  validos.forEach((num) => session.fila.push({ groupId, number: num }));
  processarFila(sessionId);

  res.json({
    success: true,
    message: `✅ ${validos.length} números adicionados à fila.`,
    filaTotal: session.fila.length,
    sessionId,
  });
});

// ⏸️ Parar adição
app.post("/stop/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session) {
    session.pararAdicao = true;
    broadcast(sessionId, { type: "stopped", message: "Adição interrompida." });
    return res.json({ success: true, message: "Adição interrompida." });
  }
  res.status(404).json({ error: "Sessão não encontrada." });
});

// 🔌 Desconectar
app.post("/disconnect/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session && session.sock) {
    try {
      await session.sock.logout();
      await fs.remove(session.authPath);
      sessions.delete(sessionId);
      broadcast(sessionId, { type: "disconnected", message: "Desconectado com sucesso." });
      return res.json({ success: true, message: "Desconectado com sucesso." });
    } catch (err) {
      console.error("Erro ao desconectar:", err);
    }
  }
  res.status(404).json({ error: "Sessão não encontrada." });
});

// 🌐 WebSocket upgrade (Render compatível)
server.on("upgrade", (request, socket, head) => {
  const { headers, url } = request;
  const protocol = headers["x-forwarded-proto"] || "https";
  const host = headers.host;
  const fullUrl = `${protocol}://${host}${url}`;

  let pathname;
  try {
    pathname = new URL(fullUrl).pathname;
  } catch (e) {
    socket.destroy();
    return;
  }

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
      ws.send(JSON.stringify({ type: "qr_code", qr: session.qr }));
    } else if (session?.connected) {
      ws.send(JSON.stringify({ type: "connected" }));
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      } catch (e) {}
    });

    ws.on("close", () => console.log(`🔌 WebSocket fechado: ${sessionId}`));
  });
});

// 🏠 Página inicial (HTML completo abaixo)
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html"); // Vamos criar este arquivo
});

// 🚀 Iniciar servidor
server.listen(PORT, async () => {
  await fs.ensureDir(AUTH_BASE_DIR);
  console.log(`🚀 Servidor rodando em ${BASE_URL}`);
  console.log(`👉 Acesse: ${BASE_URL}`);
  console.log(`📦 Pasta de sessões: ${AUTH_BASE_DIR}`);
});

// 🧹 Limpeza
process.on("SIGINT", () => {
  console.log("👋 Encerrando...");
  wss.close();
  server.close(() => process.exit(0));
});
