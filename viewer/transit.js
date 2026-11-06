// Live buses, trolleys (and, once a data source exists, trams) as little
// isometric pixel-art vehicles driving over the map.
//
// Data: the public athens-transit-rt API (the backend behind staseis.gr):
//   live positions  https://transit.haroldpoi.dev/v1/vehicles/tiles/13/{x}/{y}
//   line kinds      https://angelospk.github.io/athens-transit-rt/static/v1/lines.json
// Polled only for the map's own area, and only when the API says new data is
// ready (next_update_at), never more than every 10 s.
//
// Between updates each vehicle keeps driving along the "path ahead" the API
// sends, at its reported speed, so it moves continuously instead of jumping.
// geo.json (scripts/make_geo.py) turns GPS positions into map pixels.
//
// Uses `viewer` and `mapItem` from index.html.

(() => {
  const API = "https://transit.haroldpoi.dev";
  const LINES_URL = "https://angelospk.github.io/athens-transit-rt/static/v1/lines.json";

  // Camera (must match config.json "camera"): metres per image pixel and the view's tilt.
  const MPP = 0.293;
  const ELEVATION_DEG = 45;
  const ART_M = 0.5;            // one sprite pixel = 0.5 m, a bit coarser than the map, reads as pixel art
  const MIN_ART_PX = 1;         // never draw a sprite pixel smaller than 1 screen px (bus >= ~24 px)
  const EXTRAPOLATE_MAX_S = 45; // stop driving ahead this long after the last GPS fix
  const BLEND_MS = 1500;        // ease into a corrected position when a new fix arrives
  const STALE_S = 120;

  // Toy proportions (like vehicles in pixel-art city games): a bit shorter, much
  // wider and taller than real, so they read as buses rather than sticks.
  const KINDS = {
    bus:     { color: "#153ce0", length: 10, width: 4.2, height: 4.4, poles: false },
    trolley: { color: "#f19a1e", length: 10, width: 4.2, height: 4.4, poles: true },
    tram:    { color: "#2e9e48", length: 22, width: 4.2, height: 4.6, poles: false, pantograph: true },
  };

  // Display style (also selectable with ?style=… for the comparison page):
  //   boxes   plain coloured vehicles (blue bus, orange trolley)
  //   livery  Athens liveries with headlights, doors and route sign; lit up at night
  //   badges  round line-number badges with a direction pointer
  //   hybrid  badges when zoomed out, livery vehicles when zoomed in
  //   delay   vehicles coloured by punctuality
  const params = new URLSearchParams(location.search);
  const STYLE = params.get("style") || "boxes";
  const FORCE_NIGHT = params.get("night") === "1";
  const LIVERY = {
    bus:     { body: "#f3f5f7", band: "#153ce0", roof: "#dde2e8" },
    trolley: { body: "#f6b01e", band: "#c94f0c", roof: "#fbd27a" },
    tram:    { body: "#f3f5f7", band: "#2e9e48", roof: "#dde2e8" },
  };

  // Rough Athens sunrise/sunset (local time) from the day of the year.
  function isNight() {
    if (FORCE_NIGHT) return true;
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Athens", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
    const hh = +parts.find((x) => x.type === "hour").value + +parts.find((x) => x.type === "minute").value / 60;
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
    const k = Math.sin((2 * Math.PI * (doy - 80)) / 365);
    const sunset = 19.0 + 1.85 * k, sunrise = 6.87 - 0.8 * k;
    return hh < sunrise - 0.25 || hh > sunset + 0.25;
  }

  function delayColor(d) {
    if (d == null) return "#6f7b87";       // not matched to a timetable
    if (d < -120) return "#1c9ad6";        // early
    if (d < 120) return "#2f9e44";         // on time
    if (d < 300) return "#f59f00";         // a little late
    return "#e03131";                      // late
  }

  const btn = document.getElementById("btn-transit");
  const statusEl = document.getElementById("transit-status");
  const tip = document.createElement("div");
  tip.id = "veh-tip";
  document.body.appendChild(tip);

  const canvas = document.createElement("canvas");
  canvas.id = "vehicles";
  document.getElementById("map").appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let geo = null, info = null, lines = {};
  let on = false, timer = null;
  const vehicles = new Map(); // id -> state
  const sprites = new Map();  // cache key -> canvas

  Promise.all([
    fetch("geo.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("tiles/info.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(LINES_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]).then(([g, i, l]) => {
    geo = g; info = i;
    if (info && info.preview) document.getElementById("preview-note").style.display = "block";
    for (const line of (l && l.lines) || []) lines[line.id] = line;
  });

  const setStatus = (t) => { statusEl.textContent = t; statusEl.style.display = "block"; };

  // ---------- geography ----------

  // GPS -> image pixel, bilinear in the geo.json grid. null if off the map.
  function toImagePx(lat, lon) {
    const r = (lat - geo.lat0) / geo.dlat, c = (lon - geo.lon0) / geo.dlon;
    const r0 = Math.floor(r), c0 = Math.floor(c);
    if (r0 < 0 || c0 < 0 || r0 + 1 >= geo.ny || c0 + 1 >= geo.nx) return null;
    const fr = r - r0, fc = c - c0, out = [0, 0];
    for (const [k, arr] of [[0, geo.px], [1, geo.py]]) {
      const a = arr[r0 * geo.nx + c0], b = arr[r0 * geo.nx + c0 + 1];
      const d = arr[(r0 + 1) * geo.nx + c0], e = arr[(r0 + 1) * geo.nx + c0 + 1];
      if (a == null || b == null || d == null || e == null) return null;
      out[k] = (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
    }
    const x = out[0] - info.origin_px[0], y = out[1] - info.origin_px[1];
    return x >= 0 && y >= 0 && x < info.width && y < info.height ? [x, y] : null;
  }

  const M_PER_DEG_LAT = 111320;
  const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

  // Screen (image-pixel) vectors for 1 m east and 1 m north on the ground, measured
  // from the geo grid at the map's centre. Used to draw sprites in perspective.
  let basis = null;
  function groundBasis() {
    if (basis) return basis;
    const lat = (geo.bbox[0] + geo.bbox[2]) / 2, lon = (geo.bbox[1] + geo.bbox[3]) / 2;
    const p = toImagePx(lat, lon), pe = toImagePx(lat, lon + 20 / mPerDegLon(lat)), pn = toImagePx(lat + 20 / M_PER_DEG_LAT, lon);
    if (!p || !pe || !pn) return null;
    basis = { east: [(pe[0] - p[0]) / 20, (pe[1] - p[1]) / 20], north: [(pn[0] - p[0]) / 20, (pn[1] - p[1]) / 20] };
    return basis;
  }

  // Bearing (degrees clockwise from north) from point a to b.
  function bearingDeg(a, b) {
    const dx = (b[1] - a[1]) * mPerDegLon(a[0]), dy = (b[0] - a[0]) * M_PER_DEG_LAT;
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }
  function distM(a, b) {
    return Math.hypot((b[1] - a[1]) * mPerDegLon(a[0]), (b[0] - a[0]) * M_PER_DEG_LAT);
  }

  // Walk `d` metres along a polyline of [lat, lon]; returns {pos, heading}.
  function along(points, d, fallbackHeading) {
    for (let i = 0; i + 1 < points.length; i++) {
      const seg = distM(points[i], points[i + 1]);
      if (seg < 0.01) continue;
      if (d <= seg) {
        const t = d / seg, a = points[i], b = points[i + 1];
        return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearingDeg(a, b) };
      }
      d -= seg;
    }
    const n = points.length;
    const heading = n >= 2 && distM(points[n - 2], points[n - 1]) > 0.5 ? bearingDeg(points[n - 2], points[n - 1]) : fallbackHeading;
    return { pos: points[n - 1], heading };
  }

  // Where a vehicle should be shown right now (GPS fix + driving ahead along its path).
  function estimate(v, nowS) {
    const pts = [[v.lat, v.lon], ...(v.path || [])];
    const dt = Math.max(0, Math.min(EXTRAPOLATE_MAX_S, nowS - v.positionAt));
    const d = v.speed ? v.speed * dt : 0;
    return along(pts, d, v.bearing ?? v.lastHeading ?? 0);
  }

  // ---------- sprites ----------

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
      Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f)));
    return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
  }

  // Draw one vehicle as a little isometric box, seen from the map's camera,
  // facing `heading` (32 directions), then give it a crisp 1-pixel outline.
  function makeSprite(kind, heading, stale, opts = {}) {
    const K = KINDS[kind] || KINDS.bus;
    const B = groundBasis();
    const art = MPP / ART_M; // image px -> sprite px
    const E = [B.east[0] * art, B.east[1] * art];   // 1 m east, in sprite pixels
    const N = [B.north[0] * art, B.north[1] * art]; // 1 m north, in sprite pixels
    const h = (heading * Math.PI) / 180;
    const fwd = [Math.sin(h) * E[0] + Math.cos(h) * N[0], Math.sin(h) * E[1] + Math.cos(h) * N[1]];
    const rgt = [Math.cos(h) * E[0] - Math.sin(h) * N[0], Math.cos(h) * E[1] - Math.sin(h) * N[1]];
    const up = [0, -Math.cos((ELEVATION_DEG * Math.PI) / 180) / ART_M];

    const size = Math.ceil((K.length + 8) / ART_M) + 8;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const c = cv.getContext("2d");
    const cx = size / 2, cy = size / 2 + 4;
    const P = (f, r, z) => [cx + fwd[0] * f + rgt[0] * r + up[0] * z, cy + fwd[1] * f + rgt[1] * r + up[1] * z];
    const poly = (pts, fill) => {
      c.beginPath(); c.moveTo(...pts[0]); for (const p of pts.slice(1)) c.lineTo(...p); c.closePath();
      c.fillStyle = fill; c.fill();
    };

    const L = K.length / 2, W = K.width / 2, H = K.height;
    const LV = opts.livery ? LIVERY[kind] || LIVERY.bus : null;
    const base = stale ? "#8d969e" : opts.color || (LV ? LV.body : K.color);
    const windowColor = stale ? "#4a5158" : opts.night ? "#ffd877" : "#22303d";

    // Faces: [outward ground normal (fwd, rgt), corner list]. A vertical face is
    // visible when its normal points down the screen (towards the camera).
    const faces = [
      { n: [1, 0], q: [[L, -W], [L, W]], tone: -0.25, front: true },
      { n: [-1, 0], q: [[-L, W], [-L, -W]], tone: -0.3 },
      { n: [0, 1], q: [[L, W], [-L, W]], tone: -0.12, side: true },
      { n: [0, -1], q: [[-L, -W], [L, -W]], tone: -0.05, side: true },
    ];
    for (const f of faces) {
      const ny = fwd[1] * f.n[0] + rgt[1] * f.n[1];
      if (ny <= 0) continue;
      const [[f1, r1], [f2, r2]] = f.q;
      poly([P(f1, r1, 0), P(f2, r2, 0), P(f2, r2, H), P(f1, r1, H)], shade(base, f.tone));
      // windows: a dark band along the upper body; a full windscreen on the front
      const w0 = f.front ? 1.6 : 2.1, w1 = H - 0.6;
      const inset = f.side ? 0.8 : 0.5;
      const lerp = (t) => [f1 + (f2 - f1) * t, r1 + (r2 - r1) * t];
      const span = f.side ? K.length : K.width;
      const a = lerp(inset / span), b = lerp(1 - inset / span);
      if (LV) {
        // livery stripe along the lower body
        poly([P(f1, r1, 0.55), P(f2, r2, 0.55), P(f2, r2, 1.3), P(f1, r1, 1.3)], stale ? "#6b737b" : shade(LV.band, f.tone * 0.6));
      }
      poly([P(a[0], a[1], w0), P(b[0], b[1], w0), P(b[0], b[1], w1), P(a[0], a[1], w1)], windowColor);
      if (LV && f.front) {
        // route sign above the windscreen, headlights below it
        const s0 = lerp(0.18), s1 = lerp(0.82), c0 = lerp(0.36), c1 = lerp(0.64);
        poly([P(s0[0], s0[1], w1 + 0.1), P(s1[0], s1[1], w1 + 0.1), P(s1[0], s1[1], H - 0.1), P(s0[0], s0[1], H - 0.1)], "#1b1f24");
        poly([P(c0[0], c0[1], w1 + 0.2), P(c1[0], c1[1], w1 + 0.2), P(c1[0], c1[1], H - 0.2), P(c0[0], c0[1], H - 0.2)], "#ffb020");
        for (const [t0, t1] of [[0.08, 0.26], [0.74, 0.92]]) {
          const h0 = lerp(t0), h1 = lerp(t1);
          poly([P(h0[0], h0[1], 0.6), P(h1[0], h1[1], 0.6), P(h1[0], h1[1], 1.15), P(h0[0], h0[1], 1.15)], opts.night ? "#fffbe0" : "#fff3c4");
        }
      }
      if (LV && !f.front && !f.side) {
        // tail lights
        for (const [t0, t1] of [[0.06, 0.22], [0.78, 0.94]]) {
          const h0 = lerp(t0), h1 = lerp(t1);
          poly([P(h0[0], h0[1], 0.7), P(h1[0], h1[1], 0.7), P(h1[0], h1[1], 1.2), P(h0[0], h0[1], 1.2)], opts.night ? "#ff3b30" : "#c92a2a");
        }
      }
      if (LV && f.side && f.n[1] > 0) {
        // doors on the kerb (right-hand) side
        for (const t of [0.9, K.length / 2 - 0.6]) {
          const d0 = lerp(t / span), d1 = lerp((t + 1.2) / span);
          poly([P(d0[0], d0[1], 0.25), P(d1[0], d1[1], 0.25), P(d1[0], d1[1], w1), P(d0[0], d0[1], w1)], opts.night ? "#e8b84a" : "#3a4652");
        }
      }
      if (f.side) {
        // window pillars every ~2.5 m
        for (let t = 2.6; t < K.length - 1.2; t += 2.4) {
          const m = lerp(t / span);
          const m2 = lerp((t + 0.45) / span);
          poly([P(m[0], m[1], w0), P(m2[0], m2[1], w0), P(m2[0], m2[1], w1), P(m[0], m[1], w1)], shade(base, f.tone));
        }
        // wheels
        for (const t of [1.6, K.length - 2.8]) {
          const a2 = lerp(t / span), b2 = lerp((t + 1.2) / span);
          poly([P(a2[0], a2[1], -0.2), P(b2[0], b2[1], -0.2), P(b2[0], b2[1], 0.9), P(a2[0], a2[1], 0.9)], "#15191d");
        }
      }
    }
    // roof
    poly([P(L, -W, H), P(L, W, H), P(-L, W, H), P(-L, -W, H)], LV && !stale ? LV.roof : shade(base, 0.28));
    // roof unit (air conditioning / trolley gear)
    poly([P(1.2, -1.1, H + 0.5), P(1.2, 1.1, H + 0.5), P(-2.2, 1.1, H + 0.5), P(-2.2, -1.1, H + 0.5)], shade(base, 0.45));

    // Crisp pixel look: hard alpha, then a dark 1-pixel outline around the body.
    const img = c.getImageData(0, 0, size, size), d = img.data;
    const solid = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i++) solid[i] = d[i * 4 + 3] >= 110 ? 1 : 0;
    for (let i = 0; i < size * size; i++) d[i * 4 + 3] = solid[i] ? 255 : 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (solid[i]) continue;
      if ((x > 0 && solid[i - 1]) || (x < size - 1 && solid[i + 1]) || (y > 0 && solid[i - size]) || (y < size - 1 && solid[i + size])) {
        d[i * 4] = 24; d[i * 4 + 1] = 28; d[i * 4 + 2] = 34; d[i * 4 + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);

    // Trolley poles / tram pantograph: thin dark lines up to the overhead wires.
    c.strokeStyle = "#1b1f24"; c.lineWidth = 1;
    if (K.poles) {
      for (const r of [-0.8, 0.8]) {
        const a = P(-L + 3.0, r, H + 0.5), b = P(-L - 3.0, r, H + 3.2);
        c.beginPath(); c.moveTo(Math.round(a[0]) + 0.5, Math.round(a[1]) + 0.5); c.lineTo(Math.round(b[0]) + 0.5, Math.round(b[1]) + 0.5); c.stroke();
      }
    }
    if (K.pantograph) {
      const a = P(2, 0, H + 0.4), m = P(0.5, 0, H + 1.6), b = P(2, 0, H + 2.2);
      c.beginPath(); c.moveTo(...a); c.lineTo(...m); c.lineTo(...b); c.stroke();
    }

    // Soft ground shadow, drawn underneath.
    const out = document.createElement("canvas");
    out.width = out.height = size;
    const o = out.getContext("2d");
    o.fillStyle = "rgba(20,25,35,.28)";
    o.beginPath();
    const sh = [P(L + 0.4, -W - 0.3, 0), P(L + 0.4, W + 0.3, 0), P(-L - 0.4, W + 0.3, 0), P(-L - 0.4, -W - 0.3, 0)];
    o.moveTo(sh[0][0] + 1, sh[0][1] + 1); for (const p of sh.slice(1)) o.lineTo(p[0] + 1, p[1] + 1); o.closePath(); o.fill();
    o.drawImage(cv, 0, 0);
    return { canvas: out, cx, cy };
  }

  function spriteFor(kind, heading, stale, opts = {}) {
    const dir = Math.round(((heading % 360) + 360) % 360 / 11.25) % 32;
    const key = `${kind}|${dir}|${stale ? 1 : 0}|${opts.livery ? 1 : 0}|${opts.night ? 1 : 0}|${opts.color || ""}`;
    if (!sprites.has(key)) sprites.set(key, makeSprite(kind, dir * 11.25, stale, opts));
    return sprites.get(key);
  }

  // Screen angle of a ground heading (bearing), using the map's camera.
  function screenAngle(heading) {
    const B = groundBasis(), h = (heading * Math.PI) / 180;
    return Math.atan2(Math.sin(h) * B.east[1] + Math.cos(h) * B.north[1], Math.sin(h) * B.east[0] + Math.cos(h) * B.north[0]);
  }

  // Round line-number badge with a little pointer in the direction of travel.
  function drawBadge(sx, sy, v, heading, stale, dpr) {
    const K = KINDS[v.kind] || KINDS.bus;
    const r = 10 * dpr, x = sx * dpr, y = sy * dpr, a = screenAngle(heading);
    const fill = stale ? "#8d969e" : K.color;
    ctx.fillStyle = "rgba(20,25,35,.35)";
    ctx.beginPath(); ctx.arc(x + 1.5 * dpr, y + 2 * dpr, r + 1.5 * dpr, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#1b1f24";
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * (r + 7 * dpr), y + Math.sin(a) * (r + 7 * dpr));
    ctx.lineTo(x + Math.cos(a + 0.55) * (r + 1 * dpr), y + Math.sin(a + 0.55) * (r + 1 * dpr));
    ctx.lineTo(x + Math.cos(a - 0.55) * (r + 1 * dpr), y + Math.sin(a - 0.55) * (r + 1 * dpr));
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r + 1.5 * dpr, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill();
    ctx.lineWidth = 1 * dpr; ctx.strokeStyle = "#1b1f24"; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r - 0.5 * dpr, 0, 2 * Math.PI); ctx.fillStyle = fill; ctx.fill();
    const label = v.line || "?";
    ctx.font = `700 ${Math.round((label.length > 2 ? 8.5 : 10.5) * dpr)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = v.kind === "trolley" && !stale ? "#000" : "#fff";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 0.5 * dpr);
  }

  // Headlight glow on the road ahead (night liveries).
  function drawGlow(sx, sy, heading, px, dpr) {
    const a = screenAngle(heading), d = 9 / ART_M * px;
    const gx = (sx + Math.cos(a) * d) * dpr, gy = (sy + Math.sin(a) * d) * dpr, r = 7 / ART_M * px * dpr;
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, "rgba(255,236,170,.55)"); g.addColorStop(1, "rgba(255,236,170,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, r, 0, 2 * Math.PI); ctx.fill();
  }

  // ---------- polling ----------

  function slippyTiles(z) {
    const [la0, lo0, la1, lo1] = geo.bbox, n = 2 ** z;
    const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat) => { const r = (lat * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
    const out = [];
    for (let x = tx(lo0); x <= tx(lo1); x++)
      for (let y = ty(la1); y <= ty(la0); y++) out.push(`${API}/v1/vehicles/tiles/${z}/${x}/${y}`);
    return out;
  }
  const toMs = (t) => (t == null ? null : typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t));
  const kindOf = (line) => (lines[line] && lines[line].kind) || (/^\d{1,2}[A-ZΑ-Ω]?$/.test(line || "") ? "trolley" : "bus");

  async function poll() {
    timer = null;
    if (!on) return;
    if (!mapItem || !info) { timer = setTimeout(poll, 2000); return; }
    if (!geo || !info.origin_px || !groundBasis()) {
      setStatus("Live transit is being set up for this map. Check back soon.");
      return;
    }
    let urls = slippyTiles(13);
    if (urls.length > 6) urls = [`${API}/v1/vehicles`];
    let list = [], nextAt = null;
    try {
      const res = await Promise.all(urls.map((u) => fetch(u)));
      for (const r of res) {
        if (r.status === 429) throw Object.assign(new Error("busy"), { wait: 15000 });
        if (r.status === 503) throw Object.assign(new Error("warming up"), { wait: 30000 });
        if (r.status === 404) continue;
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        list = list.concat(d.vehicles || []);
        const n = toMs(d.next_update_at);
        if (n && (!nextAt || n < nextAt)) nextAt = n;
      }
    } catch (e) {
      setStatus(`Live data unavailable (${e.message}), retrying…`);
      if (on) timer = setTimeout(poll, e.wait || 30000);
      return;
    }

    const now = Date.now(), nowS = now / 1000, seen = new Set();
    for (const raw of list) {
      if (seen.has(raw.id) || raw.lat == null || raw.lon == null) continue;
      if (!toImagePx(raw.lat, raw.lon)) continue;
      seen.add(raw.id);
      const old = vehicles.get(raw.id);
      // Remember where it is drawn right now, to ease into the corrected position.
      const shown = old ? currentPose(old, now) : null;
      vehicles.set(raw.id, {
        id: raw.id, line: raw.line || "", kind: kindOf(raw.line),
        lat: raw.lat, lon: raw.lon, positionAt: raw.position_at || nowS,
        bearing: raw.bearing, speed: raw.speed || 0, delay: raw.delay_s,
        path: Array.isArray(raw.path) ? raw.path : null,
        lastHeading: shown ? shown.heading : raw.bearing,
        from: shown, fromAt: now,
      });
    }
    for (const id of [...vehicles.keys()]) if (!seen.has(id)) vehicles.delete(id);
    const nb = [...vehicles.values()].filter((v) => v.kind === "bus").length;
    const nt = vehicles.size - nb;
    setStatus(vehicles.size ? `${nb} buses · ${nt} trolleys on the map · live` : "No buses or trolleys on the map right now");

    const wait = Math.max(10000, Math.min(60000, (nextAt || now + 15000) - now + 1000));
    if (on) timer = setTimeout(poll, wait);
  }

  // ---------- drawing ----------

  function currentPose(v, now) {
    const est = estimate(v, now / 1000);
    const p = toImagePx(est.pos[0], est.pos[1]);
    if (!p) return v.from || null;
    let x = p[0], y = p[1], heading = est.heading;
    if (v.from && now - v.fromAt < BLEND_MS) {
      const t = (now - v.fromAt) / BLEND_MS, s = t * t * (3 - 2 * t);
      x = v.from.x + (x - v.from.x) * s;
      y = v.from.y + (y - v.from.y) * s;
      let dh = ((heading - v.from.heading + 540) % 360) - 180;
      heading = (v.from.heading + dh * s + 360) % 360;
    }
    return { x, y, heading };
  }

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  }
  window.addEventListener("resize", resize);

  let hover = null;
  const drawn = []; // [screenX, screenY, vehicle] for hover lookup

  function frame() {
    requestAnimationFrame(frame);
    { const r = canvas.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) resize(); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn.length = 0;
    if (!on || !mapItem || !geo || !vehicles.size) return;

    const dpr = window.devicePixelRatio || 1;
    const OSD = OpenSeadragon;
    const s0 = mapItem.imageToViewerElementCoordinates(new OSD.Point(0, 0));
    const s1 = mapItem.imageToViewerElementCoordinates(new OSD.Point(1000, 0));
    const scale = (s1.x - s0.x) / 1000;                 // screen px per image px
    const px = Math.max(MIN_ART_PX, (ART_M / MPP) * scale); // screen px per sprite px
    ctx.imageSmoothingEnabled = false;

    const now = Date.now(), nowS = now / 1000;
    const items = [];
    for (const v of vehicles.values()) {
      const pose = currentPose(v, now);
      if (!pose) continue;
      v.lastHeading = pose.heading;
      const sp = mapItem.imageToViewerElementCoordinates(new OSD.Point(pose.x, pose.y));
      items.push({ v, pose, sx: sp.x, sy: sp.y });
    }
    items.sort((a, b) => a.sy - b.sy);
    const night = isNight() && (STYLE === "livery" || STYLE === "hybrid");
    if (night) {
      // Dusk tint over the map, so lit windows and headlights read as night.
      ctx.fillStyle = "rgba(12,22,52,.48)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    for (const { v, pose, sx, sy } of items) {
      const stale = nowS - v.positionAt > STALE_S;
      const K = KINDS[v.kind] || KINDS.bus;
      const asBadge = STYLE === "badges" || (STYLE === "hybrid" && px < 2);
      if (asBadge) {
        drawBadge(sx, sy, v, pose.heading, stale, dpr);
        drawn.push([sx, sy, v]);
        continue;
      }
      const livery = STYLE === "livery" || STYLE === "hybrid";
      const opts = { livery, night, color: STYLE === "delay" ? delayColor(v.delay) : null };
      const spr = spriteFor(v.kind, pose.heading, stale, opts);
      const moving = !stale && v.speed > 0.5 && nowS - v.positionAt < EXTRAPOLATE_MAX_S;
      const bob = moving && Math.floor(now / 380 + v.id.length) % 2 ? px : 0; // a little engine bounce
      if (opts.night && !stale) drawGlow(sx, sy, pose.heading, px, dpr);
      const w = spr.canvas.width * px;
      const x = Math.round((sx - spr.cx * px) * dpr), y = Math.round((sy - spr.cy * px - bob) * dpr);
      ctx.drawImage(spr.canvas, x, y, Math.round(w * dpr), Math.round(w * dpr));
      drawn.push([sx, sy - (K.height * 0.35 / ART_M) * px, v]);

      // Line number tag above the vehicle once there's room for it.
      if (px >= 2 || hover === v) {
        const label = v.line;
        const ty = sy - (K.height / ART_M + 6) * px;
        ctx.font = `700 ${Math.round(11 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
        const tw = ctx.measureText(label).width + 8 * dpr;
        ctx.fillStyle = stale ? "#8d969e" : STYLE === "delay" ? delayColor(v.delay) : K.color;
        ctx.fillRect(Math.round(sx * dpr - tw / 2), Math.round(ty * dpr - 9 * dpr), Math.round(tw), Math.round(15 * dpr));
        ctx.fillStyle = v.kind === "trolley" && STYLE !== "delay" ? "#000" : "#fff";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(label, sx * dpr, ty * dpr - 1.5 * dpr);
      }
    }
  }
  requestAnimationFrame(frame);

  // Hover: nearest vehicle within 18 px shows its details.
  document.getElementById("map").addEventListener("mousemove", (e) => {
    if (!on) return;
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 18;
    for (const [x, y, v] of drawn) { const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = v; } }
    hover = best;
    if (!best) { tip.style.display = "none"; return; }
    const age = Math.round(Date.now() / 1000 - best.positionAt);
    const delay = best.delay == null ? "" : best.delay >= 60 ? ` · ${Math.round(best.delay / 60)} min late`
      : best.delay <= -60 ? ` · ${Math.round(-best.delay / 60)} min early` : " · on time";
    const name = lines[best.line] && lines[best.line].name ? `<br>${lines[best.line].name}` : "";
    const kindName = { bus: "Bus", trolley: "Trolley", tram: "Tram" }[best.kind];
    tip.innerHTML = `<b>${kindName} ${best.line}</b>${delay}${name}<br><span>vehicle ${best.id} · GPS ${age} s ago</span>`;
    tip.style.left = e.clientX + 14 + "px"; tip.style.top = e.clientY + 14 + "px"; tip.style.display = "block";
  });

  // Small hook for tests and for the browser console.
  window.tinyTransit = { makeSprite, vehicles, toImagePx, STYLE };

  btn.onclick = () => {
    on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", on);
    clearTimeout(timer);
    tip.style.display = "none";
    if (on) { setStatus("Loading live buses and trolleys…"); poll(); }
    else { statusEl.style.display = "none"; vehicles.clear(); }
  };

  if (params.get("transit") === "1") setTimeout(() => btn.click(), 300 + Math.random() * 4000);
})();
