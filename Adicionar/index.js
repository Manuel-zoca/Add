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
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;
const AUTH_BASE_DIR = "./auth";

// 🧠 Mapa global de sessões ativas
const sessions = new Map();

// 🛠️ Middleware
app.use(
  cors({
    origin: (origin, callback) => callback(null, true),
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

// 🔄 Inicializa uma nova sessão WhatsApp
async function criarSessao(sessionId) {
  const authPath = `${AUTH_BASE_DIR}/${sessionId}`;
  await fs.ensureDir(authPath);

  if (sessions.has(sessionId)) {
    console.warn(`⚠️ Sessão ${sessionId} já existe. Reutilizando...`);
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
      browser: [sessionId, "Chrome", "120.0"],
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 30_000,
      emitOwnEvents: true,
      retryRequestDelayMs: 3000,
    });

    sock.ev.on("creds.update", saveCreds);

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

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        try {
          const qrImage = await QRCode.toDataURL(qr);
          session.qr = qrImage;
          session.connected = false;
          broadcast(sessionId, { type: "qr_code", qr: qrImage, sessionId });
          console.log(`📱 QR gerado para ${sessionId}. Escaneie em /qr/${sessionId}`);
        } catch (err) {
          console.error(`❌ Erro ao gerar QR para ${sessionId}:`, err.message);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        session.connected = false;
        session.sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`⛔ Sessão ${sessionId} encerrada (logout). Limpando...`);
          await fs.remove(authPath).catch(console.error);
          sessions.delete(sessionId);
          broadcast(sessionId, { type: "disconnected", sessionId, reason: "logged_out" });
        } else {
          console.log(`🔄 ${sessionId}: Tentando reconectar em 5s...`);
          broadcast(sessionId, { type: "disconnected", sessionId, reason: "reconnecting" });

          setTimeout(() => {
            if (sessions.has(sessionId)) {
              console.log(`🔁 Reiniciando sessão ${sessionId} após falha...`);
              criarSessao(sessionId);
            }
          }, 5000);
        }
      } else if (connection === "open") {
        session.connected = true;
        session.qr = null;
        session.emAdicao = false;
        session.pararAdicao = false;
        console.log(`✅ ${sessionId} conectado ao WhatsApp!`);
        broadcast(sessionId, {
          type: "connected",
          sessionId,
          totalAdicionados: session.totalAdicionados,
        });
        processarFila(sessionId);
      }
    });
  } catch (err) {
    console.error(`❌ Falha ao criar sessão ${sessionId}:`, err.message);
    sessions.delete(sessionId);
    await fs.remove(`${AUTH_BASE_DIR}/${sessionId}`).catch(() => {});
  }
}

// 🚚 Processa a fila de adição com pausas inteligentes
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

  console.log(`🚀 ${sessionId}: Iniciando lote com ${numeros.length} números no grupo ${groupId}`);
  broadcast(sessionId, {
    type: "batch_start",
    count: numeros.length,
    groupId,
    sessionId,
  });

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
          resultadosMini.push({ number: num, status: "adicionado com sucesso" });
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
      console.log(`⏳ ${sessionId}: Pausa de ${intervaloSeg}s antes do próximo mini-lote...`);
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
    setTimeout(() => {
      processarFila(sessionId);
    }, proximoLoteMs);
  } else {
    if (session.pararAdicao) {
      broadcast(sessionId, { type: "stopped", sessionId });
      session.pararAdicao = false;
    }
  }
}

// 📡 Envia dados via WebSocket
function broadcast(sessionId, data) {
  const payload = JSON.stringify({ ...data, sessionId });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
      client.send(payload);
    }
  });
}

// 🌐 Rota: Listar todas as sessões
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

// 📱 Rota: Exibir ou gerar QR
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

  if (session?.connected) {
    return res.send(`
      <html><body style="text-align:center;font-family:sans-serif;">
        <h3>✅ Conectado!</h3>
        <p>Conta <strong>${sessionId}</strong> já está logada.</p>
        <a href="/" style="color:#007bff;">Voltar ao painel</a>
      </body></html>
    `);
  }

  if (session?.qr) {
    res.send(`
      <html><body style="text-align:center;font-family:sans-serif;">
        <h3>📱 Escaneie o QR - ${sessionId}</h3>
        <img src="${session.qr}" width="250" height="250" />
        <p><small>Sessão: ${sessionId}</small></p>
      </body></html>
    `);
  } else {
    res.send(`
      <html><body style="text-align:center;font-family:sans-serif;">
        <h3>⏳ Aguardando QR...</h3>
        <p>Gerando código para ${sessionId}...</p>
        <div id="qr"></div>
        <script>
          const ws = new WebSocket((window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host + "/ws/${sessionId}");
          ws.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.type === "qr_code" && data.qr) {
              document.getElementById('qr').innerHTML = \`
                <img src="\${data.qr}" width="250" />
              \`;
            }
          };
        </script>
      </body></html>
    `);
  }
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
  if (!session) {
    return res.status(503).json({ error: "Sessão não encontrada." });
  }

  if (!session.connected) {
    return res.status(503).json({ error: "WhatsApp não conectado." });
  }

  if (session.emAdicao) {
    return res.status(429).json({
      error: "Adição em andamento. Use /stop para interromper.",
    });
  }

  const numerosValidos = numbers
    .map((n) => n.toString().replace(/\D/g, ""))
    .filter((n) => n.length >= 8 && n.length <= 15);

  if (numerosValidos.length === 0) {
    return res.status(400).json({ error: "Nenhum número válido fornecido." });
  }

  numerosValidos.forEach((num) => session.fila.push({ groupId, number: num }));
  processarFila(sessionId);

  res.json({
    success: true,
    message: `Processo iniciado. ${numerosValidos.length} números na fila.`,
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
    broadcast(sessionId, { type: "stopped", sessionId });
    return res.json({ success: true, message: "Adição interrompida." });
  }
  res.status(404).json({ error: "Sessão não encontrada." });
});

// 🔌 Desconectar conta
app.post("/disconnect/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session && session.sock) {
    try {
      await session.sock.logout();
      await fs.remove(session.authPath);
      sessions.delete(sessionId);
      broadcast(sessionId, { type: "disconnected", sessionId, manual: true });
      return res.json({ success: true, message: "Desconectado com sucesso." });
    } catch (err) {
      console.error("Erro ao desconectar:", err);
    }
  }
  res.status(404).json({ error: "Sessão não encontrada." });
});

// 🌐 WebSocket upgrade e conexão
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const match = pathname.match(/\/ws\/([^\/]+)/);
  const sessionId = match ? match[1] : null;

  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.sessionId = sessionId;
    const session = sessions.get(sessionId);

    if (session) {
      if (session.qr) {
        ws.send(JSON.stringify({ type: "qr_code", qr: session.qr, sessionId }));
      } else if (session.connected) {
        ws.send(JSON.stringify({
          type: "connected",
          sessionId,
          totalAdicionados: session.totalAdicionados,
        }));
      }
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch (e) {}
    });

    ws.on("close", () => {
      console.log(`🔌 WebSocket fechado para ${sessionId}`);
    });
  });
});

// 🏠 Página inicial - Painel de controle
app.get("/", (req, res) => {
  res.send(`
    <html><head><title>🔐 Painel WhatsApp</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .session { border: 1px solid #ddd; margin: 10px 0; padding: 15px; border-radius: 8px; }
        .btn { margin: 5px; padding: 8px 12px; border: none; border-radius: 5px; cursor: pointer; }
        .btn-connect { background: #4CAF50; color: white; }
        .btn-add { background: #2196F3; color: white; }
        .btn-stop { background: #FF9800; color: white; }
        .btn-disconnect { background: #F44336; color: white; }
        .status { font-weight: bold; }
        .connected { color: green; }
        .disconnected { color: red; }
      </style>
    </head><body>
      <h1>🔐 Gerenciador WhatsApp</h1>
      <button onclick="novaSessao()">+ Nova Sessão</button>
      <div id="sessions"></div>

      <script>
        function refresh() {
          fetch('/sessions').then(r => r.json()).then(list => {
            document.getElementById('sessions').innerHTML = list.map(s => \`
              <div class="session">
                <h3>\${s.sessionId} <span class="status \${s.connected ? 'connected' : 'disconnected'}">\${s.connected ? '🟢 Conectado' : '🔴 Desconectado'}</span></h3>
                <p>Adicionados: \${s.totalAdicionados} | Fila: \${s.fila}</p>
                <a href="/qr/\${s.sessionId}" target="_blank"><button class="btn btn-connect">QR</button></a>
                <button class="btn btn-add" onclick="add('\${s.sessionId}')">Adicionar</button>
                \${s.emAdicao ? 
                  '<button class="btn btn-stop" onclick="stop(\''+s.sessionId+'\')">⏸ Parar</button>' : 
                  ''
                }
                <button class="btn btn-disconnect" onclick="disconnect('\${s.sessionId}')">❌ Desconectar</button>
              </div>
            \`).join('');
          });
        }

        function novaSessao() {
          const id = prompt("ID da nova conta:");
          if (id && /^[a-zA-Z0-9_-]+$/.test(id)) location.href = '/qr/' + encodeURIComponent(id);
          else if (id) alert("ID inválido! Use letras, números, - ou _");
        }

        function add(id) {
          const g = prompt("ID do grupo:");
          const n = prompt("Números (separados por vírgula):");
          if (g && n) fetch('/adicionar/'+id, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              groupId: g.trim(),
              numbers: n.split(',').map(x => x.trim()).filter(x => x)
            })
          }).then(r => r.json()).then(d => {
            if (!d.success) alert("Erro: " + d.error);
            else alert(d.message);
          });
        }

        function stop(id) { 
          fetch('/stop/'+id, {method: 'POST'}).then(() => refresh()); 
        }

        function disconnect(id) { 
          if (confirm("Desconectar " + id + "?")) {
            fetch('/disconnect/'+id, {method: 'POST'}).then(() => refresh());
          }
        }

        setInterval(refresh, 3000);
        refresh();
      </script>
    </body></html>
  `);
});

// 🚀 Iniciar servidor
server.listen(PORT, async () => {
  await fs.ensureDir(AUTH_BASE_DIR);
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`👉 Acesse http://localhost:${PORT}`);
  console.log(`📦 Pasta de sessões: ${AUTH_BASE_DIR}`);
});

// 🧹 Limpeza ao encerrar
process.on("SIGINT", () => {
  console.log("\n👋 Encerrando servidor...");
  wss.close();
  server.close(() => {
    console.log("✅ Servidor encerrado.");
    process.exit(0);
  });
});
