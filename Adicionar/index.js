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

// ---------- Configurações ----------
const PORT = process.env.PORT || 3000;
const AUTH_BASE_DIR = "./auth";
const BASE_URL = process.env.BASE_URL || `https://${process.env.RENDER_HOSTNAME}.onrender.com`;

// ---------- Estado de sessões ----------
/**
 * sessions: Map<sessionId, {
 *   sock,
 *   saveCreds,
 *   qr,
 *   connected,
 *   fila: Array<{groupId, number}>,
 *   emAdicao,
 *   pararAdicao,
 *   totalAdicionados,
 *   authPath,
 *   LOTE_TAMANHO,
 *   INTERVALO_LOTES_MIN,
 *   INTERVALO_MINILOTE_SEG,
 *   currentProcessingInfo: { batchIndex, miniIndex, batchNumbers, startedAt, nextAddInMs }
 * }>
 */
const sessions = new Map();

// ---------- Utils ----------
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const dividirEmLotes = (array, tamanho) => {
  const lotes = [];
  for (let i = 0; i < array.length; i += tamanho) {
    lotes.push(array.slice(i, i + tamanho));
  }
  return lotes;
};

const aleatorio = (lista) => lista[Math.floor(Math.random() * lista.length)];

const isValidSessionId = (id) => !!id && /^[a-zA-Z0-9_-]+$/.test(id);

function broadcast(sessionId, data) {
  const payload = JSON.stringify({ ...data, sessionId });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
      client.send(payload);
    }
  });
}

function sendQueueUpdate(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  broadcast(sessionId, {
    type: "queue_update",
    filaLength: s.fila.length,
    totalAdicionados: s.totalAdicionados,
    emAdicao: s.emAdicao,
    currentProcessingInfo: s.currentProcessingInfo || null,
  });
}

// ---------- Criar sessão ----------
async function criarSessao(sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error("ID inválido");
  const authPath = `${AUTH_BASE_DIR}/${sessionId}`;
  await fs.ensureDir(authPath);

  if (sessions.has(sessionId)) {
    console.log(`Sessão já existe: ${sessionId}`);
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
      currentProcessingInfo: null,
    };

    sessions.set(sessionId, session);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;
      console.log(`[${sessionId}] connection.update:`, { connection, qr: !!qr });

      if (qr) {
        try {
          const qrImage = await QRCode.toDataURL(qr);
          session.qr = qrImage;
          session.connected = false;
          broadcast(sessionId, { type: "qr_code", qr: qrImage });
          sendQueueUpdate(sessionId);
        } catch (err) {
          console.error("Erro gerar QR:", err.message);
          broadcast(sessionId, { type: "error", message: "Erro ao gerar QR" });
        }
      }

      if (connection === "open") {
        session.connected = true;
        session.qr = null;
        session.emAdicao = false;
        console.log(`✅ ${sessionId} conectado. Usuário: ${sock.user?.id || "desconhecido"}`);
        broadcast(sessionId, {
          type: "connected",
          user: sock.user,
          totalAdicionados: session.totalAdicionados,
        });
        sendQueueUpdate(sessionId);
        setImmediate(() => processarFila(sessionId));
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[${sessionId}] fechado:`, statusCode, DisconnectReason[statusCode]);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[${sessionId}] logout detectado — removendo sessão.`);
          await fs.remove(authPath).catch(() => {});
          sessions.delete(sessionId);
          broadcast(sessionId, { type: "disconnected", reason: "logged_out" });
        } else {
          console.log(`[${sessionId}] tentando reconectar em 5s...`);
          broadcast(sessionId, { type: "disconnected", reason: "reconnecting" });
          // limpar e recriar sessão
          setTimeout(async () => {
            try {
              if (sessions.has(sessionId)) sessions.delete(sessionId);
              await criarSessao(sessionId);
            } catch (err) {
              console.error("Erro recriar sessão:", err);
            }
          }, 5000);
        }
      }
    });
  } catch (err) {
    console.error(`Erro criar sessão ${sessionId}:`, err.message || err);
    sessions.delete(sessionId);
    await fs.remove(authPath).catch(() => {});
    broadcast(sessionId, { type: "error", message: "Falha ao iniciar sessão" });
  }
}

// ---------- Endpoints ----------
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// Rota listar sessões
app.get("/sessions", (req, res) => {
  res.json(
    [...sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      connected: s.connected,
      qr: !!s.qr,
      totalAdicionados: s.totalAdicionados,
      fila: s.fila.length,
      emAdicao: s.emAdicao,
      currentProcessingInfo: s.currentProcessingInfo,
    }))
  );
});

// Rota obter qr base64
app.get("/api/qr-base64/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session?.qr) {
    const base64 = session.qr.replace("data:image/png;base64,", "");
    return res.json({ base64 });
  }
  res.status(404).json({ error: "QR não disponível." });
});

// Página QR (simples)
app.get("/qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) return res.status(400).send("ID inválido.");

  let session = sessions.get(sessionId);
  if (!session) {
    await criarSessao(sessionId);
    session = sessions.get(sessionId);
  }

  if (session?.connected) {
    return res.send(`<html><body style="text-align:center;"><h3>✅ Conectado!</h3><p><a href="/">Voltar</a></p></body></html>`);
  }
  // se tem qr, exibe, senão aguarda via WS
  const qrHtml = session?.qr
    ? `<img src="${session.qr}" width="250" />`
    : `<div id="qr">⏳ Aguardando QR via WebSocket...</div>`;

  res.send(`
    <html>
      <body style="text-align:center; font-family:Arial">
        <h3>📱 Escaneie o QR</h3>
        ${qrHtml}
        <script>
          (function(){
            const ws = new WebSocket("wss://" + window.location.host + "/ws/${sessionId}");
            ws.onmessage = (e) => {
              const d = JSON.parse(e.data);
              if (d.type === 'qr_code' && d.qr) {
                document.getElementById('qr').innerHTML = '<img src="' + d.qr + '" width="250" />';
              } else if (d.type === 'connected') {
                document.body.innerHTML = '<h3>✅ Conectado!</h3><p><a href="/">Voltar</a></p>';
              }
            };
            ws.onclose = () => setTimeout(() => location.reload(), 3000);
            ws.onerror = (err) => console.error(err);
          })();
        </script>
      </body>
    </html>
  `);
});

/**
 * POST /adicionar/:sessionId
 * body: { groupId: string, numbers: string[] }
 *
 * Funcionalidade adicional:
 * - ao adicionar, checa imediatamente o grupo e retorna quais números JÁ estão no grupo
 * - adiciona apenas os válidos à fila
 * - broadcast de queue_update
 */
app.post("/adicionar/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { groupId, numbers } = req.body;

  if (!isValidSessionId(sessionId)) return res.status(400).json({ error: "ID de sessão inválido." });
  if (!groupId || !Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: "Grupo ou números inválidos." });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada." });
  if (!session.connected) return res.status(400).json({ error: "WhatsApp não conectado." });

  // normaliza números
  const cleaned = numbers.map((n) => n.toString().replace(/\D/g, "")).filter((n) => n.length >= 8 && n.length <= 15);
  if (cleaned.length === 0) return res.status(400).json({ error: "Nenhum número válido fornecido." });

  // Tentar pegar metadata do grupo para checagem imediata
  let metadata = null;
  try {
    metadata = await session.sock.groupMetadata(groupId).catch(() => null);
  } catch (err) {
    metadata = null;
  }

  const jaNoGrupo = [];
  const paraAdicionar = [];

  if (metadata) {
    const participantsSet = new Set((metadata.participants || []).map((p) => p.id));
    cleaned.forEach((num) => {
      const jid = `${num}@s.whatsapp.net`;
      if (participantsSet.has(jid)) {
        jaNoGrupo.push(num);
      } else {
        paraAdicionar.push(num);
      }
    });
  } else {
    // se não conseguiu metadata, assume que todos serão adicionados e será tratado no processamento
    paraAdicionar.push(...cleaned);
  }

  // coloca na fila os que faltam
  paraAdicionar.forEach((num) => session.fila.push({ groupId, number: num }));

  // broadcast imediato com detalhes
  broadcast(sessionId, {
    type: "add_result",
    addedToQueue: paraAdicionar.length,
    alreadyInGroup: jaNoGrupo,
    filaTotal: session.fila.length,
  });

  sendQueueUpdate(sessionId);

  // inicia processamento se possível
  setImmediate(() => processarFila(sessionId));

  res.json({
    success: true,
    message: `✅ ${paraAdicionar.length} números adicionados à fila. ${jaNoGrupo.length > 0 ? `${jaNoGrupo.length} já estavam no grupo.` : ""}`,
    addedToQueue: paraAdicionar.length,
    alreadyInGroup: jaNoGrupo,
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
    broadcast(sessionId, { type: "stopping" });
    return res.json({ success: true, message: "Adição interrompida (aguardando parada segura)." });
  }
  res.status(404).json({ error: "Sessão não encontrada." });
});

// Disconnect / logout
app.post("/disconnect/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (session && session.sock) {
    try {
      await session.sock.logout();
      await fs.remove(session.authPath).catch(() => {});
      sessions.delete(sessionId);
      broadcast(sessionId, { type: "disconnected", manual: true });
      return res.json({ success: true, message: "Desconectado com sucesso." });
    } catch (err) {
      console.error("Erro ao desconectar:", err);
      return res.status(500).json({ error: "Erro ao desconectar." });
    }
  }
  res.status(404).json({ error: "Sessão não encontrada." });
});

// Página inicial (simples dashboard)
app.get("/", (req, res) => {
  res.send(`
    <html><head><title>Gerenciador WhatsApp</title></head><body style="font-family:Arial; margin:20px;">
      <h1>Gerenciador WhatsApp</h1>
      <p>Acesse as rotas /sessions e /qr/:sessionId. Envie POST /adicionar/:sessionId para adicionar números.</p>
    </body></html>
  `);
});

// ---------- Processamento de fila (principal) ----------
/**
 * Lógica:
 * - Se já emAdicao: não dispara outra vez
 * - Pega o próximo lote (session.LOTE_TAMANHO)
 * - Divide em mini-lotes (2 ou 3)
 * - Para cada mini-lote:
 *    - para cada número: tenta buscar metadata (se falhar, registra erro)
 *    - checa se já está no grupo -> marca e não tenta adicionar
 *    - tenta groupParticipantsUpdate para os que precisam ser adicionados (um por um para melhor controle)
 *    - registra resultados por número
 *    - espera INTERVALO_MINILOTE_SEG aleatório entre mini-lotes
 * - depois do lote inteiro, calcula proximoLoteMs (aleatório INTERVALO_LOTES_MIN em minutos), broadcast com nextAddInMs
 * - se houver mais na fila agenda processarFila novamente após nextAddInMs
 */
async function processarFila(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.emAdicao) return;
  if (session.pararAdicao) {
    // se estava marcado para parar, limpa a flag
    session.pararAdicao = false;
    broadcast(sessionId, { type: "stopped" });
    sendQueueUpdate(sessionId);
    return;
  }
  if (!session.connected) return;
  if (session.fila.length === 0) {
    sendQueueUpdate(sessionId);
    return;
  }

  session.emAdicao = true;

  try {
    // pegar lote
    const lote = session.fila.splice(0, session.LOTE_TAMANHO);
    const groupId = lote[0]?.groupId;
    const numeros = lote.map((i) => i.number);

    // dividir em mini-lotes 2 ou 3
    const miniSize = Math.random() < 0.5 ? 2 : 3;
    const miniLotes = dividirEmLotes(numeros, miniSize);

    session.currentProcessingInfo = {
      batchNumbers: numeros,
      batchSize: numeros.length,
      batchStartedAt: Date.now(),
      batchIndex: 0,
      miniIndex: 0,
    };

    broadcast(sessionId, { type: "batch_start", count: numeros.length, groupId });

    let resultadosTotais = [];

    for (let i = 0; i < miniLotes.length; i++) {
      if (session.pararAdicao) break;
      const mini = miniLotes[i];
      session.currentProcessingInfo.miniIndex = i;
      session.currentProcessingInfo.batchIndex = i;
      session.currentProcessingInfo.currentMini = mini;

      broadcast(sessionId, {
        type: "mini_start",
        miniIndex: i,
        miniCount: mini.length,
        miniNumbers: mini,
      });

      const resultadosMini = [];

      // buscar metadata uma vez por mini-lote (mais eficiente)
      let metadata = null;
      try {
        metadata = await session.sock.groupMetadata(groupId).catch(() => null);
      } catch (err) {
        metadata = null;
      }
      const participantsSet = metadata ? new Set((metadata.participants || []).map((p) => p.id)) : null;

      for (const num of mini) {
        if (session.pararAdicao) break;
        broadcast(sessionId, { type: "adding_now", numberAtual: num });

        try {
          if (participantsSet && participantsSet.has(`${num}@s.whatsapp.net`)) {
            resultadosMini.push({ number: num, status: "já está no grupo" });
            broadcast(sessionId, { type: "progress", detail: `${num} já no grupo` });
            continue;
          }

          // tentar adicionar (um por um para capturar retorno)
          const response = await session.sock.groupParticipantsUpdate(groupId, [`${num}@s.whatsapp.net`], "add").catch((e) => ({ error: e }));
          // dependendo da versão do baileys, a resposta pode variar. tratamos com cautela:
          if (response && Array.isArray(response)) {
            const r = response[0];
            if (r.status === 200 || r.status === "200") {
              resultadosMini.push({ number: num, status: "adicionado com sucesso" });
              session.totalAdicionados++;
              broadcast(sessionId, { type: "progress", detail: `${num} adicionado` });
            } else {
              resultadosMini.push({ number: num, status: `erro ${r.status || "?"}`, raw: r });
              broadcast(sessionId, { type: "progress", detail: `${num} erro ${r.status || "?"}` });
            }
          } else if (response && response.error) {
            resultadosMini.push({ number: num, status: "erro", error: (response.error && response.error.message) || String(response.error) });
            broadcast(sessionId, { type: "progress", detail: `${num} erro ao adicionar` });
          } else {
            // caso não seja array
            resultadosMini.push({ number: num, status: "resultado inesperado", raw: response });
            broadcast(sessionId, { type: "progress", detail: `${num} resultado inesperado` });
          }
        } catch (err) {
          resultadosMini.push({ number: num, status: "erro", error: err?.message || String(err) });
          broadcast(sessionId, { type: "progress", detail: `${num} erro catch` });
        }

        // atualizar fila e estado em tempo real
        sendQueueUpdate(sessionId);
      } // fim números mini-lote

      resultadosTotais = resultadosTotais.concat(resultadosMini);

      // broadcast com resultados do mini-lote
      broadcast(sessionId, {
        type: "mini_done",
        miniIndex: i,
        results: resultadosMini,
        totalSoFar: resultadosTotais.length,
      });

      // se não for o último mini-lote e não foi pedido parar, aguarda INTERVALO_MINILOTE_SEG
      if (i < miniLotes.length - 1 && !session.pararAdicao) {
        const intervaloSeg = aleatorio(session.INTERVALO_MINILOTE_SEG);
        broadcast(sessionId, { type: "mini_wait", waitSeconds: intervaloSeg });
        // guardamos para frontend calcular contador
        session.currentProcessingInfo.nextMiniWaitMs = intervaloSeg * 1000;
        await delay(intervaloSeg * 1000);
      }
    } // fim mini-lotes

    // ao terminar o lote
    const proximoLoteMin = aleatorio(session.INTERVALO_LOTES_MIN);
    const proximoLoteMs = proximoLoteMin * 60 * 1000;

    broadcast(sessionId, {
      type: "batch_done",
      lastBatchCount: numeros.length,
      nextAddInMs: proximoLoteMs,
      results: resultadosTotais,
      totalAdicionados: session.totalAdicionados,
    });

    session.currentProcessingInfo = {
      ...session.currentProcessingInfo,
      lastResults: resultadosTotais,
      nextAddInMs: proximoLoteMs,
      batchFinishedAt: Date.now(),
    };

    // reset emAdicao e agendar próximo lote se houver mais items
    session.emAdicao = false;

    if (session.pararAdicao) {
      // usuário solicitou parada durante execução
      broadcast(sessionId, { type: "stopped" });
      session.pararAdicao = false;
      sendQueueUpdate(sessionId);
      return;
    }

    if (session.fila.length > 0) {
      // schedule next lote
      broadcast(sessionId, { type: "batch_timer", nextInMs: proximoLoteMs });
      // manter a informação para frontend (para mostrar contagem regressiva se quiser)
      session.currentProcessingInfo.nextAddInMs = proximoLoteMs;

      setTimeout(() => {
        // proteção: só processar se a sessão existir e não estiver em adição
        if (sessions.has(sessionId) && !session.emAdicao) {
          processarFila(sessionId).catch((e) => {
            console.error("processarFila erro agendado:", e);
            broadcast(sessionId, { type: "error", message: "Erro ao processar fila (agendado)" });
          });
        }
      }, proximoLoteMs);
    } else {
      // fim da fila
      sendQueueUpdate(sessionId);
      broadcast(sessionId, { type: "idle", message: "Fila vazia" });
    }
  } catch (err) {
    console.error("Erro em processarFila:", err);
    broadcast(sessionId, { type: "error", message: "Erro interno ao processar fila", detail: err?.message || String(err) });
    session.emAdicao = false;
  } finally {
    // garantir que emAdicao seja resetado
    if (session && session.emAdicao) session.emAdicao = false;
    sendQueueUpdate(sessionId);
  }
}

// ---------- WebSocket upgrade (Render friendly) ----------
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
  if (!isValidSessionId(sessionId)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.sessionId = sessionId;
    const session = sessions.get(sessionId);

    // Enviar estado inicial
    if (session?.qr) {
      ws.send(JSON.stringify({ type: "qr_code", qr: session.qr }));
    } else if (session?.connected) {
      ws.send(JSON.stringify({ type: "connected" }));
    } else {
      ws.send(JSON.stringify({ type: "created" }));
    }

    // Enviar snapshot de fila
    ws.send(JSON.stringify({
      type: "snapshot",
      filaLength: session?.fila.length || 0,
      totalAdicionados: session?.totalAdicionados || 0,
      emAdicao: session?.emAdicao || false,
      currentProcessingInfo: session?.currentProcessingInfo || null,
    }));

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        // outros comandos via WS podem ser adicionados aqui
      } catch (e) {}
    });

    ws.on("close", () => console.log(`WS fechado: ${sessionId}`));
  });
});

// -------- Iniciar servidor --------
server.listen(PORT, async () => {
  await fs.ensureDir(AUTH_BASE_DIR);
  console.log(`🚀 Servidor rodando em ${BASE_URL}`);
  console.log(`📦 Pasta de sessões: ${AUTH_BASE_DIR}`);
});

// limpeza
process.on("SIGINT", () => {
  console.log("Encerrando...");
  wss.close();
  server.close(() => process.exit(0));
});
