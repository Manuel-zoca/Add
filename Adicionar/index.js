// server.js (versão aprimorada contra overlimit/rate-limit)
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

/* =========================
   🔧 Configurações gerais
   ========================= */
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth", "session");
const FILA_FILE = path.join(__dirname, "data", "fila.json");
const STATE_FILE = path.join(__dirname, "data", "state.json");

// Limites e pacing (ajustáveis sem reiniciar, pois carregamos do STATE_FILE)
const DEFAULT_PACING = {
  // Processa blocos de até 5, mas a cadência interna é inteligente
  loteMax: 5,
  // Espera entre cada número (ms) — com jitter
  minWaitMs: 2500,
  maxWaitMs: 5000,
  // Pausas “humanizadas” entre mini-lotes (seg)
  pausasPadrao: {
    "5": [120, 60, 30, 0], // para 5 números: [após 2, após +1, após +1, final]
    "4": [120, 60, 0],     // para 4 números
    "3": [60, 30, 0],      // para 3
    "2": [60, 0],          // para 2
    "1": [0],              // para 1
  },
  // Intervalo entre lotes (ms) — base (10 a 15 min)
  proximoLoteMinMs: 10 * 60_000,
  proximoLoteMaxMs: 15 * 60_000,
  // Backoff quando detectar rate-limit
  backoff: {
    enabled: true,
    // aumenta o pacing quando falhas seguidas ≥ este valor
    thresholdFalhasSeguidas: 3,
    multiplicadorMinMaxWait: 1.8,   // aumenta espera entre números
    multiplicadorProxLote: 2.0,     // empurra o próximo lote
    // pausa longa quando muitos erros de rate-limit acontecerem
    pausaLongaMinutos: 25,          // segura se “doeu” muito
  },
  // Repetições (retry) por número quando erro temporário (rate-limit, timeout)
  retriesTemporarios: 2,
  retryBaseDelayMs: 20_000, // 20s, com jitter
};

// Códigos de status que indicam erros temporários (podem voltar a funcionar)
const TEMP_ERRORS = new Set([408, 429, 500, 502, 503, 504]); // + genéricos

/* =========================
   🧠 Estado global
   ========================= */
let sock = null;
let saveCreds = null;
let qrCode = null;
let connected = false;

let fila = []; // { groupId, number, retries? }
let emAdicao = false;
let isPaused = false;

let totalAdicionados = 0;
let totalJaExistem = 0;
let totalFalhas = 0;
let falhasSeguidas = 0;

let pacing = { ...DEFAULT_PACING };

// cancel token para interromper esperas sem travar
let cancelToken = { cancelled: false };

// cache simples de participantes por grupo (evita buscar metadados a cada número)
const participantesCache = new Map(); // groupId -> Set(jids)

/* =========================
   🛠️ App/Server/WSS
   ========================= */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

/* =========================
   📡 Broadcast
   ========================= */
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

/* =========================
   💾 Persistência
   ========================= */
async function carregarFila() {
  await fs.ensureDir(path.dirname(FILA_FILE));
  if (await fs.pathExists(FILA_FILE)) {
    try {
      const lida = await fs.readJson(FILA_FILE);
      // Sanitiza
      fila = Array.isArray(lida) ? lida.filter(Boolean) : [];
      console.log(`✅ Fila carregada: ${fila.length} números`);
    } catch (err) {
      console.error("❌ Erro ao carregar fila:", err);
    }
  }
}

async function salvarFila() {
  try {
    await fs.ensureDir(path.dirname(FILA_FILE));
    await fs.writeJson(FILA_FILE, fila, { spaces: 2 });
  } catch (err) {
    console.error("❌ Erro ao salvar fila:", err);
  }
}

async function carregarState() {
  try {
    await fs.ensureDir(path.dirname(STATE_FILE));
    if (await fs.pathExists(STATE_FILE)) {
      const s = await fs.readJson(STATE_FILE);
      if (s?.pacing) pacing = { ...DEFAULT_PACING, ...s.pacing };
      if (typeof s?.isPaused === "boolean") isPaused = s.isPaused;
    }
  } catch (e) {
    console.warn("⚠️ Não foi possível ler state.json, usando defaults.");
  }
}

async function salvarState() {
  try {
    await fs.ensureDir(path.dirname(STATE_FILE));
    await fs.writeJson(
      STATE_FILE,
      {
        pacing,
        isPaused,
        stats: { totalAdicionados, totalJaExistem, totalFalhas, falhasSeguidas },
        filaCount: fila.length,
      },
      { spaces: 2 }
    );
  } catch (e) {
    console.warn("⚠️ Não foi possível gravar state.json:", e.message);
  }
}

/* =========================
   ⏱️ Helpers de temporização
   ========================= */
function sleep(ms, token = cancelToken) {
  return new Promise((resolve) => {
    if (token.cancelled) return resolve();
    const id = setTimeout(resolve, ms);
    // não precisamos cancelar setTimeout neste caso; checamos token depois
  });
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function jitter(ms, pct = 0.25) {
  const delta = Math.floor(ms * pct);
  return ms + randInt(-delta, delta);
}

/* =========================
   🔌 WhatsApp
   ========================= */
async function connectToWhatsApp() {
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
      // Recomendações para estabilidade:
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        try {
          qrCode = await QRCode.toDataURL(qr);
          connected = false;
          broadcast({ type: "qr", qr: qrCode });
        } catch (err) {
          console.error("❌ Erro ao gerar QR:", err);
        }
      }

      if (connection === "open") {
        connected = true;
        qrCode = null;
        console.log("✅ WhatsApp conectado!");
        participantesCache.clear();
        broadcast({
          type: "connected",
          user: sock.user,
          stats: { totalAdicionados, totalJaExistem, totalFalhas, falhasSeguidas },
        });
        // Retoma se houver fila e não estiver pausado
        if (fila.length > 0 && !emAdicao && !isPaused) {
          setImmediate(processarFila);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log("🔌 Desconectado:", DisconnectReason[statusCode] || statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          await fs.remove(path.join(__dirname, "auth")).catch(console.error);
          sock = null;
          connected = false;
          broadcast({ type: "disconnected", reason: "logged_out" });
        } else {
          sock = null;
          connected = false;
          broadcast({ type: "disconnected", reason: "reconnecting" });
          setTimeout(connectToWhatsApp, 5000);
        }
      }
    });
  } catch (err) {
    console.error("❌ Erro ao conectar:", err);
    broadcast({ type: "error", message: "Falha ao iniciar: " + err.message });
  }
}

/* =========================
   👥 Utilidades de grupo
   ========================= */
function toJid(num) {
  const onlyDigits = String(num).replace(/\D/g, "");
  return `${onlyDigits}@s.whatsapp.net`;
}

async function getParticipantes(groupId) {
  // usa cache por alguns minutos (bem simples)
  let set = participantesCache.get(groupId);
  if (set) return set;

  const metadata = await sock.groupMetadata(groupId).catch(() => null);
  if (!metadata) throw new Error("Grupo não encontrado ou sem permissão");

  set = new Set(metadata.participants.map((p) => p.id));
  participantesCache.set(groupId, set);
  return set;
}

function marcaExisteEmCache(groupId, jid) {
  const set = participantesCache.get(groupId);
  return set ? set.has(jid) : false;
}
function adicionaAoCache(groupId, jid) {
  const set = participantesCache.get(groupId);
  if (set) set.add(jid);
}

/* =========================
   🔁 Fila & Lotes
   ========================= */
function criarMiniLotes(numeros) {
  // Usa as pausasPadrao configuradas
  const total = numeros.length;
  const lotes = [];
  if (total >= 5) {
    lotes.push({ numeros: numeros.slice(0, 2), pausa: pacing.pausasPadrao["5"][0] });
    lotes.push({ numeros: [numeros[2]], pausa: pacing.pausasPadrao["5"][1] });
    lotes.push({ numeros: [numeros[3]], pausa: pacing.pausasPadrao["5"][2] });
    lotes.push({ numeros: [numeros[4]], pausa: pacing.pausasPadrao["5"][3] });
  } else if (total === 4) {
    lotes.push({ numeros: numeros.slice(0, 2), pausa: pacing.pausasPadrao["4"][0] });
    lotes.push({ numeros: [numeros[2]], pausa: pacing.pausasPadrao["4"][1] });
    lotes.push({ numeros: [numeros[3]], pausa: pacing.pausasPadrao["4"][2] });
  } else if (total === 3) {
    lotes.push({ numeros: [numeros[0]], pausa: pacing.pausasPadrao["3"][0] });
    lotes.push({ numeros: [numeros[1]], pausa: pacing.pausasPadrao["3"][1] });
    lotes.push({ numeros: [numeros[2]], pausa: pacing.pausasPadrao["3"][2] });
  } else if (total === 2) {
    lotes.push({ numeros: [numeros[0]], pausa: pacing.pausasPadrao["2"][0] });
    lotes.push({ numeros: [numeros[1]], pausa: pacing.pausasPadrao["2"][1] });
  } else {
    lotes.push({ numeros, pausa: pacing.pausasPadrao["1"][0] });
  }
  return lotes;
}

function dedupFilaEntrada(groupId, arrNums) {
  // remove duplicados na própria requisição e também já na fila atual
  const pendentes = new Set(
    fila.filter(f => f.groupId === groupId).map(f => String(f.number).replace(/\D/g, ""))
  );
  const vistos = new Set();
  const out = [];
  for (const n of arrNums) {
    const clean = String(n).replace(/\D/g, "");
    if (clean.length < 8 || clean.length > 15) continue;
    if (vistos.has(clean)) continue;
    if (pendentes.has(clean)) continue;
    vistos.add(clean);
    out.push(clean);
  }
  return out;
}

/* =========================
   🧪 Classificação de erro
   ========================= */
function analisarResultado(resItem) {
  // resItem: { status, jid, ... }
  const code = resItem?.status;
  if (code === 200) return { ok: true };
  // 404: usuário não existe
  // 403: sem permissão (talvez não seja admin / grupo fechado)
  // 409: já está no grupo (ou conflito)
  // 408/429: rate-limit/timeout
  if (code === 409) return { ok: false, tipo: "ja_existe" };
  if (code === 403) return { ok: false, tipo: "sem_permissao" };
  if (code === 404) return { ok: false, tipo: "invalido" };
  if (TEMP_ERRORS.has(code)) return { ok: false, tipo: "temporario" };
  return { ok: false, tipo: "desconhecido" };
}

/* =========================
   ⚙️ Backoff adaptativo
   ========================= */
function aplicarBackoffSeNecessario() {
  if (!pacing.backoff.enabled) return null;
  if (falhasSeguidas >= pacing.backoff.thresholdFalhasSeguidas) {
    // Expande janela entre números e entre lotes
    pacing.minWaitMs = Math.floor(pacing.minWaitMs * pacing.backoff.multiplicadorMinMaxWait);
    pacing.maxWaitMs = Math.floor(pacing.maxWaitMs * pacing.backoff.multiplicadorMinMaxWait);
    // aumenta janela do próximo lote (efeito imediato no cronômetro)
    return {
      pausaLoteExtraMs: Math.floor(
        (pacing.proximoLoteMinMs + pacing.proximoLoteMaxMs) / 2 * (pacing.backoff.multiplicadorProxLote - 1)
      ),
    };
  }
  return null;
}

/* =========================
   🚚 Processar fila
   ========================= */
async function processarFila() {
  if (emAdicao || !sock || fila.length === 0) return;
  emAdicao = true;
  cancelToken = { cancelled: false };

  while (fila.length > 0) {
    if (isPaused || cancelToken.cancelled) break;

    // Seleciona um lote
    const primeiro = fila[0];
    const groupId = primeiro.groupId;

    // separa até pacing.loteMax do mesmo grupo (para reduzir metadados)
    const lote = [];
    while (fila.length > 0 && lote.length < pacing.loteMax && fila[0].groupId === groupId) {
      lote.push(fila.shift());
    }

    broadcast({
      type: "batch_start",
      count: lote.length,
      groupId,
      message: `Iniciando lote de ${lote.length} números...`,
    });

    // Busca participantes uma vez (cacheado)
    let participantes;
    try {
      participantes = await getParticipantes(groupId);
    } catch (e) {
      // Grupo inacessível: marca falha em todos os do lote
      for (const item of lote) {
        totalFalhas++;
        broadcast({ type: "number", number: item.number, status: "error", message: e.message || "Grupo inacessível" });
      }
      await salvarFila();
      falhasSeguidas += 1;
      aplicarBackoffSeNecessario();
      continue;
    }

    // Cria mini-lotes humanizados
    const miniLotes = criarMiniLotes(lote);

    for (const mini of miniLotes) {
      for (const item of mini.numeros) {
        if (isPaused || cancelToken.cancelled) break;

        const num = String(item.number).replace(/\D/g, "");
        const jid = toJid(num);

        // 1) Verifica se já está no grupo (cache/metadados)
        if (participantes.has(jid) || marcaExisteEmCache(groupId, jid)) {
          totalJaExistem++;
          broadcast({ type: "number", number: num, status: "exists", message: "Já no grupo" });
          continue;
        }

        // 2) Tenta adicionar com retries em caso de erro temporário
        let tentativas = 0;
        let sucesso = false;
        let ultimoTipoErro = "desconhecido";
        while (tentativas <= pacing.retriesTemporarios && !sucesso && !isPaused && !cancelToken.cancelled) {
          try {
            const res = await sock.groupParticipantsUpdate(groupId, [jid], "add");
            const r = res?.[0] || {};
            const analise = analisarResultado(r);
            if (analise.ok) {
              totalAdicionados++;
              falhasSeguidas = 0;
              sucesso = true;
              adicionaAoCache(groupId, jid);
              participantes.add(jid);
              broadcast({ type: "number", number: num, status: "success", message: "Adicionado" });
            } else {
              ultimoTipoErro = analise.tipo;

              if (analise.tipo === "ja_existe") {
                totalJaExistem++;
                falhasSeguidas = 0;
                sucesso = true;
                adicionaAoCache(groupId, jid);
                participantes.add(jid);
                broadcast({ type: "number", number: num, status: "exists", message: "Já no grupo (409)" });
              } else if (analise.tipo === "temporario") {
                tentativas++;
                if (tentativas <= pacing.retriesTemporarios) {
                  falhasSeguidas += 1;
                  const extra = aplicarBackoffSeNecessario();
                  const baseDelay = jitter(pacing.retryBaseDelayMs, 0.35);
                  const waitMs = extra ? baseDelay + extra.pausaLoteExtraMs : baseDelay;
                  broadcast({
                    type: "number_retry",
                    number: num,
                    attempt: tentativas,
                    max: pacing.retriesTemporarios,
                    message: `Erro temporário (${r.status}). Tentando de novo em ${(waitMs/1000)|0}s...`,
                  });
                  await sleep(waitMs, cancelToken);
                }
              } else if (analise.tipo === "sem_permissao") {
                totalFalhas++;
                falhasSeguidas += 1;
                broadcast({ type: "number", number: num, status: "error", message: "Sem permissão (403). Torne-se admin ou ative convites." });
                break;
              } else if (analise.tipo === "invalido") {
                totalFalhas++;
                falhasSeguidas += 1;
                broadcast({ type: "number", number: num, status: "error", message: "Número inválido (404)" });
                break;
              } else {
                totalFalhas++;
                falhasSeguidas += 1;
                broadcast({ type: "number", number: num, status: "error", message: `Falha (${r.status || "desconhecido"})` });
                break;
              }
            }
          } catch (err) {
            // Erro de rede/timeouts internos
            tentativas++;
            falhasSeguidas += 1;
            if (tentativas <= pacing.retriesTemporarios) {
              const waitMs = jitter(pacing.retryBaseDelayMs, 0.35);
              broadcast({
                type: "number_retry",
                number: num,
                attempt: tentativas,
                max: pacing.retriesTemporarios,
                message: `Exceção temporária: ${err?.message || err}. Retentando em ${(waitMs/1000)|0}s...`,
              });
              await sleep(waitMs, cancelToken);
            } else {
              totalFalhas++;
              broadcast({ type: "number", number: num, status: "error", message: err?.message || "Erro desconhecido" });
            }
          }
        }

        // Espera entre números (se não pausado/cancelado)
        if (!isPaused && !cancelToken.cancelled) {
          const ms = randInt(pacing.minWaitMs, pacing.maxWaitMs);
          broadcast({ type: "countdown", seconds: Math.ceil(ms / 1000), message: `Próxima ação em ${Math.ceil(ms/1000)}s...` });
          await sleep(ms, cancelToken);
        }
      }

      if (isPaused || cancelToken.cancelled) break;

      // Pausa de mini-lote
      if (mini.pausa && mini.pausa > 0) {
        broadcast({
          type: "mini_batch_pause",
          message: `Pausa de ${mini.pausa}s...`,
          pauseSeconds: mini.pausa,
        });
        for (let i = mini.pausa; i > 0; i--) {
          if (isPaused || cancelToken.cancelled) break;
          broadcast({ type: "countdown", seconds: i, message: `Próxima ação em ${i}s...` });
          await sleep(1000, cancelToken);
        }
      }
    }

    await salvarFila();
    await salvarState();

    // Próximo lote (se ainda houver fila e não estiver pausado)
    if (!isPaused && !cancelToken.cancelled && fila.length > 0) {
      // tempo base (10-15 min), ajustado por backoff se houver
      let delayMs = randInt(pacing.proximoLoteMinMs, pacing.proximoLoteMaxMs);
      const extra = aplicarBackoffSeNecessario();
      if (extra?.pausaLoteExtraMs) delayMs += extra.pausaLoteExtraMs;

      const totalSeconds = Math.max(1, Math.floor(delayMs / 1000));
      broadcast({
        type: "batch_done",
        stats: { totalAdicionados, totalJaExistem, totalFalhas, falhasSeguidas },
        nextAddInMs: delayMs,
        message: `Próximo lote em ${totalSeconds}s...`,
      });

      for (let i = totalSeconds; i > 0; i--) {
        if (isPaused || cancelToken.cancelled) break;
        broadcast({ type: "countdown", seconds: i, message: `Próximo lote em ${i}s...` });
        await sleep(1000, cancelToken);
      }
    } else {
      // terminou ou pausou
      broadcast({
        type: "batch_done",
        stats: { totalAdicionados, totalJaExistem, totalFalhas, falhasSeguidas },
        nextAddInMs: 0,
      });
    }
  }

  if (!isPaused && !cancelToken.cancelled && fila.length === 0) {
    broadcast({ type: "queue_completed" });
  }

  emAdicao = false;
  await salvarFila();
  await salvarState();
}

/* =========================
   🌐 Rotas HTTP
   ========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/state", (req, res) => {
  res.json({
    connected,
    isPaused,
    stats: { totalAdicionados, totalJaExistem, totalFalhas, falhasSeguidas },
    fila: fila.length,
    pacing,
  });
});

app.post("/connect", async (req, res) => {
  await connectToWhatsApp();
  res.json({ success: true });
});

// Adiciona números à fila (com deduplicação)
app.post("/add", async (req, res) => {
  const { groupId, numbers } = req.body || {};
  if (!connected) return res.json({ error: "Não conectado" });
  if (!groupId || !Array.isArray(numbers)) return res.json({ error: "Parâmetros inválidos" });

  const validos = dedupFilaEntrada(groupId, numbers);
  validos.forEach((num) => fila.push({ groupId, number: num, retries: 0 }));
  await salvarFila();

  // dispara processamento se não estiver rodando
  if (!emAdicao && !isPaused) setImmediate(processarFila);

  res.json({ success: true, total: validos.length, fila: fila.length });
});

// Pausar (não limpa a fila)
app.post("/pause", async (req, res) => {
  isPaused = true;
  cancelToken.cancelled = true; // interrompe esperas em curso
  await salvarState();
  broadcast({ type: "paused" });
  res.json({ success: true, paused: true });
});

// Retomar
app.post("/resume", async (req, res) => {
  if (!connected) return res.json({ error: "Não conectado" });
  isPaused = false;
  cancelToken = { cancelled: false };
  await salvarState();
  broadcast({ type: "resumed" });
  if (!emAdicao && fila.length > 0) setImmediate(processarFila);
  res.json({ success: true, paused: false });
});

// Parar (limpa fila)
app.post("/stop", async (req, res) => {
  fila = [];
  isPaused = true;
  cancelToken.cancelled = true;
  await salvarFila();
  await salvarState();
  broadcast({ type: "stopped" });
  res.json({ success: true });
});

// Logout
app.post("/logout", async (req, res) => {
  try {
    if (sock) await sock.logout();
  } catch {}
  sock = null;
  connected = false;
  await fs.remove(path.join(__dirname, "auth")).catch(console.error);
  await fs.remove(FILA_FILE).catch(console.error);
  await fs.remove(STATE_FILE).catch(console.error);
  broadcast({ type: "disconnected", reason: "manual" });
  res.json({ success: true });
});

// Ajustar pacing dinamicamente (opcional: para um painel no HTML)
app.post("/pacing", async (req, res) => {
  const {
    minWaitMs,
    maxWaitMs,
    proximoLoteMinMs,
    proximoLoteMaxMs,
    loteMax,
    retriesTemporarios,
  } = req.body || {};
  if (Number.isInteger(minWaitMs)) pacing.minWaitMs = Math.max(1000, minWaitMs);
  if (Number.isInteger(maxWaitMs)) pacing.maxWaitMs = Math.max(pacing.minWaitMs, maxWaitMs);
  if (Number.isInteger(proximoLoteMinMs)) pacing.proximoLoteMinMs = Math.max(60_000, proximoLoteMinMs);
  if (Number.isInteger(proximoLoteMaxMs)) pacing.proximoLoteMaxMs = Math.max(pacing.proximoLoteMinMs, proximoLoteMaxMs);
  if (Number.isInteger(loteMax)) pacing.loteMax = Math.min(10, Math.max(1, loteMax));
  if (Number.isInteger(retriesTemporarios)) pacing.retriesTemporarios = Math.min(5, Math.max(0, retriesTemporarios));

  await salvarState();
  broadcast({ type: "pacing_update", pacing });
  res.json({ success: true, pacing });
});

/* =========================
   🔌 WebSocket
   ========================= */
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  if (qrCode) ws.send(JSON.stringify({ type: "qr", qr: qrCode }));
  if (connected) {
    ws.send(
      JSON.stringify({
        type: "connected",
        user: sock?.user,
        stats: { totalAdicionados, totalJaExistem, totalFalhas, falhasSeguidas },
      })
    );
  }
  ws.send(JSON.stringify({
    type: "queue_update",
    count: fila.length,
    stats: { totalAdicionados, totalJaExistem, totalFalhas, falhasSeguidas },
    pacing,
    isPaused,
  }));
});

/* =========================
   🚀 Inicialização
   ========================= */
async function startServer() {
  await fs.ensureDir(path.join(__dirname, "data"));
  await carregarState();
  await carregarFila();

  server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`👉 Acesse: http://localhost:${PORT}`);
  });

  // Reconecta automaticamente
  connectToWhatsApp().catch(() => {});
}
startServer();
