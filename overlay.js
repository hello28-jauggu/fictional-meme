/* Red Machine v3 overlay */
(function start() {
  function go() {
    if (window.__RedMachine) return;
    window.__RedMachine = true;

    let px = 0, py = 0, hasPos = false;
    try {
      const old = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = new Proxy(old, {
        apply(t, th, args) {
          const text = String(args[0] || "");
          if (text.startsWith("Coordinates: (")) {
            const inner = text.slice(14, text.indexOf(")"));
            const p = inner.split(",");
            const nx = parseFloat(p[0]), ny = parseFloat(p[1]);
            if (!isNaN(nx) && !isNaN(ny)) { px = nx; py = ny; hasPos = true; }
          }
          return Reflect.apply(t, th, args);
        }
      });
    } catch (_) {}

    function farmWss() {
      try {
        const hit = [...document.scripts].map((s) => s.src).find((s) => s && /overlay\.js/i.test(s));
        if (hit) {
          const u = new URL(hit);
          return (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host + "/";
        }
      } catch (_) {}
      return "";
    }

    const url = farmWss();
    let ws = null, ready = false, open = true;
    let freeze = false, follow = true, feed = false, lmb = 0, rmb = 0, mx = 0, my = 0;
    let live = 0, queue = 0, proxies = 0, maxLive = 0;

    const css = document.createElement("style");
    css.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Manrope:wght@500;700;800&display=swap');
#rm{position:fixed;z-index:2147483646;top:14px;right:14px;width:min(320px,94vw);
background:rgba(8,10,18,.72);color:#f4f7ff;font:600 12px/1.35 Manrope,system-ui,sans-serif;
border:1px solid rgba(255,255,255,.12);border-radius:22px;overflow:hidden;
backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);
box-shadow:0 30px 80px #0007, inset 0 1px 0 rgba(255,255,255,.08)}
#rm.off{display:none}
#rm:before{content:"";position:absolute;inset:-40% -20% auto;height:120px;pointer-events:none;
background:radial-gradient(circle,rgba(34,211,238,.28),transparent 70%)}
#rm-h{position:relative;display:flex;align-items:center;gap:10px;padding:14px 16px 10px;cursor:move}
#rm-h .logo{font-family:Syne,sans-serif;font-weight:800;font-size:15px;letter-spacing:.04em;
background:linear-gradient(90deg,#67e8f9,#a78bfa);-webkit-background-clip:text;color:transparent}
#rm-h .sub{margin-left:auto;font-size:10px;color:#94a3b8}
#rm-dot{width:9px;height:9px;border-radius:50%;background:#64748b;flex:0 0 9px}
#rm-dot.on{background:#22c55e;box-shadow:0 0 12px #22c55e}
#rm-b{position:relative;padding:4px 14px 14px}
#rm .chips{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0 10px}
#rm .chip{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:8px 4px;text-align:center}
#rm .chip em{display:block;font-style:normal;font-size:8px;letter-spacing:.12em;color:#7dd3fc}
#rm .chip strong{display:block;margin-top:2px;font-size:13px}
#rm .row{display:flex;gap:7px;margin:7px 0}
#rm label.k{display:flex;align-items:center;gap:6px;flex:1;min-height:34px;font-size:11px;color:#cbd5e1;background:rgba(255,255,255,.04);border-radius:11px;padding:0 8px;border:1px solid rgba(255,255,255,.06)}
#rm input,#rm button,#rm select{flex:1;min-height:36px;border-radius:11px;border:1px solid rgba(255,255,255,.1);
background:rgba(0,0,0,.28);color:#f8fafc;font:700 12px Manrope,system-ui;padding:0 10px}
#rm input:focus{outline:0;border-color:#22d3ee;box-shadow:0 0 0 3px rgba(34,211,238,.15)}
#rm button{cursor:pointer}
#rm .g{background:linear-gradient(135deg,#22d3ee,#818cf8);border:0;color:#041018;font-weight:800}
#rm .r{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.35);color:#fecaca}
#rm .st{font-size:10px;color:#8b9cb3;margin-top:8px;min-height:28px}
#rm-fab{position:fixed;z-index:2147483647;top:14px;right:14px;display:none;min-height:38px;
padding:8px 16px;border:0;border-radius:999px;background:linear-gradient(135deg,#22d3ee,#818cf8);
color:#041018;font:800 12px Syne,sans-serif}
`;
    document.documentElement.appendChild(css);

    const root = document.createElement("div");
    root.id = "rm";
    root.innerHTML = `
      <div id="rm-h"><span id="rm-dot"></span><span class="logo">RED MACHINE</span><span class="sub" id="g-link">CS</span></div>
      <div id="rm-b">
        <div class="chips">
          <div class="chip"><em>LIVE</em><strong id="g-live">0</strong></div>
          <div class="chip"><em>QUEUE</em><strong id="g-q">0</strong></div>
          <div class="chip"><em>PROXY</em><strong id="g-px">0</strong></div>
          <div class="chip"><em>MAX</em><strong id="g-max">—</strong></div>
        </div>
        <div class="row"><input id="g-n" type="number" min="1" max="40" value="3" title="count"><input id="g-name" value="Bot" title="name"></div>
        <div class="row"><input id="g-hash" placeholder="party hash"><input id="g-tank" placeholder="tank" value="basic"></div>
        <div class="row">
          <label class="k"><input id="g-fol" type="checkbox" checked> Follow</label>
          <label class="k"><input id="g-fz" type="checkbox"> Freeze</label>
          <label class="k"><input id="g-feed" type="checkbox"> Feed</label>
        </div>
        <div class="row"><button class="g" id="g-sp">SPAWN</button><button class="r" id="g-k">KILL</button></div>
        <div class="st" id="g-st">connecting…</div>
      </div>`;
    document.documentElement.appendChild(root);
    const fab = document.createElement("button");
    fab.id = "rm-fab";
    fab.textContent = "RED";
    document.documentElement.appendChild(fab);

    const $ = (id) => document.getElementById(id);
    const st = (t) => { const e = $("g-st"); if (e) e.textContent = t; };
    function paint() {
      $("g-live").textContent = String(live);
      $("g-q").textContent = String(queue);
      $("g-px").textContent = String(proxies);
      $("g-max").textContent = maxLive ? String(maxLive) : "—";
      $("rm-dot").classList.toggle("on", ready);
    }
    try {
      const h = (location.hash || "").replace(/^#/, "");
      if (h) $("g-hash").value = h;
    } catch (_) {}
    $("g-link").textContent = (url || "no farm").replace(/^wss?:\/\//, "").slice(0, 22);

    function send(...a) {
      if (!ws || ws.readyState !== 1 || !window.msgpack) return;
      try { ws.send(msgpack.encode(a)); } catch (_) {}
    }

    function connect() {
      if (!url) { st("loader FARM URL galat"); return; }
      try { if (ws) ws.close(); } catch (_) {}
      try { ws = new WebSocket(url); } catch (e) { st("bad wss"); return; }
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { st("handshake…"); send("M", 72011); };
      ws.onmessage = (ev) => {
        try {
          const d = msgpack.decode(new Uint8Array(ev.data));
          if (d[0] === "M") { send("C", d[1] ^ 845); ready = true; st("READY — spawn 3 se test"); paint(); }
          if (d[0] === "S") {
            live = d[1] | 0; queue = d[2] | 0; proxies = d[3] | 0; maxLive = d[4] | 0;
            st(ready ? ("live " + live + " · queue " + queue + " · px " + proxies) : "…");
            paint();
          }
        } catch (_) {}
      };
      ws.onclose = () => { ready = false; paint(); st("CS band — retry"); setTimeout(connect, 2200); };
    }

    $("g-sp").onclick = () => {
      if (!ready) return st("CS READY nahi — 8082 public?");
      const n = Math.max(1, Math.min(40, parseInt($("g-n").value, 10) || 1));
      const h = ($("g-hash").value || location.hash || "").replace(/^#/, "");
      if (!h) return st("party join karo / hash daalo");
      send("Z", $("g-tank").value || "basic");
      send("F", h, n, $("g-name").value || "Bot", $("g-tank").value || "basic");
      st("queued " + n + " — LIVE tab dekho (CF rok sakti hai)");
    };
    $("g-k").onclick = () => { send("B"); live = 0; queue = 0; paint(); st("killed"); };
    $("g-fz").onchange = () => { freeze = $("g-fz").checked; };
    $("g-fol").onchange = () => { follow = $("g-fol").checked; };
    $("g-feed").onchange = () => { feed = $("g-feed").checked; };

    window.addEventListener("keydown", (e) => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      open = !open;
      root.classList.toggle("off", !open);
      fab.style.display = open ? "none" : "block";
    }, true);
    fab.onclick = () => { open = true; root.classList.remove("off"); fab.style.display = "none"; };

    const hdr = $("rm-h");
    let drag = false, ox = 0, oy = 0;
    hdr.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      drag = true;
      const r = root.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      hdr.setPointerCapture(e.pointerId);
    });
    hdr.addEventListener("pointermove", (e) => {
      if (!drag) return;
      root.style.left = Math.max(4, e.clientX - ox) + "px";
      root.style.top = Math.max(4, e.clientY - oy) + "px";
      root.style.right = "auto";
    });
    hdr.addEventListener("pointerup", () => { drag = false; });

    window.addEventListener("mousedown", (e) => { if (e.button === 0) lmb = 1; if (e.button === 2) rmb = 1; });
    window.addEventListener("mouseup", (e) => { if (e.button === 0) lmb = 0; if (e.button === 2) rmb = 0; });
    window.addEventListener("mousemove", (e) => { mx = e.clientX; my = e.clientY; });
    window.addEventListener("touchstart", () => { lmb = 1; }, { passive: true });
    window.addEventListener("touchend", () => { lmb = 0; }, { passive: true });
    window.addEventListener("touchmove", (e) => {
      if (e.touches[0]) { mx = e.touches[0].clientX; my = e.touches[0].clientY; }
    }, { passive: true });

    let beat = 0;
    setInterval(() => {
      if (!ready) return;
      if ((beat++ % 12) === 0) send("P");
      const noMove = freeze || !follow;
      send("A", hasPos ? px : 0, hasPos ? py : 0,
        (mx - innerWidth / 2) / 40, (my - innerHeight / 2) / 40,
        lmb, rmb, follow && !freeze ? 1 : 0, feed ? 1 : 0, 0, 0, 0, 0, 0, 0, noMove, freeze);
    }, 80);

    connect();
  }

  if (window.msgpack && msgpack.encode) return go();
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/msgpack-lite/0.1.26/msgpack.min.js";
  s.onload = go;
  document.documentElement.appendChild(s);
})();
