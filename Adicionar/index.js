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

// Pasta para autenticação por sessão
const AUTH_BASE_DIR = "./auth";

// Estado global
const sessions = new Map();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

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

  // Estado da sessão
  const session = {
    sock,
    saveCreds,
    qr: null,
    connected: false,
    fila: [],
    emAdicao: false,
    pararAdicao: false, // novo: flag para parar processamento
    ultimoLote: 0,
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
        console.log(`📱 QR Code gerado para ${sessionId}. Escaneie em /qr/${sessionId}`);
      } catch (err) {
        console.error(`❌ Erro ao gerar QR Code para ${sessionId}:`, err);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      session.connected = false;
      session.sock = null;

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`⛔ Sessão ${sessionId} encerrada (logout). Limpando...`);
        await fs.remove(authPath);
        sessions.delete(sessionId);
        broadcast(sessionId, { type: "disconnected", sessionId, loggedOut: true });
      } else {
        console.log(`🔄 ${sessionId}: Tentando reconectar...`);
        broadcast(sessionId, { type: "disconnected", sessionId });
        setTimeout(() => {
          if (sessions.has(sessionId)) {
            criarSessao(sessionId);
          }
        }, 3000);
      }
    } else if (connection === "open") {
      session.connected = true;
      session.qr = null;
      session.emAdicao = false;
      session.pararAdicao = false;
      console.log(`✅ ${sessionId} conectado ao WhatsApp!`);
      broadcast(sessionId, { type: "connected", sessionId, totalAdicionados: session.totalAdicionados });
      processarFila(sessionId);
    }
  });

  return sock;
}

// Processar fila (com controle de parada)
async function processarFila(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.emAdicao || !session.sock || session.fila.length === 0 || session.pararAdicao) return;

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
    if (session.pararAdicao) break;

    const miniLote = miniLotes[i];
    const resultadosDoMini = [];

    for (const num of miniLote) {
      if (session.pararAdicao) break;

      broadcast(sessionId, { type: "adding_now", numberAtual: num, sessionId });

      try {
        const isAlready = await session.sock.groupMetadata(groupId)
          .then(g => g.participants.some(p => p.id === num + "@s.whatsapp.net"))
          .catch(() => false);

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
        } else {
          resultadosDoMini.push({ number: num, status: `erro ${result.status}` });
        }
      } catch (err) {
        resultadosDoMini.push({ number: num, status: "erro", error: err.message });
      }
    }

    resultadosMini = resultadosMini.concat(resultadosDoMini);

    broadcast(sessionId, {
      type: "mini_lote_concluido",
      lote: i + 1,
      totalMiniLotes: miniLotes.length,
      resultados: resultadosMini,
      sessionId,
    });

    if (i < miniLotes.length - 1 && !session.pararAdicao) {
      const intervalo = aleatorio(session.INTERVALO_MINILOTE_SEG) * 1000;
      console.log(`⏳ ${sessionId}: Pausa de ${intervalo / 1000}s antes do próximo mini-lote...`);
      await delay(intervalo);
    }
  }

  broadcast(sessionId, {
    type: "batch_done",
    lastBatchCount: numeros.length,
    results: resultadosMini,
    totalAdicionados: session.totalAdicionados,
    sessionId,
  });

  session.emAdicao = false;

  if (session.fila.length > 0 && !session.pararAdicao) {
    const proximoLoteMin = aleatorio(session.INTERVALO_LOTES_MIN);
    const proximoLoteMs = proximoLoteMin * 60 * 1000;
    session.ultimoLote = Date.now();

    setTimeout(() => {
      processarFila(sessionId);
    }, proximoLoteMs);
  } else {
    session.emAdicao = false;
    if (session.pararAdicao) {
      broadcast(sessionId, { type: "stopped", sessionId });
      session.pararAdicao = false;
    }
  }
}

// Broadcast
function broadcast(sessionId, data) {
  const json = JSON.stringify({ ...data, sessionId });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
      client.send(json);
    }
  });
}

// Rota para listar todas as sessões
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

// Rota /qr/:sessionId — MOSTRA QR OU TEXTO BASE64
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

  if (session.connected) {
    return res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>✅ Conectado!</h3>
          <p>Conta <strong>${sessionId}</strong> já está logada.</p>
          <button onclick="location.href='/'">Voltar ao painel</button>
        </body>
      </html>
    `);
  }

  const qrCode = session.qr;

  if (qrCode) {
    res.send(`
      <html>
        <body style="text-align: center; font-family: sans-serif;">
          <h3>📱 Escaneie o QR Code - ${sessionId}</h3>
          <img src="${qrCode}" style="width: 250px; height: 250px;" />
          <p><small>Sessão: ${sessionId}</small></p>
          <button onclick="copyBase64()" style="margin-top:10px;">Copiar Base64</button>
          <script>
            function copyBase64() {
              navigator.clipboard.writeText('${qrCode}');
              alert("Base64 copiado!");
            }
          </script>
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
          <div id="qr-container"></div>
          <script>
            const ws = new WebSocket((window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host + "/ws/${sessionId}");
            ws.onmessage = (event) => {
              const data = JSON.parse(event.data);
              if (data.type === "qr_code" && data.qr) {
                document.getElementById('qr-container').innerHTML = \`
                  <h3>📱 Escaneie o QR Code</h3>
                  <img src="\${data.qr}" style="width: 250px; height: 250px;" />
                  <button onclick="copyBase64()">Copiar Base64</button>
                  <script>
                    function copyBase64() {
                      navigator.clipboard.writeText('\${data.qr}');
                      alert("Base64 copiado!");
                    }
                  <\/script>
                \`;
              }
            };
          </script>
        </body>
      </html>
    `);
  }
});

// Adicionar números
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
    return res.status(429).json({
      error: "Já há uma adição em andamento. Use /stop para interromper.",
    });
  }

  numbers.forEach((num) => session.fila.push({ groupId, number: num }));
  processarFila(sessionId);

  res.json({
    success: true,
    message: `Adição iniciada. ${numbers.length} números adicionados à fila.`,
    filaTotal: session.fila.length,
    sessionId,
  });
});

// Parar adição
app.post("/stop/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session) {
    session.pararAdicao = true;
    session.emAdicao = false;
    broadcast(sessionId, { type: "stopped", sessionId });
    return res.json({ success: true, message: "Adição interrompida." });
  }
  res.status(404).json({ error: "Sessão não encontrada." });
});

// Desconectar manualmente
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

// WebSocket
wss.on("connection", (ws, req) => {
  const pathname = req.url;
  const match = pathname.match(/\/ws\/([^\/]+)/);
  const sessionId = match ? match[1] : "default";

  ws.sessionId = sessionId;
  const session = sessions.get(sessionId);

  if (session) {
    if (session.qr) {
      ws.send(JSON.stringify({ type: "qr_code", qr: session.qr, sessionId }));
    }
    if (session.connected) {
      ws.send(JSON.stringify({ type: "connected", sessionId, totalAdicionados: session.totalAdicionados }));
    }
  }
});

// Rota principal (vai receber o HTML mais tarde)
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Gerenciador de Adição WhatsApp</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .session { border: 1px solid #ccc; margin: 10px 0; padding: 10px; border-radius: 8px; }
          .btn { margin: 5px; padding: 5px 10px; font-size: 0.9em; }
          .connected { color: green; }
          .disconnected { color: red; }
          pre { background: #f4f4f4; padding: 10px; border-radius: 4px; overflow: auto; }
        </style>
      </head>
      <body>
        <h1>🔐 Gerenciador de Sessões WhatsApp</h1>
        <button onclick="novaSessao()">+ Nova Sessão</button>
        <div id="sessions-list"></div>

        <script>
          let sessions = [];

          function refresh() {
            fetch('/sessions').then(r => r.json()).then(list => {
              sessions = list;
              render();
            });
          }

          function render() {
            const el = document.getElementById('sessions-list');
            el.innerHTML = sessions.map(s => \`
              <div class="session">
                <h3>\${s.sessionId} <span class="\${s.connected ? 'connected' : 'disconnected'}">\${s.connected ? '🟢 Conectado' : '🔴 Desconectado'}</span></h3>
                <p>Total adicionados: \${s.totalAdicionados}</p>
                <p>Fila: \${s.fila} números</p>
                <p>Status: \${s.emAdicao ? '🔄 Adicionando...' : (s.connected ? '✅ Pronto' : '📲 Aguardando QR')}</p>
                <a href="/qr/\${s.sessionId}" target="_blank"><button class="btn">QR / Conectar</button></a>
                <button class="btn" onclick="adicionarNumeros('\${s.sessionId}')">Adicionar Números</button>
                \${s.emAdicao ? 
                  '<button class="btn" onclick="pararAdicao(\''+s.sessionId+'\')">⏸ Parar</button>' : 
                  '<button class="btn" onclick="processarFila(\''+s.sessionId+'\')">▶️ Iniciar Fila</button>'
                }
                <button class="btn" onclick="desconectar('\${s.sessionId}')">❌ Desconectar</button>
              </div>
            \`).join('');
          }

          function novaSessao() {
            const id = prompt("ID da nova sessão (ex: conta1):");
            if (id) {
              fetch('/qr/' + encodeURIComponent(id));
              location.href = '/qr/' + encodeURIComponent(id);
            }
          }

          function adicionarNumeros(id) {
            const groupId = prompt("ID do grupo (ex: 1234567890@s.whatsapp.net):");
            const nums = prompt("Números separados por vírgula (sem @s.whatsapp.net):");
            if (groupId && nums) {
              fetch('/adicionar/' + id, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  groupId,
                  numbers: nums.split(',').map(n => n.trim()).filter(n => n)
                })
              }).then(r => r.json()).then(data => {
                alert(data.message || data.error);
                refresh();
              });
            }
          }

          function pararAdicao(id) {
            fetch('/stop/' + id, { method: 'POST' })
              .then(r => r.json())
              .then(() => refresh());
          }

          function desconectar(id) {
            if (confirm("Tem certeza que deseja desconectar e apagar a sessão?")) {
              fetch('/disconnect/' + id, { method: 'POST' })
                .then(r => r.json())
                .then(() => refresh());
            }
          }

          setInterval(refresh, 2000);
          refresh();
        </script>
      </body>
    </html>
  `);
});

// Iniciar servidor
server.listen(PORT, async () => {
  await fs.ensureDir(AUTH_BASE_DIR);
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`👉 Acesse http://localhost:${PORT} para gerenciar as sessões.`);
});
