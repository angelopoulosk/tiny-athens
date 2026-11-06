// Fog of war over the parts of Athens that aren't drawn yet, done the way RTS games do it
// (see Gemserk's "Implementing Fog of War for RTS games"): a small visibility texture where
// every drawn square paints a soft white shape, blurred, then stretched over the map with
// smooth filtering. Black = unexplored, white = visible. Plain dark fog, no clouds or smoke:
// like StarCraft, unexplored ground is simply covered.
// tiles/info.json lists the drawn squares ("cells", in squares from the map's top-left corner);
// as more squares are drawn and the tiles rebuilt, the fog lifts by itself.
(() => {
  const RES = 16;            // visibility texture pixels per square
  const INSET = 2;           // clear area starts this far inside a square's fog-facing edge (px of 16)
  const CORNER = 4;          // radius of the rounded corners, texture pixels
  const BLUR = 1;            // box blur radius per pass (3 passes ~ Gaussian): softness of the edge
  const FOG = "#0f1316";     // unexplored
  let info = null, vis = null;
  const mapEl = document.getElementById("map");

  const canvas = document.createElement("canvas");
  canvas.id = "mapfog";
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3";
  mapEl.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  fetch("tiles/info.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((i) => {
      if (!i || !i.fog || !i.cells) return;
      info = i;
      mapEl.style.background = FOG;
      const fresh = findNew(i);
      vis = buildFogTexture(i, new Map(fresh.map(([a, b]) => [a + "," + b, 0])));
      pending = fresh;
      if (fresh.length && window.toast) {
        const t = document.getElementById("toast");
        toast(`✨ ${fresh.length} new square${fresh.length > 1 ? "s" : ""} unlocked since your last visit - tap to see`, 6000);
        const off = () => { t.onclick = null; t.style.pointerEvents = ""; t.style.cursor = ""; };
        if (t) { t.style.pointerEvents = "auto"; t.style.cursor = "pointer"; setTimeout(off, 6000); }
        if (t) t.onclick = () => {
          t.style.display = "none"; off();
          const c = pending[0] || fresh[0], sh = i.shot || 1024;
          if (c && window.flyTo) flyTo((c[0] + 0.5) * sh, (c[1] + 0.5) * sh, 4 * sh);
        };
      }
      const note = document.getElementById("preview-note");
      if (note) {
        const n = i.cells.length, all = i.world_squares || n;
        note.lastChild.textContent =
          ` ${n} of ${all.toLocaleString("en")} squares of Athens drawn by Gemini so far (seams show where squares meet). ` +
          `The rest is fog of war until it's drawn.`;
      }
      requestAnimationFrame(frame);
    })
    .catch(() => {});

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / n;
        acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / n;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  // Fog texture: alpha = 1 - visibility. Each drawn square is a "vision source": a white
  // rounded square (neighbouring squares merge into one shape), then blurred for soft edges.
  // Outside drawn squares the fog stays full, so the straight edges of the map tiles never show.
  // Squares unlocked since the last visit start hidden and open up from their centre
  // (reveal[key] = 0..1); only the few squares around them are recomputed while that plays.
  let tex = null;   // { canvas, g, im, w, h, cw, ch, shot, set, reveal }
  function buildFogTexture(i, reveal) {
    const shot = i.shot || 1024;
    const cw = Math.ceil(i.width / shot), ch = Math.ceil(i.height / shot);
    const w = cw * RES, h = ch * RES;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    tex = { canvas: c, g, im: g.createImageData(w, h), w, h, cw, ch, shot,
            set: new Set(i.cells.map(([a, b]) => a + "," + b)), reveal };
    paint(0, 0, cw - 1, ch - 1);
    return tex;
  }

  const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

  // Recompute the fog for squares wx0..wx1 x wy0..wy1 (inclusive).
  function paint(wx0, wy0, wx1, wy1) {
    const { w, cw, ch, set, reveal, im } = tex;
    const ex0 = Math.max(0, wx0 - 1), ey0 = Math.max(0, wy0 - 1);
    const ex1 = Math.min(cw - 1, wx1 + 1), ey1 = Math.min(ch - 1, wy1 + 1);
    const W = (ex1 - ex0 + 1) * RES, H = (ey1 - ey0 + 1) * RES;
    const drawn = new Uint8Array(W * H);
    let v = new Float32Array(W * H);
    const has = (ci, cj) => set.has(ci + "," + cj);
    const half = RES / 2;
    for (let cj = ey0; cj <= ey1; cj++)
      for (let ci = ex0; ci <= ex1; ci++) {
        if (!has(ci, cj)) continue;
        const x0 = (ci - ex0) * RES, y0 = (cj - ey0) * RES, x1 = x0 + RES - 1, y1 = y0 + RES - 1;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { drawn[y * W + x] = 1; v[y * W + x] = 1; }
        // How far each side is pulled in: INSET towards fog, 0 towards another drawn square.
        // A square still being revealed starts covered and the fog rolls back from the sides
        // it shares with drawn squares (or from its centre if it has none).
        const p = ease(reveal ? reveal.get(ci + "," + cj) ?? 1 : 1);
        const oL = has(ci - 1, cj), oR = has(ci + 1, cj), oT = has(ci, cj - 1), oB = has(ci, cj + 1);
        const side = (open, oppOpen) => open ? 0 : Math.round(INSET + ((oppOpen ? RES : half) - INSET) * (1 - p));
        const L = side(oL, oR), Rt = side(oR, oL), T = side(oT, oB), B = side(oB, oT);
        if (p < 1 && oL && oR && oT && oB) {
          // Surrounded by drawn squares: a patch of fog in the middle that shrinks away.
          const hole = Math.round(half * (1 - p));
          for (let y = y0 + half - hole; y < y0 + half + hole; y++)
            for (let x = x0 + half - hole; x < x0 + half + hole; x++) v[y * W + x] = 0;
          continue;
        }
        const clear = (x, y) => { v[y * W + x] = 0; };
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x < x0 + L; x++) clear(x, y);
          for (let x = x1 - Rt + 1; x <= x1; x++) clear(x, y);
        }
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y < y0 + T; y++) clear(x, y);
          for (let y = y1 - B + 1; y <= y1; y++) clear(x, y);
        }
        // Round the corners that stick out (fog on both sides of the corner).
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          if (has(ci + sx, cj) || has(ci, cj + sy)) continue;
          const ix = sx < 0 ? L : Rt, iy = sy < 0 ? T : B, r = Math.min(CORNER, half - Math.max(ix, iy));
          if (r <= 0) continue;
          const cx = sx < 0 ? x0 + ix + r : x1 + 1 - ix - r, cy = sy < 0 ? y0 + iy + r : y1 + 1 - iy - r;
          for (let dy = 0; dy < iy + r; dy++)
            for (let dx = 0; dx < ix + r; dx++) {
              const px = sx < 0 ? x0 + dx : x1 - dx, py = sy < 0 ? y0 + dy : y1 - dy;
              if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) > r) clear(px, py);
            }
        }
      }
    for (let k = 0; k < 3; k++) v = boxBlur(v, W, H, BLUR);
    // Write back only the requested squares (the extra ring was just context for the blur).
    const ox = (wx0 - ex0) * RES, oy = (wy0 - ey0) * RES;
    const ww = (wx1 - wx0 + 1) * RES, hh = (wy1 - wy0 + 1) * RES;
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < ww; x++) {
        const kl = (oy + y) * W + ox + x, t = v[kl], s = t * t * (3 - 2 * t);
        const kg = 4 * ((wy0 * RES + y) * w + wx0 * RES + x);
        im.data[kg] = im.data[kg + 1] = im.data[kg + 2] = 255;
        im.data[kg + 3] = Math.round((drawn[kl] ? 1 - s : 1) * 255);
      }
    tex.g.putImageData(im, 0, 0, wx0 * RES, wy0 * RES, ww, hh);
  }

  // ---- squares unlocked since the last visit ----
  // The browser remembers which squares it has shown (absolute square numbers, so it survives
  // the map growing). New ones stay fogged until they're on screen, then the fog opens up.
  // ?reveal=N pretends the N squares nearest the start view are new (to see the effect).
  const SEEN_KEY = "tinyathens.seenSquares.v1";
  const REVEAL_S = 2.2;
  let pending = [];      // [ci, cj] not yet revealed
  let anim = null;       // { cells, t0 }
  function findNew(i) {
    const oi = Math.round(i.origin_px[0] / (i.shot || 1024)), oj = Math.round(i.origin_px[1] / (i.shot || 1024));
    const abs = (c) => `${c[0] + oi},${c[1] + oj}`;
    const forced = parseInt(new URLSearchParams(location.search).get("reveal") || "0", 10);
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "null"); } catch (e) {}
    let fresh = [];
    if (forced > 0 && i.start) {
      const sh = i.shot || 1024;
      fresh = i.cells.slice().sort((a, b) =>
        Math.hypot((a[0] + 0.5) * sh - i.start[0], (a[1] + 0.5) * sh - i.start[1]) -
        Math.hypot((b[0] + 0.5) * sh - i.start[0], (b[1] + 0.5) * sh - i.start[1])).slice(0, forced);
    } else if (Array.isArray(seen)) {
      const s = new Set(seen);
      fresh = i.cells.filter((c) => !s.has(abs(c)));
    }
    // First visit: nothing counts as new. Either way, remember everything that exists now.
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(i.cells.map(abs))); } catch (e) {}
    return fresh;
  }

  function startRevealIfVisible(p0, p1) {
    if (!pending.length || anim) return;
    const r = canvas.getBoundingClientRect(), sq = ((p1.x - p0.x) / info.width) * tex.shot;  // screen px per square
    if (sq < 12) return;                                            // too far out to notice
    const vis = pending.filter(([ci, cj]) => {
      const x = p0.x + (ci + 0.5) * sq, y = p0.y + (cj + 0.5) * sq;
      return x > 0 && y > 0 && x < r.width && y < r.height;
    });
    if (!vis.length) return;
    pending = pending.filter((c) => !vis.includes(c));
    anim = { cells: vis, t0: performance.now() };
  }

  function stepReveal(now) {
    if (!anim) return false;
    const p = Math.min(1, (now - anim.t0) / 1000 / REVEAL_S);
    for (const [ci, cj] of anim.cells) tex.reveal.set(ci + "," + cj, p);
    for (const [ci, cj] of anim.cells) paint(Math.max(0, ci - 1), Math.max(0, cj - 1), Math.min(tex.cw - 1, ci + 1), Math.min(tex.ch - 1, cj + 1));
    if (p >= 1) anim = null;
    return true;
  }

  let last = "";
  function frame(now) {
    requestAnimationFrame(frame);
    if (typeof mapItem === "undefined" || !mapItem || !vis) return;
    const animating = stepReveal(now);
    const dpr = window.devicePixelRatio || 1, r = canvas.parentElement.getBoundingClientRect();
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    const p0 = mapItem.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const p1 = mapItem.imageToViewerElementCoordinates(new OpenSeadragon.Point(info.width, info.height));
    const view = [W, H, p0.x.toFixed(1), p0.y.toFixed(1), p1.x.toFixed(1)].join();
    startRevealIfVisible(p0, p1);
    if (view === last && !animating) return;   // only redraw when the map moves or fog opens
    last = view;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = FOG;
    ctx.fillRect(0, 0, W, H);
    // Keep the fog colour only where the texture says fog (smoothly stretched, like a GPU's
    // bilinear filter), so the edges stay soft at every zoom.
    ctx.globalCompositeOperation = "destination-in";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const s = ((p1.x - p0.x) * dpr) / info.width * vis.shot / RES;   // screen px per texture px
    ctx.drawImage(vis.canvas, p0.x * dpr, p0.y * dpr, vis.w * s, vis.h * s);
    ctx.globalCompositeOperation = "source-over";
  }
})();
