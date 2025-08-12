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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// 🔌 Configurações
const PORT = process.env.PORT || 3000;
const AUTH_BASE_DIR = "./auth";
const BASE_URL = process.env.BASE_URL || `https://${process.env.RENDER_HOSTNAME}.onrender.com`; // Render

// 🧠 Sessões ativas
const sessions = new Map();

// 🛠️ Middleware
app.use(
  cors({
    origin: true, // Aceita qualquer origem (Render, localhost, etc)
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public")); // Para arquivos estáticos (opcional)

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
      authPath,
      LOTE_TAMANHO: 5,
      INTERVALO_LOTES_MIN: [10, 12, 15],
      INTERVALO_MINILOTE_SEG: [20, 30, 60, 90, 120, 180],
    };

    sessions.set(sessionId, session);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      console.log("[EVENTO] connection.update:", { connection, qr: !!qr });

      // 🖼️ QR Code gerado
      if (qr) {
        try {
          const qrImage = await QRCode.toDataURL(qr);
          session.qr = qrImage;
          session.connected = false;

          broadcast(sessionId, { type: "qr_code", qr: qrImage, sessionId });
          console.log(`📱 QR gerado para ${sessionId}`);
        } catch (err) {
          console.error(`❌ Erro ao gerar QR:`, err.message);
          broadcast(sessionId, {
            type: "error",
            message: "Erro ao gerar QR",
            sessionId,
          });
        }
      }

      // ✅ Conexão aberta
      if (connection === "open") {
        session.connected = true;
        session.qr = null;
        session.emAdicao = false;

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

      // 🔌 Conexão fechada
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`🔌 Fechado (${sessionId}):`, DisconnectReason[statusCode], statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("🧹 Sessão removida por logout.");
          await fs.remove(authPath).catch(console.error);
          sessions.delete(sessionId);
          broadcast(sessionId, { type: "disconnected", reason: "logged_out", sessionId });
        } else {
          console.log("🔁 Tentando reconectar...");
          broadcast(sessionId, { type: "disconnected", reason: "reconnecting", sessionId });
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
    broadcast(sessionId, { type: "error", message: "Falha ao iniciar", sessionId });
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
    session.pararAdicao = false;
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
  res.json(
    [...sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      connected: s.connected,
      qr: !!s.qr,
      totalAdicionados: s.totalAdicionados,
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

  // Aguardando QR
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
    broadcast(sessionId, { type: "stopped", sessionId });
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
      broadcast(sessionId, { type: "disconnected", sessionId, manual: true });
      return res.json({ success: true, message: "Desconectado com sucesso." });
    } catch (err) {
      console.error("Erro ao desconectar:", err);
    }
  }
  res.status(404).json({ error: "Sessão não encontrada." });
});

// 🌐 WebSocket upgrade (CRUCIAL para Render)
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
      ws.send(JSON.stringify({ type: "qr_code", qr: session.qr, sessionId }));
    } else if (session?.connected) {
      ws.send(JSON.stringify({ type: "connected", sessionId }));
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

// 🏠 Página inicial
app.get("/", (req, res) => {
  res.send(`
    <html><head><title>🔐 Painel WhatsApp</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f7f7f7; }
        .session { border: 1px solid #ddd; margin: 10px 0; padding: 15px; border-radius: 8px; background: white; }
        .btn { margin: 5px; padding: 8px 12px; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; }
        .btn-connect { background: #4CAF50; color: white; }
        .btn-add { background: #2196F3; color: white; }
        .btn-stop { background: #FF9800; color: white; }
        .btn-disconnect { background: #F44336; color: white; }
        .status { font-weight: bold; }
        .connected { color: green; }
        .disconnected { color: red; }
      </style>
    </head><body>
      <h1>🔐 Gerenciador WhatsApp (Render)</h1>
      <button onclick="novaSessao()">+ Nova Sessão</button>
      <div id="sessions"></div>

      <script>
        function refresh() {
          fetch('/sessions')
            .then(r => r.ok ? r.json() : Promise.reject('Erro HTTP: ' + r.status))
            .then(list => {
              document.getElementById('sessions').innerHTML = list.map(s => \`
                <div class="session">
                  <h3>\${s.sessionId} 
                    <span class="status \${s.connected ? 'connected' : 'disconnected'}">
                      \${s.connected ? '🟢 Conectado' : '🔴 Desconectado'}
                    </span>
                  </h3>
                  <p>Adicionados: \${s.totalAdicionados} | Fila: \${s.fila}</p>
                  <a href="/qr/\${s.sessionId}" target="_blank"><button class="btn btn-connect">QR</button></a>
                  <button class="btn btn-add" onclick="add('\${s.sessionId}')">Adicionar</button>
                  \${s.emAdicao ? '<button class="btn btn-stop" onclick="stop(\'' + s.sessionId + '\')">⏸ Parar</button>' : ''}
                  <button class="btn btn-disconnect" onclick="disconnect('\${s.sessionId}')">❌</button>
                </div>
              \`).join('');
            })
            .catch(err => {
              console.error("Erro ao carregar sessões:", err);
              document.getElementById('sessions').innerHTML = '<p style="color:red;">❌ Falha ao carregar sessões</p>';
            });
        }

        function novaSessao() {
          const id = prompt("ID da nova sessão:");
          if (id && /^[a-zA-Z0-9_-]+$/.test(id)) {
            location.href = '/qr/' + encodeURIComponent(id);
          } else if (id) {
            alert("ID inválido! Use letras, números, _ ou -");
          }
        }

        function add(id) {
          const g = prompt("ID do grupo:");
          const n = prompt("Números (separados por vírgula):");
          if (g && n) {
            fetch('/adicionar/' + id, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                groupId: g.trim(),
                numbers: n.split(',').map(x => x.trim()).filter(x => x)
              })
            })
            .then(r => r.json())
            .then(d => {
              alert(d.success ? d.message : "Erro: " + d.error);
            })
            .catch(err => {
              alert("Erro de conexão. Veja o console.");
              console.error(err);
            });
          }
        }

        function stop(id) {
          fetch('/stop/' + id, { method: 'POST' })
            .catch(console.error);
        }

        function disconnect(id) {
          if (confirm("Desconectar " + id + "?")) {
            fetch('/disconnect/' + id, { method: 'POST' })
              .catch(console.error);
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
