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
  // Zoom behaviour: true scale when zoomed in; zoomed out they shrink with the map but
  // never below MIN_PX screen px per sprite pixel (a bus stays ~12 px long).
  const MIN_PX = 0.6;
  const EXTRAPOLATE_MAX_S = 45; // stop driving ahead this long after the last GPS fix
  const BLEND_MS = 1500;        // ease into a corrected position when a new fix arrives
  const STALE_S = 120;

  // Toy proportions (like vehicles in pixel-art city games): a bit shorter, much
  // wider and taller than real, so they read as buses rather than sticks.
  const KINDS = {
    bus:     { color: "#153ce0", length: 10, width: 4.2, height: 4.4, poles: false },
    trolley: { color: "#f19a1e", length: 10, width: 4.2, height: 4.4, poles: true },
    // Lengths relative to a bus: tram 5 buses (Citadis, 5 sections), Line 1 train 8 buses (5 cars).
    tram:    { color: "#f07c1c", length: 50, width: 4.2, height: 4.6, poles: false, pantograph: true, cars: 5 },
    metro:   { color: "#2fb34a", length: 80, width: 4.4, height: 4.8, poles: false, pantograph: false, cars: 5 }, // third rail
  };

  // Display style (also selectable with ?style=… for the comparison page):
  //   boxes   plain coloured vehicles (blue bus, orange trolley)
  //   livery  Athens liveries with headlights, doors and route sign; lit up at night
  //   badges  round line-number badges with a direction pointer
  //   hybrid  badges when zoomed out, livery vehicles when zoomed in
  //   delay   vehicles coloured by punctuality
  const params = new URLSearchParams(location.search);
  const STYLE = params.get("style") || "livery";
  const FORCE_NIGHT = params.get("night") === "1";
  // Darkened map after sunset: on by default, the 🌙 button (shown only at night) turns it
  // off. Vehicle lights stay on either way. The choice is remembered in this browser.
  let darkMap = params.get("dark") !== "0";
  try { if (localStorage.getItem("tinyathens.darkMap") === "0") darkMap = false; } catch (e) {}
  const LIVERY = {
    // ΕΘΕΛ livery: white with dark-blue, yellow and sky-blue diagonal blocks, grey skirt
    bus:     { body: "#f7f8fa", band: "#1f3f9a", roof: "#e3e7eb", ethel: true },
    trolley: { body: "#f6b01e", band: "#c94f0c", roof: "#fbd27a" },
    // Athens tram (Alstom Citadis): orange, deep black window band, black cab fronts
    tram:    { body: "#f07c1c", band: "#16191d", roof: "#f39a4c", citadis: true },
    // Line 1 (refurbished CAF cars): brushed steel, bright green doors, skirt, roof line and cab front
    metro:   { body: "#b9bec2", band: "#33b94b", roof: "#d4d8db", isap: true },
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
  let follow = null;          // { line, kind, color, segs, stops } - the line picked by tapping a vehicle
  let me = null;              // { x, y, acc } - the viewer's own position (📍), image pixels
  let weather = null;         // "rain" | "storm" | null
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
    if (params.get("line")) setFollow(params.get("line"));
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
    if (v.knots && v.knots.length) {
      // Rail: [metres along path, unix time] pairs from the timetable (stops at stations included).
      const k = v.knots;
      let d = k[k.length - 1][0];
      if (nowS <= k[0][1]) d = k[0][0];
      else for (let i = 0; i + 1 < k.length; i++)
        if (nowS <= k[i + 1][1]) { const t = (nowS - k[i][1]) / Math.max(1, k[i + 1][1] - k[i][1]); d = k[i][0] + (k[i + 1][0] - k[i][0]) * t; break; }
      return along(pts, d, v.bearing ?? v.lastHeading ?? 0);
    }
    const dt = Math.max(0, Math.min(EXTRAPOLATE_MAX_S, nowS - v.positionAt));
    const d = v.speed ? v.speed * dt : 0;
    return along(pts, d, v.bearing ?? v.lastHeading ?? 0);
  }

  // Line 1 is in the open from Piraeus through Thissio to Monastiraki, then runs in a
  // tunnel under Athinas St. to Omonia and Attiki. Monastiraki station's east end is about
  // 23.7258 E; everything past it in the centre is underground.
  function underground([lat, lon]) {
    return lon > 23.7258 && lat > 37.9745 && lat < 38.005;
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
    const ETH = { blue: "#1f3f9a", yellow: "#f7b51c", sky: "#4db6e8", white: "#f7f8fa", skirt: "#b6bcc3" };

    // Fill a face region (f, r, z quad) with slanted colour blocks, clipped to the region.
    function blocks(quad, blockList) {
      c.save();
      c.beginPath(); c.moveTo(...quad[0]); for (const p of quad.slice(1)) c.lineTo(...p); c.closePath(); c.clip();
      for (const [corners, col] of blockList) poly(corners, col);
      c.restore();
    }
    // ΕΘΕΛ livery on one face: grey skirt, then diagonal blocks up to the windows.
    function ethel(face, tone) {
      const t = (col) => (stale ? shade("#8d969e", tone) : shade(col, tone * 0.6));
      const z0 = 0.35, z1 = face.front ? 1.6 : 2.6;
      const [[fa, ra], [fb, rb]] = face.q;
      poly([P(fa, ra, 0), P(fb, rb, 0), P(fb, rb, z0), P(fa, ra, z0)], t(ETH.skirt));
      const quad = [P(fa, ra, z0), P(fb, rb, z0), P(fb, rb, z1), P(fa, ra, z1)];
      if (face.side) {
        // blocks along the length, leaning towards the front (from the rear: yellow, blue, sky, yellow, blue)
        const r = ra, sl = 1.0, Lh = L;
        const seq = [[-Lh - 2, -Lh + 1.4, ETH.yellow], [-Lh + 1.4, -Lh + 3.6, ETH.blue], [-Lh + 4.3, -Lh + 6.1, ETH.sky],
                     [-Lh + 6.1, -Lh + 7.3, ETH.yellow], [-Lh + 7.3, Lh + 2, ETH.blue]];
        blocks(quad, seq.map(([a, b, col]) => [[P(a, r, z0), P(b, r, z0), P(b + sl, r, z1), P(a + sl, r, z1)], t(col)]));
      } else {
        // across the front / back
        const f = fa, sl = 0.7;
        const seq = face.front
          ? [[-W - 2, -0.35, ETH.blue], [-0.35, 0.45, ETH.yellow], [0.45, W + 2, ETH.sky]]
          : [[-0.7, 0.5, ETH.yellow], [0.5, W + 2, ETH.blue]];
        blocks(quad, seq.map(([a, b, col]) => [[P(f, a, z0), P(f, b, z0), P(f, b + sl, z1), P(f, a + sl, z1)], t(col)]));
      }
    }

    // Line 1 car face: steel body (already painted), green trim, doors, windows; cab ends all green.
    function isapFace(face, lerp, span, w1) {
      const G = stale ? "#7d858c" : shade(LV.band, face.tone * 0.5);
      const dark = "#1b2128";
      const q = (ma, mb, z0, z1, col) => {
        const A = lerp(ma / span), B = lerp(mb / span);
        poly([P(A[0], A[1], z0), P(B[0], B[1], z0), P(B[0], B[1], z1), P(A[0], A[1], z1)], col);
      };
      if (face.side) {
        q(0, span, 0.15, 0.75, G);                       // green skirt
        q(0, span, H - 0.5, H - 0.15, G);                // green roof-edge line
        q(0.4, span - 0.4, 2.2, H - 0.85, windowColor);  // window band
        const n = K.cars || 2, cl = span / n;
        for (let k = 0; k < n; k++) {
          const c0 = k * cl;
          for (const t of [cl * 0.18, cl * 0.62]) {      // two green doors per car side, with windows
            q(c0 + t, c0 + t + 1.5, 0.75, H - 0.5, G);
            q(c0 + t + 0.3, c0 + t + 1.2, 2.3, H - 0.95, windowColor);
          }
          if (k) q(c0 - 0.25, c0 + 0.25, 0.1, H - 0.1, dark);           // gap between cars
          for (const t of [1.2, cl - 2.6]) q(c0 + t, c0 + t + 1.4, -0.2, 0.55, "#15191d");  // bogies
        }
      } else {
        q(0, span, 0, H, G);                              // green cab front
        q(0, span, 0, 0.5, "#5d6368");                   // grey coupler area
        q(0.4, span - 0.4, 1.95, H - 0.35, dark);        // windscreen
        q(0.4, span - 0.4, 0.75, 1.5, dark);             // black headlight panel
        const lamp = face.front ? (opts.night ? "#fffbe0" : "#e9eef2") : opts.night ? "#ff3b30" : "#c92a2a";
        q(0.6, 1.3, 0.9, 1.35, lamp); q(span - 1.3, span - 0.6, 0.9, 1.35, lamp);
        if (face.front) q(0.9, span - 0.9, H - 0.75, H - 0.45, "#ffb020");   // destination display
      }
    }

    // Citadis tram face: orange body (already painted), deep black glazing, dark section joints.
    function citadisFace(face, lerp, span) {
      const dark = stale ? "#3a4047" : "#16191d";
      const glass = opts.night && !stale ? "#ffd877" : dark;
      const q = (ma, mb, z0, z1, col) => {
        const A = lerp(ma / span), B = lerp(mb / span);
        poly([P(A[0], A[1], z0), P(B[0], B[1], z0), P(B[0], B[1], z1), P(A[0], A[1], z1)], col);
      };
      if (face.side) {
        const n = K.cars || 5, cl = span / n;
        q(0.6, span - 0.6, 1.35, H - 0.55, glass);       // one long window band
        for (let k = 0; k < n; k++) {
          const c0 = k * cl;
          q(c0 + cl * 0.35, c0 + cl * 0.35 + 1.4, 0.35, H - 0.55, dark);   // glazed doors down to the floor
          if (opts.night && !stale) q(c0 + cl * 0.35 + 0.25, c0 + cl * 0.35 + 1.15, 1.35, H - 0.75, "#ffd877");
          if (k) q(c0 - 0.3, c0 + 0.3, 0.2, H - 0.1, dark);                 // joint between sections
        }
        for (let k = 0; k <= n; k += 1) {                                   // bogies under the joints
          const t = Math.min(span - 1.6, Math.max(0.4, k * cl - 0.7));
          q(t, t + 1.4, -0.2, 0.5, "#111417");
        }
      } else {
        q(0, span, 0.4, H - 0.25, dark);                 // black cab front
        q(0.3, span - 0.3, 1.5, H - 0.45, "#232930");    // windscreen
        const lamp = face.front ? (opts.night ? "#fffbe0" : "#e9eef2") : opts.night ? "#ff3b30" : "#c92a2a";
        q(0.4, 1.0, 0.75, 1.15, lamp); q(span - 1.0, span - 0.4, 0.75, 1.15, lamp);
        if (face.front) q(0.8, span - 0.8, H - 0.6, H - 0.35, "#ffb020");   // destination display
      }
    }

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
      const w0 = f.front ? 1.6 : LV && LV.ethel ? 2.6 : 2.1, w1 = H - 0.6;
      const inset = f.side ? 0.8 : 0.5;
      const lerp = (t) => [f1 + (f2 - f1) * t, r1 + (r2 - r1) * t];
      const span = f.side ? K.length : K.width;
      const a = lerp(inset / span), b = lerp(1 - inset / span);
      if (LV && LV.isap) { isapFace(f, lerp, span, w1); continue; }
      if (LV && LV.citadis) { citadisFace(f, lerp, span); continue; }
      if (LV && LV.ethel) ethel(f, f.tone);
      else if (LV) {
        // livery stripe along the lower body
        poly([P(f1, r1, 0.55), P(f2, r2, 0.55), P(f2, r2, 1.3), P(f1, r1, 1.3)], stale ? "#6b737b" : shade(LV.band, f.tone * 0.6));
      }
      poly([P(a[0], a[1], w0), P(b[0], b[1], w0), P(b[0], b[1], w1), P(a[0], a[1], w1)], windowColor);
      if (LV && f.front) {
        // route sign above the windscreen, headlights below it
        const s0 = lerp(0.18), s1 = lerp(0.82), c0 = lerp(0.36), c1 = lerp(0.64);
        poly([P(s0[0], s0[1], w1 + 0.1), P(s1[0], s1[1], w1 + 0.1), P(s1[0], s1[1], H - 0.1), P(s0[0], s0[1], H - 0.1)], "#1b1f24");
        poly([P(c0[0], c0[1], w1 + 0.2), P(c1[0], c1[1], w1 + 0.2), P(c1[0], c1[1], H - 0.2), P(c0[0], c0[1], H - 0.2)], LV.ethel ? "#4be06a" : "#ffb020");
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
    if (LV && (LV.isap || LV.citadis)) {
      // cars / sections: a dark joint across the roof, roof equipment on each
      const n = K.cars || 2, cl = K.length / n;
      for (let k = 0; k < n; k++) {
        const c0 = -L + k * cl;
        if (k) poly([P(c0 + 0.25, -W, H), P(c0 + 0.25, W, H), P(c0 - 0.25, W, H), P(c0 - 0.25, -W, H)], "#1b2128");
        const m = c0 + cl * (LV.isap ? 0.25 : 0.3), len = LV.isap ? 1.5 : cl * 0.4;
        poly([P(m + len, -1.0, H + 0.45), P(m + len, 1.0, H + 0.45), P(m, 1.0, H + 0.45), P(m, -1.0, H + 0.45)], LV.isap ? "#8e959b" : "#9aa1a7");
      }
    } else {
      // roof unit (air conditioning / trolley gear)
      poly([P(1.2, -1.1, H + 0.5), P(1.2, 1.1, H + 0.5), P(-2.2, 1.1, H + 0.5), P(-2.2, -1.1, H + 0.5)], shade(base, 0.45));
    }

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

  // Overview dot when zoomed far out: dark blue bus, orange trolley, grey if stale.
  function drawDot(sx, sy, v, stale, dpr) {
    const col = stale ? "#8d969e" : v.kind === "trolley" ? "#f19a1e" : v.kind === "tram" ? "#2e9e48" : "#1f3f9a";
    const x = Math.round(sx * dpr), y = Math.round(sy * dpr), r = 3.5 * dpr;
    ctx.beginPath(); ctx.arc(x, y, r + 1.5 * dpr, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill();
    ctx.lineWidth = 1 * dpr; ctx.strokeStyle = "rgba(20,25,35,.8)"; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
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
  const kindOf = (line) => (/^T\d/.test(line || "") ? "tram" : /^M\d/.test(line || "") ? "metro" : null) ||
    (lines[line] && lines[line].kind) || (/^\d{1,2}[A-ZΑ-Ω]?$/.test(line || "") ? "trolley" : "bus");

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
      const [res, rail] = await Promise.all([
        Promise.all(urls.map((u) => fetch(u))),
        fetch(`${API}/v2/vehicles/rail`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      // Metro Line 1 (open-air through Thissio-Monastiraki) and the trams. Lines 2 and 3
      // run underground in the centre, so they aren't drawn on the streets.
      for (const t of (rail && rail.vehicles) || []) {
        const line = String(t.line || "").replace(/^stasy:/, "");
        const pos = t.position || {}, mo = t.motion || {};
        if (!(t.mode === "tram" || line === "M1") || pos.lat == null) continue;
        list.push({ id: t.id, line, lat: pos.lat, lon: pos.lon, bearing: pos.bearing, position_at: pos.at,
          speed: 6, delay_s: t.delay_s, headsign: t.headsign,
          path: [...(mo.path || []), ...((mo.path_beyond || []).slice(1))], knots: mo.knots || null });
      }
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
      if (!raw.knots) recordTrail(raw, nowS);
      // Remember where it is drawn right now, to ease into the corrected position.
      const shown = old ? currentPose(old, now) : null;
      vehicles.set(raw.id, {
        id: raw.id, line: raw.line || "", kind: kindOf(raw.line),
        lat: raw.lat, lon: raw.lon, positionAt: raw.position_at || nowS,
        bearing: raw.bearing, speed: raw.speed || 0, delay: raw.delay_s,
        path: Array.isArray(raw.path) ? raw.path : null,
        knots: raw.knots || null, headsign: raw.headsign || null,
        lastHeading: shown ? shown.heading : raw.bearing,
        from: shown, fromAt: now,
      });
    }
    for (const id of [...vehicles.keys()]) if (!seen.has(id)) vehicles.delete(id);
    const count = (k) => [...vehicles.values()].filter((v) => v.kind === k).length;
    const nb = count("bus"), nt = count("trolley"), nr = count("tram") + count("metro");
    if (follow) renderFollow();
    setStatus(vehicles.size ? `${nb} buses · ${nt} trolleys${nr ? ` · ${nr} ${nr === 1 ? "train/tram" : "trains & trams"}` : ""} on the map · live` : "No buses or trolleys on the map right now");

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
    if (!mapItem || !geo || !info) return;

    const dpr = window.devicePixelRatio || 1;
    const OSD = OpenSeadragon;
    const s0 = mapItem.imageToViewerElementCoordinates(new OSD.Point(0, 0));
    const s1 = mapItem.imageToViewerElementCoordinates(new OSD.Point(1000, 0));
    const scale = (s1.x - s0.x) / 1000;                 // screen px per image px
    const pxTrue = (ART_M / MPP) * scale;              // screen px per sprite px at true map scale
    const px = Math.max(MIN_PX, pxTrue);

    const now = Date.now(), nowS = now / 1000;
    const toS = (x, y) => [s0.x + x * scale, s0.y + y * scale]; // image px -> screen px
    const items = [];
    for (const v of (on ? vehicles.values() : [])) {
      if (v.kind === "metro" && underground(estimate(v, nowS).pos)) continue;
      const pose = currentPose(v, now);
      if (!pose) continue;
      v.lastHeading = pose.heading;
      const sp = mapItem.imageToViewerElementCoordinates(new OSD.Point(pose.x, pose.y));
      items.push({ v, pose, sx: sp.x, sy: sp.y });
    }
    items.sort((a, b) => a.sy - b.sy);
    const night = isNight() && (STYLE === "livery" || STYLE === "hybrid");
    if (btnDark && btnDark.hidden === night) btnDark.hidden = !night;
    if (night && darkMap && on) {
      // Dusk tint over the map, so lit windows and headlights read as night.
      ctx.fillStyle = "rgba(12,22,52,.48)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (weather) {
      // Overcast: a cool grey veil under the rain.
      ctx.fillStyle = weather === "storm" ? "rgba(40,48,62,.32)" : "rgba(60,72,90,.22)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (heatOn && on) drawHeat(toS, scale, dpr, nowS);
    if (follow && on) drawRoute(toS, dpr, px);
    for (const { v, pose, sx, sy } of items) {
      const dim = follow && v.line !== follow.line;
      ctx.globalAlpha = dim ? 0.3 : 1;
      const stale = nowS - v.positionAt > STALE_S;
      const K = KINDS[v.kind] || KINDS.bus;
      // Zoomed out, every vehicle stops shrinking at a minimum length: 12 px for a bus, and
      // only a little more for long ones (sqrt), so a train doesn't stay 8 buses' worth of huge.
      const minLen = 12 * Math.sqrt(K.length / 10);
      const vpx = Math.max(pxTrue, (minLen * ART_M) / K.length);
      ctx.imageSmoothingEnabled = vpx < 1;              // crisp when big, smooth when shrunk
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
      const bob = moving && vpx >= 1 && Math.floor(now / 380 + v.id.length) % 2 ? vpx : 0; // a little engine bounce
      if (opts.night && !stale && vpx >= 0.8) drawGlow(sx, sy, pose.heading, vpx, dpr);
      const w = spr.canvas.width * vpx;
      const x = Math.round((sx - spr.cx * vpx) * dpr), y = Math.round((sy - spr.cy * vpx - bob) * dpr);
      ctx.drawImage(spr.canvas, x, y, Math.round(w * dpr), Math.round(w * dpr));
      drawn.push([sx, sy - (K.height * 0.35 / ART_M) * vpx, v]);

      // Line number tag above the vehicle once there's room for it.
      if (!dim && (px >= 2 || hover === v || follow)) {
        const label = v.line;
        const ty = sy - (K.height / ART_M + 6) * vpx;
        ctx.font = `700 ${Math.round(11 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
        const tw = ctx.measureText(label).width + 8 * dpr;
        ctx.fillStyle = stale ? "#8d969e" : STYLE === "delay" ? delayColor(v.delay) : K.color;
        ctx.fillRect(Math.round(sx * dpr - tw / 2), Math.round(ty * dpr - 9 * dpr), Math.round(tw), Math.round(15 * dpr));
        ctx.fillStyle = v.kind === "trolley" && STYLE !== "delay" ? "#000" : "#fff";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(label, sx * dpr, ty * dpr - 1.5 * dpr);
      }
    }
    ctx.globalAlpha = 1;
    if (me) drawMe(toS, scale, dpr, now);
    if (weather) drawRain(dpr, now);
  }
  requestAnimationFrame(frame);

  // ---------- traffic heatmap: how fast buses actually moved, last 15 minutes ----------

  const HEAT_WINDOW_S = 15 * 60;
  const trails = new Map();   // vehicle id -> [{x, y, t}] (image px, unix s)
  const heatSegs = [];        // {x0, y0, x1, y1, kmh, t}
  let heatOn = false, heatSince = null;
  const btnHeat = document.getElementById("btn-heat");
  const legend = document.createElement("div");
  legend.className = "follow heat-legend"; legend.hidden = true;
  document.querySelector(".top").appendChild(legend);

  function recordTrail(raw, nowS) {
    const t = raw.position_at || nowS, p = toImagePx(raw.lat, raw.lon);
    if (!p) return;
    if (heatSince == null) heatSince = nowS;
    const tr = trails.get(raw.id) || [];
    const last = tr[tr.length - 1];
    if (last && t <= last.t) return;               // same fix as before
    if (last) {
      const dt = t - last.t, dM = Math.hypot(p[0] - last.x, p[1] - last.y) * MPP;
      // Measured speed between two fixes, stops at lights and bus stops included: that's the
      // real pace on that street. Skip gaps and jumps that can't be one stretch of street.
      if (dt >= 5 && dt <= 150 && dM < 1500) heatSegs.push({ x0: last.x, y0: last.y, x1: p[0], y1: p[1], kmh: (dM / dt) * 3.6, t });
    }
    tr.push({ x: p[0], y: p[1], t });
    if (tr.length > 80) tr.shift();
    trails.set(raw.id, tr);
    const cut = nowS - HEAT_WINDOW_S;
    while (heatSegs.length && heatSegs[0].t < cut) heatSegs.shift();
  }
  const heatColor = (kmh) => kmh < 8 ? "#d7263d" : kmh < 15 ? "#f46d1b" : kmh < 25 ? "#f2c12e" : "#3aa655";

  function drawHeat(toS, scale, dpr, nowS) {
    const w = Math.max(5, (22 / MPP) * scale) * dpr;   // about a 22 m wide band, at least 5 px
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = w;
    for (const g of heatSegs) {
      const age = (nowS - g.t) / HEAT_WINDOW_S;
      ctx.globalAlpha = 0.6 * (1 - 0.6 * age);         // older readings fade
      ctx.strokeStyle = heatColor(g.kmh);
      const [a, b] = toS(g.x0, g.y0), [c, d] = toS(g.x1, g.y1);
      ctx.beginPath(); ctx.moveTo(a * dpr, b * dpr); ctx.lineTo(c * dpr, d * dpr); ctx.stroke();
    }
    // Buses with a single reading so far: a spot at their reported speed.
    for (const v of vehicles.values()) {
      if (v.knots || (trails.get(v.id) || []).length > 1) continue;
      const p = toImagePx(v.lat, v.lon); if (!p) continue;
      const [a, b] = toS(p[0], p[1]);
      ctx.globalAlpha = 0.45; ctx.fillStyle = heatColor((v.speed || 0) * 3.6);
      ctx.beginPath(); ctx.arc(a * dpr, b * dpr, w / 2, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!legend.hidden && Math.floor(nowS) % 5 === 0) renderLegend(nowS);
  }
  function renderLegend(nowS) {
    const mins = heatSince == null ? 0 : Math.floor((nowS - heatSince) / 60);
    const sw = (c) => `<i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${c};margin:0 3px 0 8px;vertical-align:-1px"></i>`;
    legend.innerHTML = `<div><b>Bus speed on each street</b><br>` +
      `${sw("#d7263d")}&lt;8 ${sw("#f46d1b")}8–15 ${sw("#f2c12e")}15–25 ${sw("#3aa655")}25+ km/h<br>` +
      `<span>${mins < 15 ? `Collecting since the page opened (${mins} min), fills in over 15 min` : "Last 15 minutes"}</span></div>` +
      `<button aria-label="Hide speeds">✕</button>`;
    legend.querySelector("button").onclick = () => setHeat(false);
  }
  function setHeat(onNow) {
    heatOn = onNow;
    if (btnHeat) btnHeat.setAttribute("aria-pressed", heatOn);
    legend.hidden = !heatOn;
    if (heatOn) renderLegend(Date.now() / 1000);
  }
  if (btnHeat) btnHeat.onclick = () => setHeat(!heatOn);
  if (params.get("heat") === "1") setHeat(true);

  // ---------- follow a line ----------

  const STATIC = "https://angelospk.github.io/athens-transit-rt/static/v1";
  const lineCache = new Map();
  const followEl = document.createElement("div");
  followEl.className = "follow"; followEl.hidden = true;
  document.querySelector(".top").appendChild(followEl);

  function lineColor(line, kind) {
    const c = lines[line] && lines[line].color;
    return c ? (c[0] === "#" ? c : "#" + c) : (KINDS[kind] || KINDS.bus).color;
  }
  function renderFollow() {
    if (!follow) { followEl.hidden = true; return; }
    const n = [...vehicles.values()].filter((v) => v.line === follow.line).length;
    const kindName = { bus: "Bus", trolley: "Trolley", tram: "Tram", metro: "Metro" }[follow.kind] || "Line";
    const name = lines[follow.line] && lines[follow.line].name;
    const count = !on ? "" : n ? ` · ${n} on the map` : " · none on the map right now";
    followEl.style.setProperty("--line", follow.color);
    followEl.innerHTML = `<div><b>${kindName} ${follow.line}</b>${count}${name ? `<br><span>${name}</span>` : ""}</div>` +
      `<button aria-label="Stop following">✕</button>`;
    followEl.querySelector("button").onclick = () => setFollow(null);
    followEl.hidden = false;
  }
  async function setFollow(line) {
    if (!line) { follow = null; renderFollow(); window.setParam && setParam("line", null); return; }
    if (follow && follow.line === line) return;
    const kind = kindOf(line);
    follow = { line, kind, color: lineColor(line, kind), segs: [], stops: [] };
    window.setParam && setParam("line", line);
    renderFollow();
    let L = lineCache.get(line);
    if (L === undefined) {
      L = await fetch(`${STATIC}/lines/${encodeURIComponent(line)}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      lineCache.set(line, L);
    }
    if (!follow || follow.line !== line || !L || !L.variants || !geo || !info) return;
    // Every variant of the line (both directions, short runs), cut where it leaves the map.
    const segs = [], stopIds = new Set();
    for (const va of Object.values(L.variants)) {
      let cur = [];
      for (const [la, lo] of va.shape || []) {
        const p = toImagePx(la, lo);
        if (p) cur.push(p); else if (cur.length) { if (cur.length > 1) segs.push(cur); cur = []; }
      }
      if (cur.length > 1) segs.push(cur);
      for (const id of va.stops || []) stopIds.add(id);
    }
    const stops = [];
    for (const id of stopIds) {
      const st = L.stops && L.stops[id];
      const p = st && toImagePx(st.lat, st.lon);
      if (p) stops.push(p);
    }
    follow.segs = segs; follow.stops = stops;
  }
  function drawRoute(toS, dpr, px) {
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass ? follow.color : "rgba(255,255,255,.92)";
      ctx.lineWidth = (pass ? 3 : 6.5) * dpr;
      ctx.beginPath();
      for (const seg of follow.segs)
        seg.forEach(([x, y], k) => { const [a, b] = toS(x, y); k ? ctx.lineTo(a * dpr, b * dpr) : ctx.moveTo(a * dpr, b * dpr); });
      ctx.stroke();
    }
    const r = (px >= 1 ? 4 : 3) * dpr;
    ctx.fillStyle = "#fff"; ctx.strokeStyle = follow.color; ctx.lineWidth = 2 * dpr;
    for (const [x, y] of follow.stops) {
      const [a, b] = toS(x, y);
      ctx.beginPath(); ctx.arc(a * dpr, b * dpr, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
  }
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && follow) setFollow(null); });

  // ---------- 📍 where am I ----------

  function drawMe(toS, scale, dpr, now) {
    const [a, b] = toS(me.x, me.y), x = a * dpr, y = b * dpr;
    const acc = Math.min(400, me.acc || 0) / MPP * scale * dpr;
    if (acc > 8 * dpr) {
      ctx.fillStyle = "rgba(47,111,176,.15)"; ctx.strokeStyle = "rgba(47,111,176,.5)"; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.arc(x, y, acc, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
    const pulse = (now % 2000) / 2000;
    ctx.fillStyle = `rgba(47,111,176,${0.35 * (1 - pulse)})`;
    ctx.beginPath(); ctx.arc(x, y, (8 + 14 * pulse) * dpr, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x, y, 8 * dpr, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#2f6fb0"; ctx.beginPath(); ctx.arc(x, y, 5.5 * dpr, 0, 2 * Math.PI); ctx.fill();
  }
  const btnLoc = document.getElementById("btn-locate");
  let watchId = null, centred = false;
  function stopLocate() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null; me = null; btnLoc.setAttribute("aria-pressed", false);
  }
  if (btnLoc) btnLoc.onclick = () => {
    if (watchId != null) { stopLocate(); return; }
    if (!navigator.geolocation) { toast("Location isn't available in this browser."); return; }
    btnLoc.setAttribute("aria-pressed", true); centred = false;
    toast("Finding you…", 15000);
    watchId = navigator.geolocation.watchPosition((pos) => {
      if (window.tinyFog) tinyFog.live(pos.coords, pos.timestamp);   // fog of war: uncover as you go
      if (!geo || !info) return;
      const p = toImagePx(pos.coords.latitude, pos.coords.longitude);
      me = p ? { x: p[0], y: p[1], acc: pos.coords.accuracy } : null;
      if (centred) return;
      centred = true;
      if (p) { toast(""); flyTo(p[0], p[1], 2000); }
      else toast("You're outside the map. It covers central Athens for now.", 5000);
    }, (err) => {
      toast(err.code === 1 ? "Location permission was refused." : "Couldn't find your location.");
      stopLocate();
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  };

  // ---------- weather ----------
  // ?weather=rain|storm forces it (for a sample); otherwise the current Athens weather from
  // Open-Meteo, checked every 15 min.
  const forcedWeather = params.get("weather");
  async function checkWeather() {
    if (forcedWeather) { weather = forcedWeather === "clear" ? null : forcedWeather; return; }
    try {
      const d = await fetch("https://api.open-meteo.com/v1/forecast?latitude=37.975&longitude=23.735&current=weather_code,precipitation")
        .then((r) => r.json());
      const c = d.current.weather_code;
      weather = c >= 95 ? "storm" : (c >= 51 && c <= 67) || (c >= 80 && c <= 82) ? "rain" : null;
    } catch (e) { /* keep the last known weather */ }
  }
  checkWeather(); setInterval(checkWeather, 15 * 60 * 1000);

  const drops = [], splashes = [];
  let lastRain = 0, flash = 0;
  function drawRain(dpr, now) {
    const W = canvas.width, H = canvas.height, dt = Math.min(0.05, (now - (lastRain || now)) / 1000);
    lastRain = now;
    const heavy = weather === "storm";
    const want = Math.round((W * H) / (dpr * dpr) / (heavy ? 1100 : 1900));
    while (drops.length < want) drops.push({ x: Math.random() * W, y: Math.random() * H, z: 0.6 + Math.random() * 0.8 });
    drops.length = Math.min(drops.length, want);
    const vy = (heavy ? 1500 : 1100) * dpr, vx = -0.18 * vy;          // a little wind from the east
    ctx.strokeStyle = "rgba(205,220,240,.55)"; ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.beginPath();
    for (const d of drops) {
      d.x += vx * d.z * dt; d.y += vy * d.z * dt;
      if (d.y > H || d.x < 0) {
        if (Math.random() < 0.35) splashes.push({ x: d.x, y: Math.min(d.y, H) - Math.random() * H * 0.9, t: now });
        d.x = Math.random() * W * 1.2; d.y = -Math.random() * 40 * dpr;
      }
      const len = 13 * d.z * dpr;
      ctx.moveTo(Math.round(d.x), Math.round(d.y));
      ctx.lineTo(Math.round(d.x - 0.18 * len), Math.round(d.y - len));
    }
    ctx.stroke();
    // Splashes: tiny rings on the ground, 300 ms each.
    ctx.strokeStyle = "rgba(220,232,248,.6)";
    for (let k = splashes.length - 1; k >= 0; k--) {
      const s = splashes[k], age = (now - s.t) / 300;
      if (age > 1) { splashes.splice(k, 1); continue; }
      ctx.globalAlpha = 1 - age;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, (2 + 5 * age) * dpr, (1 + 2.2 * age) * dpr, 0, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (heavy) {
      // Lightning now and then.
      if (!flash && Math.random() < 0.0015) flash = now;
      if (flash) {
        const a = now - flash;
        if (a > 450) flash = 0;
        else { ctx.fillStyle = `rgba(235,240,255,${(a < 80 || (a > 160 && a < 230) ? 0.55 : 0.12) * (1 - a / 450)})`; ctx.fillRect(0, 0, W, H); }
      }
    }
  }

  // Details: hover with a mouse; tap on touch screens (a card above the bottom edge on phones).
  function nearest(clientX, clientY, radius) {
    const r = canvas.getBoundingClientRect(), mx = clientX - r.left, my = clientY - r.top;
    let best = null, bd = radius;
    for (const [x, y, v] of drawn) { const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = v; } }
    return best;
  }
  function showTip(v, clientX, clientY) {
    hover = v;
    if (!v) { tip.style.display = "none"; return; }
    const age = Math.round(Date.now() / 1000 - v.positionAt);
    const delay = v.delay == null ? "" : v.delay >= 60 ? ` · ${Math.round(v.delay / 60)} min late`
      : v.delay <= -60 ? ` · ${Math.round(-v.delay / 60)} min early` : " · on time";
    const name = lines[v.line] && lines[v.line].name ? `<br>${lines[v.line].name}` : v.headsign ? `<br>to ${v.headsign}` : "";
    const kindName = { bus: "Bus", trolley: "Trolley", tram: "Tram", metro: "Metro" }[v.kind];
    const src = v.knots ? "position from the timetable" : `vehicle ${v.id} · GPS ${age} s ago`;
    tip.innerHTML = `<b>${kindName} ${v.line}</b>${delay}${name}<br><span>${src}</span>`;
    const phone = window.matchMedia("(max-width: 600px)").matches;
    tip.classList.toggle("card", phone);
    if (!phone) {
      tip.style.left = Math.min(clientX + 14, window.innerWidth - 290) + "px";
      tip.style.top = Math.min(clientY + 14, window.innerHeight - 90) + "px";
    }
    tip.style.display = "block";
  }
  const mapEl = document.getElementById("map");
  mapEl.addEventListener("pointermove", (e) => {
    if (!on || e.pointerType !== "mouse") return;
    showTip(nearest(e.clientX, e.clientY, 18), e.clientX, e.clientY);
  });
  let down = null;
  mapEl.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY, Date.now()]; });
  // A click or tap on a vehicle follows its line; on empty map it stops following.
  mapEl.addEventListener("pointerup", (e) => {
    if (!on || !down) return;
    const mouse = e.pointerType === "mouse";
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    if (moved >= (mouse ? 5 : 10) || Date.now() - down[2] > 500) return;
    const v = nearest(e.clientX, e.clientY, mouse ? 18 : 30);
    if (!mouse) showTip(v, e.clientX, e.clientY);
    if (v) setFollow(v.line); else if (follow) setFollow(null);
  });

  // Small hook for tests and for the browser console.
  window.tinyTransit = { makeSprite, vehicles, toImagePx, STYLE, setFollow, get follow() { return follow; } };

  const btnDark = document.getElementById("btn-dark");
  if (btnDark) {
    btnDark.setAttribute("aria-pressed", darkMap);
    btnDark.onclick = () => {
      darkMap = !darkMap;
      btnDark.setAttribute("aria-pressed", darkMap);
      try { localStorage.setItem("tinyathens.darkMap", darkMap ? "1" : "0"); } catch (e) {}
    };
  }

  btn.onclick = () => {
    on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", on);
    clearTimeout(timer);
    tip.style.display = "none";
    if (on) { setStatus("Loading live buses and trolleys…"); poll(); }
    else { statusEl.style.display = "none"; vehicles.clear(); if (btnDark) btnDark.hidden = true; }
    if (follow) renderFollow();
  };

  // Live transit is on by default (?transit=0 starts with it off). Embedded comparison
  // panels start a few seconds apart so they don't all ask the API at once.
  if (params.get("transit") !== "0") setTimeout(() => btn.click(), params.get("embed") === "1" ? 300 + Math.random() * 4000 : 0);
})();
