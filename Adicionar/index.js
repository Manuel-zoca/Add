// server.js
const express = require("express");
const fs = require("fs-extra");
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
const AUTH_DIR = "./auth/default"; // Pasta fixa
const BASE_URL = process.env.BASE_URL || `https://${process.env.RENDER_HOSTNAME}.onrender.com`;

// 🧠 Variáveis globais
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

// 📡 Enviar para todos os clientes WebSocket
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// 🔧 Conectar WhatsApp
async function connectWhatsApp() {
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
          console.log("📱 QR gerado");
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
          totalAdicionados,
          totalJaExistem,
          totalFalhas,
        });
        setImmediate(processarFila);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log("🔌 Desconectado:", DisconnectReason[statusCode]);

        if (statusCode === DisconnectReason.loggedOut) {
          await fs.remove(AUTH_DIR).catch(console.error);
          sock = null;
          broadcast({ type: "disconnected", reason: "logged_out" });
        } else {
          sock = null;
          broadcast({ type: "disconnected", reason: "reconnecting" });
          setTimeout(connectWhatsApp, 5000);
        }
      }
    });
  } catch (err) {
    console.error("❌ Erro ao conectar:", err);
    sock = null;
    broadcast({ type: "error", message: "Falha ao iniciar" });
  }
}

// 🚚 Processar fila
async function processarFila() {
  if (emAdicao || !sock || fila.length === 0) return;

  emAdicao = true;
  const lote = fila.splice(0, 5); // 5 por vez
  const groupId = lote[0].groupId;
  const numeros = lote.map((i) => i.number);

  broadcast({ type: "batch_start", count: numeros.length });

  for (const num of numeros) {
    try {
      const metadata = await sock.groupMetadata(groupId).catch(() => null);
      if (!metadata) throw new Error("Grupo não encontrado");

      const exists = metadata.participants.some((p) => p.id === `${num}@s.whatsapp.net`);
      if (exists) {
        totalJaExistem++;
        broadcast({ type: "number", number: num, status: "exists", message: "Já no grupo" });
        continue;
      }

      const res = await sock.groupParticipantsUpdate(groupId, [`${num}@s.whatsapp.net`], "add");
      if (res[0].status === 200) {
        totalAdicionados++;
        broadcast({ type: "number", number: num, status: "success", message: "Adicionado" });
      } else {
        totalFalhas++;
        broadcast({ type: "number", number: num, status: "error", message: "Erro " + res[0].status });
      }
    } catch (err) {
      totalFalhas++;
      broadcast({ type: "number", number: num, status: "error", message: err.message });
    }

    await new Promise((r) => setTimeout(r, 3000)); // 3s entre números
  }

  emAdicao = false;
  broadcast({
    type: "batch_done",
    totalAdicionados,
    totalJaExistem,
    totalFalhas,
  });

  if (fila.length > 0) {
    setTimeout(processarFila, 60_000); // 1 min entre lotes
  }
}

// 🌐 Rotas
app.get("/", (req, res) => {
  res.send(`
    <html><body style="text-align:center; font-family:Arial; padding:40px;">
      <h1>🔐 Adicionar ao Grupo WhatsApp</h1>
      <p><a href="/qr" class="btn">📱 Escanear QR Code</a></p>
      <div id="status" style="margin:20px; font-weight:bold;"></div>
      <div id="stats"></div>
      <textarea id="numbers" placeholder="258875078026, 27797393529" rows="4" style="width:80%; padding:10px; margin:10px 0;"></textarea>
      <input id="groupId" placeholder="ID do Grupo (ex: 1234567890@g.us)" style="width:80%; padding:10px; margin:10px 0;" />
      <button onclick="addNumbers()" style="padding:10px 20px; background:#4CAF50; color:white; border:none; cursor:pointer;">➕ Adicionar Números</button>
      <pre id="log" style="text-align:left; max-height:300px; overflow:auto; margin:20px; background:#f0f0f0; padding:10px;"></pre>

      <script>
        const ws = new WebSocket("wss://" + window.location.host + "/ws");
        let logText = "";

        function log(msg) {
          logText = msg + "\\n" + logText;
          document.getElementById("log").textContent = logText;
        }

        ws.onmessage = (e) => {
          const data = JSON.parse(e.data);
          const status = document.getElementById("status");
          const stats = document.getElementById("stats");

          if (data.type === "qr") {
            status.innerHTML = "<p>📱 Escaneie o QR abaixo</p>";
            stats.innerHTML = "";
          }

          if (data.type === "connected") {
            status.innerHTML = "<p style='color:green;'>✅ Conectado como " + (data.user?.name || "Você") + "</p>";
            stats.innerHTML = \`
              <p>✅ Adicionados: \${data.totalAdicionados}</p>
              <p>🔁 Já no grupo: \${data.totalJaExistem}</p>
              <p>❌ Falhas: \${data.totalFalhas}</p>
            \`;
          }

          if (data.type === "number") {
            log(data.number + " → " + data.message);
          }

          if (data.type === "batch_start") {
            log("📦 Lote iniciado: " + data.count + " números");
          }

          if (data.type === "batch_done") {
            stats.innerHTML = \`
              <p>✅ Adicionados: \${data.totalAdicionados}</p>
              <p>🔁 Já no grupo: \${data.totalJaExistem}</p>
              <p>❌ Falhas: \${data.totalFalhas}</p>
            \`;
          }
        };

        function addNumbers() {
          const numbers = document.getElementById("numbers").value
            .replace(/\\s/g, "")
            .split(",")
            .filter(n => n && /^\d+$/.test(n));

          const groupId = document.getElementById("groupId").value.trim();

          if (numbers.length === 0) return alert("Digite números válidos");
          if (!groupId) return alert("Digite o ID do grupo");

          fetch("/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId, numbers })
          });
          log("📤 Enviado " + numbers.length + " números para a fila");
        }
      </script>
    </body></html>
  `);
});

// 📱 Página do QR
app.get("/qr", async (req, res) => {
  if (!sock) await connectWhatsApp();

  res.send(`
    <html><body style="text-align:center; padding:40px; font-family:Arial;">
      <h2>📱 Escaneie o QR Code</h2>
      <div id="qr"></div>
      <p><a href="/">← Voltar</a></p>
      <script>
        function connect() {
          const ws = new WebSocket("wss://" + window.location.host + "/ws");
          ws.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.type === "qr" && data.qr) {
              document.getElementById("qr").innerHTML = "<img src='" + data.qr + "' width='250' />";
            } else if (data.type === "connected") {
              document.body.innerHTML = "<h2 style='color:green;'>✅ Conectado!</h2><p>O WhatsApp foi conectado com sucesso.</p><a href='/'>Voltar ao painel</a>";
            }
          };
          ws.onclose = () => setTimeout(connect, 3000);
        }
        connect();
      </script>
    </body></html>
  `);
});

// 📤 Adicionar números
app.post("/add", async (req, res) => {
  const { groupId, numbers } = req.body;

  if (!connected) return res.json({ error: "Não conectado" });

  const validos = numbers
    .map(n => n.toString().replace(/\D/g, ""))
    .filter(n => n.length >= 8 && n.length <= 15);

  validos.forEach(num => fila.push({ groupId, number: num }));
  if (!emAdicao) processarFila();

  res.json({ success: true });
});

// 🌐 WebSocket
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", () => {});
      if (qrCode) ws.send(JSON.stringify({ type: "qr", qr: qrCode }));
      if (connected) ws.send(JSON.stringify({ type: "connected" }));
    });
  } else {
    socket.destroy();
  }
});

// 🚀 Iniciar
server.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`👉 Acesse: http://localhost:${PORT}`);
});
