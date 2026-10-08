(async () => {
  const { Worker } = await import("worker_threads");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const fs = await import("fs");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const { WebSocketServer } = await import("ws");
  const { pack, unpack } = await import("msgpackr");
  const http = await import("http");
  const fetch = (await import("node-fetch")).default;

  function normalizeProxy(raw) {
    const s = String(raw || "").trim();
    if (!s || s.startsWith("#")) return "";
    if (/^https?:\/\//i.test(s) || /^socks/i.test(s)) return s.replace(/\/$/, "");
    const parts = s.split(":");
    if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1])) {
      return `http://${parts[0]}:${parts[1]}`;
    }
    if (parts.length >= 4) {
      const host = parts[0], port = parts[1];
      const user = encodeURIComponent(parts[2]);
      const pass = encodeURIComponent(parts.slice(3).join(":"));
      return `http://${user}:${pass}@${host}:${port}`;
    }
    return "";
  }

  function loadProxies() {
    const file = path.join(__dirname, "proxies.txt");
    let lines = [];
    try {
      if (fs.existsSync(file)) lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    } catch (_) {}
    return lines.map(normalizeProxy).filter(Boolean);
  }

  const CONFIG = {
    port: process.env.PORT || 8082,
    maxLive: 500,
    proxies: loadProxies(),
    workerMemoryMb: 64,
    botsPerWorker: 10,
    prewarmPool: 4,
    spawnBaseMs: 45,
    spawnJitterMs: 80,
    parallelSpawns: 3,
    reconnectAttempts: 40,
    reconnectDelayMs: 2800,
  };

  let scriptCache = null;
  let wasmCache = null;

  const overlayPath = path.join(__dirname, "overlay.js");
  const loaderPath = path.join(__dirname, "loader.user.js");

  const httpServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const u = String(req.url || "/").split("?")[0];
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (u === "/overlay.js" && fs.existsSync(overlayPath)) {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      return fs.createReadStream(overlayPath).pipe(res);
    }
    if ((u === "/loader.user.js" || u === "/loader.js") && fs.existsSync(loaderPath)) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return fs.createReadStream(loaderPath).pipe(res);
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("godly farm ok\n");
  });

  const rand = (a, b) => (Math.random() * (b - a + 1) | 0) + a;
  const workerPath = path.join(__dirname, "index.js");

  function extractScript(html) {
    const open = html.indexOf("<script>");
    const close = html.indexOf("</script", open);
    if (open < 0 || close < 0) throw new Error("script tag missing");
    return html.slice(open + 8, close);
  }

  async function preload() {
    try {
      const [htmlRes, wasmRes] = await Promise.all([
        fetch("https://arras.io"),
        fetch("https://arras.io/app.wasm"),
      ]);
      scriptCache = extractScript(await htmlRes.text());
      wasmCache = new Uint8Array(await wasmRes.arrayBuffer());
      console.log(`[preload] script=${scriptCache.length} wasm=${wasmCache.byteLength}`);
    } catch (e) {
      console.error("[preload] failed:", e.message);
    }
  }

  function createWorker(session) {
    const w = new Worker(workerPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: CONFIG.workerMemoryMb,
        maxYoungGenerationSizeMb: 24,
        codeRangeSizeMb: 16,
      },
    });
    w.send = (msg) => w.postMessage(msg);
    w.botIds = [];
    w.activeBots = 0;
    w.prepared = false;
    w.on("error", (err) => console.error("[worker]", err.message));
    w.on("message", (msg) => {
      if (msg?.type === "died") {
        const i = w.botIds.indexOf(msg.id);
        if (i >= 0) w.botIds.splice(i, 1);
        w.activeBots = Math.max(0, w.activeBots - 1);
      }
    });
    w.on("exit", () => {
      const a = session.workers.indexOf(w);
      if (a >= 0) session.workers.splice(a, 1);
      const b = session.pool.indexOf(w);
      if (b >= 0) session.pool.splice(b, 1);
    });
    return w;
  }

  function prepare(w) {
    w.send({ type: "prepare", arrasCache: scriptCache, wasmCache });
    w.prepared = true;
  }

  function fillPool(session) {
    const total = session.workers.length + session.pool.length;
    for (let i = total; i < CONFIG.prewarmPool; i++) {
      const w = createWorker(session);
      session.pool.push(w);
      prepare(w);
    }
  }

  function acquire(session) {
    const free = session.workers.find((w) => w.activeBots < CONFIG.botsPerWorker);
    if (free) return free;
    const w = session.pool.shift() || createWorker(session);
    if (!w.prepared) prepare(w);
    if (!session.workers.includes(w)) session.workers.push(w);
    return w;
  }

  function enqueue(session, hash, name) {
    session.queue.push({ hash, name });
    drain(session);
  }

  function drain(session) {
    while (session.activeSpawns < CONFIG.parallelSpawns && session.queue.length) {
      const job = session.queue.shift();
      session.activeSpawns++;
      const botId = session.nextId++;
      const delay = CONFIG.spawnBaseMs + rand(0, CONFIG.spawnJitterMs);

      setTimeout(() => {
        let live = 0;
        for (const w of session.workers) live += w.activeBots | 0;
        if (live >= CONFIG.maxLive) {
          session.activeSpawns--;
          return drain(session);
        }
        const w = acquire(session);
        w.botIds.push(botId);
        w.activeBots++;

        let tank = session.tank;
        if (session.tanks.length) {
          tank = session.tanks[session.tankIdx];
          session.tankIdx = (session.tankIdx + 1) % session.tanks.length;
        }

        const list = CONFIG.proxies;
        const proxyUrl = list.length ? list[session.proxyIdx % list.length] : "";
        session.proxyIdx++;
        const socks = /^socks/i.test(proxyUrl);

        const cfg = {
          id: botId,
          proxy: proxyUrl ? { type: socks ? "socks" : "http", url: proxyUrl } : null,
          hash: "#" + job.hash,
          name: job.name,
          type: "follow",
          autoRespawn: true,
          reconnectAttempts: CONFIG.reconnectAttempts,
          reconnectDelay: CONFIG.reconnectDelayMs,
          initialTarget: { tank },
        };
        if (!w.prepared) {
          cfg.arrasCache = scriptCache;
          cfg.wasmCache = wasmCache;
        }

        w.send({ type: "start", config: cfg });
        session.activeSpawns--;
        drain(session);
      }, delay);
    }
    if (!session.queue.length) fillPool(session);
  }

  function killAll(session) {
    session.queue = [];
    session.activeSpawns = 0;
    for (const w of session.workers) {
      try { w.send({ type: "destroy" }); } catch (_) {}
      w.botIds = [];
      w.activeBots = 0;
    }
    session.workers = [];
    fillPool(session);
  }

  function liveCount(session) {
    let n = 0;
    for (const w of session.workers) n += w.activeBots | 0;
    return n;
  }

  function snapshot(session) {
    return [
      liveCount(session),
      session.queue.length,
      CONFIG.proxies.length,
      CONFIG.maxLive,
    ];
  }

  const sessions = new Map();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });

  function getSession(addr) {
    if (!sessions.has(addr)) {
      sessions.set(addr, {
        workers: [], pool: [], queue: [],
        activeSpawns: 0, nextId: 0,
        tank: "auto6", tanks: [], tankIdx: 0, proxyIdx: 0,
      });
    }
    return sessions.get(addr);
  }

  const posScratch = {
    type: "position",
    x: 0, y: 0, mouseX: 0, mouseY: 0,
    mouseDown: 0, rMouseDown: 0, mouse: 0, feeding: 0,
    shift: 0, autofire: 0, autospin: 0,
    manualMode: 0, manualX: 0, manualY: 0, noMove: false, noAim: false,
  };

  wss.on("connection", (ws, req) => {
    const addr = req.socket.remoteAddress;
    const session = getSession(addr);
    let challenge = 0;
    let ok = false;
    const send = (...args) => { if (ws.readyState === 1) ws.send(pack(args)); };

    ws.on("message", (raw) => {
      try {
        const data = unpack(raw);
        const type = data.shift();
        if (type === "M") {
          if (challenge || data[0] !== 72011) return ws.close();
          challenge = rand(512, 1023);
          return send("M", challenge);
        }
        if (type === "C") {
          if (data[0] !== (challenge ^ 845)) return ws.close();
          ok = true;
          console.log("[ws] auth", addr);
          fillPool(session);
          return send("S", ...snapshot(session));
        }
        if (!ok) return;
        switch (type) {
          case "Z": {
            session.tank = data[0];
            if (Array.isArray(session.tank)) {
              session.tanks = session.tank;
              session.tankIdx = 0;
              for (const w of session.workers) {
                for (const id of w.botIds) {
                  w.send({ type: "tankselect", tank: session.tanks[session.tankIdx], botId: id });
                  session.tankIdx = (session.tankIdx + 1) % session.tanks.length;
                }
              }
            } else {
              session.tanks = [];
              for (const w of session.workers) w.send({ type: "tankselect", tank: session.tank });
            }
            break;
          }
          case "F": {
            const hash = String(data[0] || "").replace(/^#/, "");
            const count = Math.min(40, Math.max(1, parseInt(data[1], 10) || 1));
            const name = String(data[2] || "Bot").trim() || "Bot";
            if (data[3]) session.tank = data[3];
            console.log("[spawn]", count, "hash=" + hash, "px=" + CONFIG.proxies.length);
            for (let i = 0; i < count; i++) enqueue(session, hash, name);
            send("S", ...snapshot(session));
            break;
          }
          case "B":
            killAll(session);
            send("S", ...snapshot(session));
            break;
          case "P":
            send("S", ...snapshot(session));
            break;
          case "A": {
            posScratch.x = data[0];
            posScratch.y = data[1];
            posScratch.mouseX = data[2];
            posScratch.mouseY = data[3];
            posScratch.mouseDown = data[4];
            posScratch.rMouseDown = data[5];
            posScratch.mouse = data[6];
            posScratch.feeding = data[7];
            posScratch.shift = data[8];
            posScratch.autofire = data[9];
            posScratch.autospin = data[10];
            posScratch.manualMode = data[11];
            posScratch.manualX = data[12];
            posScratch.manualY = data[13];
            posScratch.noMove = !!data[14];
            posScratch.noAim = !!data[15];
            for (const w of session.workers) w.send(posScratch);
            break;
          }
          case "T":
            for (const w of session.workers) w.send({ type: "chat", message: data[0], spam: data[1] });
            break;
          default:
            ws.close();
        }
      } catch (_) {}
    });
    ws.on("close", () => console.log("[ws]", addr, "out"));
  });

  await preload();
  httpServer.listen(CONFIG.port, () => {
    console.log(`[farm] :${CONFIG.port} proxies=${CONFIG.proxies.length} overlay=/overlay.js`);
    console.log(`[farm] ${CONFIG.botsPerWorker}/worker mem=${CONFIG.workerMemoryMb}MB parallel=${CONFIG.parallelSpawns}`);
  });
})();
