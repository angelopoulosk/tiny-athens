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
      vis = buildFogTexture(i);
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
  function buildFogTexture(i) {
    const shot = i.shot || 1024;
    const cw = Math.ceil(i.width / shot), ch = Math.ceil(i.height / shot);
    const w = cw * RES, h = ch * RES;
    const drawn = new Uint8Array(w * h), cellSet = new Set(i.cells.map(([a, b]) => a + "," + b));
    for (const [ci, cj] of i.cells)
      for (let y = cj * RES; y < (cj + 1) * RES; y++)
        for (let x = ci * RES; x < (ci + 1) * RES; x++) drawn[y * w + x] = 1;
    const has = (ci, cj) => cellSet.has(ci + "," + cj);
    // Shape of the clear area: each square pulled in by INSET on the sides that face fog, with
    // the corners that stick out rounded off, so after blurring the fog reaches full strength
    // right at the tile edge. Sides shared with another drawn square stay open, so joined
    // squares make one smooth shape.
    let v = new Float32Array(w * h);
    for (let k = 0; k < w * h; k++) v[k] = drawn[k];
    const R = INSET + CORNER;
    for (const [ci, cj] of i.cells) {
      const x0 = ci * RES, y0 = cj * RES, x1 = x0 + RES - 1, y1 = y0 + RES - 1;
      const clear = (x, y) => { v[y * w + x] = 0; };
      if (!has(ci - 1, cj)) for (let y = y0; y <= y1; y++) for (let x = x0; x < x0 + INSET; x++) clear(x, y);
      if (!has(ci + 1, cj)) for (let y = y0; y <= y1; y++) for (let x = x1 - INSET + 1; x <= x1; x++) clear(x, y);
      if (!has(ci, cj - 1)) for (let y = y0; y < y0 + INSET; y++) for (let x = x0; x <= x1; x++) clear(x, y);
      if (!has(ci, cj + 1)) for (let y = y1 - INSET + 1; y <= y1; y++) for (let x = x0; x <= x1; x++) clear(x, y);
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (has(ci + sx, cj) || has(ci, cj + sy)) continue;          // corner doesn't stick out
        const cx = sx < 0 ? x0 + R : x1 + 1 - R, cy = sy < 0 ? y0 + R : y1 + 1 - R;
        for (let dy = 0; dy < R; dy++)
          for (let dx = 0; dx < R; dx++) {
            const px = sx < 0 ? x0 + dx : x1 - dx, py = sy < 0 ? y0 + dy : y1 - dy;
            if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) > CORNER) clear(px, py);
          }
      }
    }
    for (let k = 0; k < 3; k++) v = boxBlur(v, w, h, BLUR);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d"), im = g.createImageData(w, h);
    for (let k = 0; k < w * h; k++) {
      const t = v[k], s = t * t * (3 - 2 * t);
      im.data[4 * k] = im.data[4 * k + 1] = im.data[4 * k + 2] = 255;
      im.data[4 * k + 3] = Math.round((drawn[k] ? 1 - s : 1) * 255);
    }
    g.putImageData(im, 0, 0);
    return { canvas: c, w, h, shot };
  }

  let last = "";
  function frame() {
    requestAnimationFrame(frame);
    if (typeof mapItem === "undefined" || !mapItem || !vis) return;
    const dpr = window.devicePixelRatio || 1, r = canvas.parentElement.getBoundingClientRect();
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    const p0 = mapItem.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const p1 = mapItem.imageToViewerElementCoordinates(new OpenSeadragon.Point(info.width, info.height));
    const view = [W, H, p0.x.toFixed(1), p0.y.toFixed(1), p1.x.toFixed(1)].join();
    if (view === last) return;                 // only redraw when the map moves
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
