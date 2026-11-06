// tiny athens - fog of war (prototype, on with ?fog=1).
//
// The map starts covered. Walking, running or cycling uncovers it: import GPX files from
// Strava / Garmin / Komoot / a watch app, or explore live with the 📍 button.
//
// Privacy: everything happens in this browser. A GPX file is read here, turned into a set of
// ~50 m squares, and the route itself is thrown away. Only the squares (and the day each was
// last visited) are kept, in this browser's storage. The first and last 200 m of every
// activity are dropped and private zones are never uncovered, so home doesn't show.
//
// Like Age of Empires: black = never visited, grey fog = visited more than 30 days ago,
// clear = visited in the last 30 days.

(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("fog") !== "1") return;

  const CELL_M = 50;                 // size of one square
  const REVEAL_M = 45;               // uncovered radius around a route point
  const TRIM_M = 200;                // dropped at the start and end of each activity
  const MAX_KMH = 35;                // faster than this is a car, bus or train: skipped
  const RECENT_DAYS = 30;
  const ZONE_M = 250;                // private zone radius
  const STORE = "tinyathens.fog.v1";
  const MPP = 0.293;

  const LAT0 = 37.9755, LON0 = 23.7348;                       // grid anchor (map camera origin)
  const DLAT = CELL_M / 111320, DLON = DLAT / Math.cos((LAT0 * Math.PI) / 180);
  const cellOf = (lat, lon) => [Math.floor((lat - LAT0) / DLAT), Math.floor((lon - LON0) / DLON)];
  const cellCentre = (r, c) => [LAT0 + (r + 0.5) * DLAT, LON0 + (c + 0.5) * DLON];
  const today = () => Math.floor(Date.now() / 864e5);
  const distM = (a, b) => {
    const dy = (b[0] - a[0]) * 111320, dx = (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180);
    return Math.hypot(dx, dy);
  };

  // ---------- storage (this browser only) ----------
  let state = { cells: {}, zones: [] };
  try { state = Object.assign(state, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch (e) {}
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {} };
  const inZone = (p) => state.zones.some((z) => distM(p, [z.lat, z.lon]) < z.r);

  // ---------- uncovering ----------
  let dirty = true;
  function revealAt(lat, lon, day) {
    if (inZone([lat, lon])) return 0;
    const [r0, c0] = cellOf(lat, lon);
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (distM([lat, lon], cellCentre(r, c)) > REVEAL_M + CELL_M * 0.5) continue;
      const k = r + "," + c;
      if (!(state.cells[k] >= day)) { if (state.cells[k] == null) n++; state.cells[k] = day; }
    }
    dirty = true;
    return n;
  }

  // One activity: [[lat, lon, timeMs|null], ...]. Trim the ends, skip fast stretches,
  // walk along it every 10 m. Returns how many new squares it uncovered.
  function revealTrack(pts) {
    if (pts.length < 2) return 0;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];
    if (total < 2 * TRIM_M + 50) return 0;
    const day = pts[0][2] ? Math.floor(pts[0][2] / 864e5) : today();
    let n = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = cum[i] - cum[i - 1];
      if (cum[i] < TRIM_M || cum[i - 1] > total - TRIM_M || d === 0) continue;
      if (a[2] && b[2] && b[2] > a[2] && (d / ((b[2] - a[2]) / 1000)) * 3.6 > MAX_KMH) continue;
      for (let s = 0; s <= d; s += 10) {
        const t = s / d, at = cum[i - 1] + s;
        if (at < TRIM_M || at > total - TRIM_M) continue;
        n += revealAt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, day);
      }
    }
    return n;
  }

  function parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const type = (doc.querySelector("trk > type")?.textContent || "").toLowerCase();
    if (/driv|car|motor|bus|train|boat|ski/.test(type)) return [];   // not a walk, run or ride
    const tracks = [];
    for (const seg of doc.querySelectorAll("trkseg, rte")) {
      const pts = [];
      for (const p of seg.querySelectorAll("trkpt, rtept")) {
        const lat = +p.getAttribute("lat"), lon = +p.getAttribute("lon");
        const tm = p.querySelector("time");
        if (isFinite(lat) && isFinite(lon)) pts.push([lat, lon, tm ? Date.parse(tm.textContent) : null]);
      }
      if (pts.length) tracks.push(pts);
    }
    return tracks;
  }

  async function importFiles(files) {
    let n = 0, acts = 0, skipped = 0;
    for (const f of files) {
      if (!/\.gpx$/i.test(f.name)) { skipped++; continue; }
      const tracks = parseGPX(await f.text());        // the file never leaves this browser
      for (const t of tracks) { n += revealTrack(t); acts++; }
    }
    save(); renderCard();
    toast(acts ? `${acts} ${acts === 1 ? "activity" : "activities"}: ${n} new squares uncovered` +
      (skipped ? ` (${skipped} non-GPX file${skipped > 1 ? "s" : ""} skipped)` : "")
      : "No walks, runs or rides found in those files (GPX only for now)", 5000);
  }

  // Live: called by the 📍 button's location updates (transit.js).
  let lastLive = null;
  function live(coords, ts) {
    if (!on || coords.accuracy > 40) return;
    const p = [coords.latitude, coords.longitude, ts || Date.now()];
    if (lastLive) {
      const d = distM(lastLive, p), dt = (p[2] - lastLive[2]) / 1000;
      if (dt > 0 && (d / dt) * 3.6 > MAX_KMH) { lastLive = p; return; }
    }
    lastLive = p;
    if (revealAt(p[0], p[1], today())) { save(); renderCard(); }
  }

  // ---------- drawing ----------
  const canvas = document.createElement("canvas");
  canvas.id = "fog";
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3";
  document.getElementById("map").appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const lo = document.createElement("canvas"), lctx = lo.getContext("2d");      // fog at 1/4 size
  const mOld = document.createElement("canvas"), mNew = document.createElement("canvas");
  const DOWN = 4;
  const imgPx = new Map();   // cell key -> image px (or null off the map)
  let on = true, lastView = "";

  function cellImg(k) {
    if (!imgPx.has(k)) {
      const [r, c] = k.split(",").map(Number), [la, lo2] = cellCentre(r, c);
      imgPx.set(k, window.tinyTransit && tinyTransit.toImagePx ? safe(() => tinyTransit.toImagePx(la, lo2)) : null);
    }
    return imgPx.get(k);
  }
  const safe = (f) => { try { return f(); } catch (e) { return null; } };
  // The GPS table (geo.json) is loaded once toImagePx stops throwing.
  const geoReady = () => { try { tinyTransit.toImagePx(LAT0, LON0); return true; } catch (e) { return false; } };

  function frame() {
    requestAnimationFrame(frame);
    const dpr = window.devicePixelRatio || 1, r = canvas.parentElement.getBoundingClientRect();
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (!on || typeof mapItem === "undefined" || !mapItem) { if (canvas.width) { canvas.width = 0; lastView = ""; } return; }
    const s0 = mapItem.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const s1 = mapItem.imageToViewerElementCoordinates(new OpenSeadragon.Point(1000, 0));
    const scale = (s1.x - s0.x) / 1000;
    const view = [W, H, s0.x.toFixed(1), s0.y.toFixed(1), scale.toFixed(5)].join();
    if (view === lastView && !dirty) return;
    lastView = view; dirty = false;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const w = Math.ceil(W / DOWN), h = Math.ceil(H / DOWN);
    for (const c of [lo, mOld, mNew]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

    // Masks of uncovered ground: all visits, and recent visits.
    const k = (dpr / DOWN), rad = Math.max(2, ((REVEAL_M + 12) / MPP) * scale * k);
    const o = mOld.getContext("2d"), n = mNew.getContext("2d");
    o.clearRect(0, 0, w, h); n.clearRect(0, 0, w, h);
    o.fillStyle = n.fillStyle = "#000";
    const recent = today() - RECENT_DAYS;
    for (const key in state.cells) {
      const p = cellImg(key);
      if (!p) continue;
      const x = (s0.x + p[0] * scale) * k, y = (s0.y + p[1] * scale) * k;
      if (x < -rad || y < -rad || x > w + rad || y > h + rad) continue;
      o.beginPath(); o.arc(x, y, rad, 0, 2 * Math.PI); o.fill();
      if (state.cells[key] >= recent) { n.beginPath(); n.arc(x, y, rad, 0, 2 * Math.PI); n.fill(); }
    }
    // Fog: near-black, lifted to grey where you've been, clear where you've been lately.
    lctx.globalCompositeOperation = "source-over"; lctx.globalAlpha = 1;
    lctx.fillStyle = "#0b0e14"; lctx.fillRect(0, 0, w, h);
    lctx.globalCompositeOperation = "destination-out";
    lctx.globalAlpha = 0.62; lctx.drawImage(mOld, 0, 0);
    lctx.globalAlpha = 1; lctx.drawImage(mNew, 0, 0);
    // Upscale with smoothing for soft, cloudy edges.
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = 0.94;
    ctx.drawImage(lo, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);

  // ---------- card: progress and controls ----------
  const card = document.createElement("div");
  card.className = "follow fog-card";
  document.querySelector(".top").appendChild(card);
  const file = Object.assign(document.createElement("input"), { type: "file", accept: ".gpx", multiple: true, hidden: true });
  document.body.appendChild(file);
  file.onchange = () => { if (file.files.length) importFiles([...file.files]); file.value = ""; };

  let totalCells = null;
  function countTotal() {
    // Squares whose centre lies on the drawn map.
    const g = window.tinyTransit && tinyTransit.toImagePx;
    if (!g || !geoReady()) return null;
    const [r0, c0] = cellOf(37.94, 23.68), [r1, c1] = cellOf(38.01, 23.79);
    let t = 0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (cellImg(r + "," + c)) t++;
    return t || null;
  }
  function renderCard() {
    if (totalCells == null) totalCells = countTotal();
    let mine = 0;
    for (const key in state.cells) if (cellImg(key)) mine++;
    const pct = totalCells ? ((100 * mine) / totalCells).toFixed(mine && mine / totalCells < 0.01 ? 1 : 0) : "–";
    card.innerHTML =
      `<div><b>🌫️ Explored ${pct}% of the map</b> · ${mine} squares` +
      `<br><span>Import walks, runs and rides (GPX), or explore live with 📍. Nothing leaves this browser.</span>` +
      `<div class="fog-actions"><button data-a="gpx">Import GPX</button><button data-a="zone" title="Never uncover 250 m around the middle of the screen">🏠 Private zone</button>` +
      `<button data-a="toggle">${on ? "Hide fog" : "Show fog"}</button><button data-a="reset">Reset</button></div></div>`;
    card.querySelectorAll("button[data-a]").forEach((b) => (b.onclick = () => action(b.dataset.a)));
  }
  function action(a) {
    if (a === "gpx") file.click();
    if (a === "toggle") { on = !on; dirty = true; renderCard(); }
    if (a === "zone") {
      const vp = viewer.viewport, c = mapItem.viewportToImageCoordinates(vp.getCenter(true));
      const ll = imageToLatLon(c.x, c.y);
      if (!ll) return toast("Move the map over your home first");
      state.zones.push({ lat: ll[0], lon: ll[1], r: ZONE_M });
      for (const key in state.cells) {
        const [r, c2] = key.split(",").map(Number);
        if (inZone(cellCentre(r, c2))) delete state.cells[key];
      }
      save(); dirty = true; renderCard();
      toast(`Private zone added: 250 m around the middle of the screen will stay covered (${state.zones.length} zone${state.zones.length > 1 ? "s" : ""})`, 5000);
    }
    if (a === "reset" && confirmReset()) { state.cells = {}; save(); dirty = true; renderCard(); }
  }
  let resetArmed = 0;
  function confirmReset() {   // tap twice within 3 s (no browser dialogs)
    if (Date.now() - resetArmed < 3000) return true;
    resetArmed = Date.now(); toast("Tap Reset again to clear everything you've uncovered", 3000); return false;
  }
  // Image px -> lat/lon by searching the geo grid around the closest node (prototype-grade).
  function imageToLatLon(x, y) {
    let best = null, bd = Infinity;
    const [r0, c0] = cellOf(37.94, 23.68), [r1, c1] = cellOf(38.01, 23.79);
    for (let r = r0; r <= r1; r += 2) for (let c = c0; c <= c1; c += 2) {
      const p = cellImg(r + "," + c);
      if (p) { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = cellCentre(r, c); } }
    }
    return bd < 200 ? best : null;
  }

  // Wait until the map and its GPS table are ready, then show the card.
  const ready = setInterval(() => {
    if (typeof mapItem !== "undefined" && mapItem && window.tinyTransit && geoReady()) {
      clearInterval(ready); imgPx.clear(); dirty = true; renderCard();
    }
  }, 500);

  window.tinyFog = { live, importFiles, revealTrack, parseGPX, get state() { return state; } };
})();
