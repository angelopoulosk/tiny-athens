// Fog of war over the parts of Athens that aren't drawn yet.
// tiles/info.json lists the drawn squares ("cells", in squares from the map's top-left corner);
// everything else is covered with drifting clouds, fading out softly at the edge of the drawn
// squares. As more squares are drawn and the tiles rebuilt, the fog lifts by itself.
(() => {
  const RES = 16;       // mask pixels per square
  const ROUND = 2;      // blur radius per pass (3 passes): sets how round the corners are
  const WOBBLE = 0.6;   // how far the cloud edge wanders in and out
  const EDGE = 0.12;    // softness of the edge
  const SMOKE = 3;      // blur radius per pass (3 passes) of the smoke drifting over the drawn squares
  const BASE = "#1c2127";
  let info = null, mask = null, cloud = null, mapEl = document.getElementById("map");

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
      mapEl.style.background = BASE;
      mask = buildMask(i);
      cloud = buildClouds();
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

  // Alpha mask of the whole map: clear over the drawn squares, fog elsewhere. The outline is
  // shaped like the edge of a cloud bank: the square mask is blurred and cut at half height,
  // which rounds every corner (outer and inner), and noise makes the edge wander in and out.
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

  function buildMask(i) {
    const shot = i.shot || 1024;
    const cw = Math.ceil(i.width / shot), ch = Math.ceil(i.height / shot);
    const w = cw * RES, h = ch * RES;
    let m = new Float32Array(w * h);
    for (const [ci, cj] of i.cells)
      for (let y = cj * RES; y < (cj + 1) * RES; y++)
        for (let x = ci * RES; x < (ci + 1) * RES; x++) m[y * w + x] = 1;
    const inside = m.slice();
    for (let k = 0; k < 3; k++) m = boxBlur(m, w, h, ROUND);   // ~Gaussian
    const noise = valueNoise(w, h);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d"), im = g.createImageData(w, h);
    let fog = new Float32Array(w * h);
    for (let k = 0; k < w * h; k++) {
      const v = m[k] + (noise[k] - 0.5) * WOBBLE;              // > 0.5 = clear
      const t = Math.min(1, Math.max(0, (0.6 - v) / EDGE + 0.5));
      // Outside the drawn squares it's always full fog (there's nothing drawn to show), so the
      // rounding and wobble only eat into the squares and never reveal their straight edges.
      fog[k] = inside[k] ? t * t * (3 - 2 * t) : 1;
    }
    // Smoke drifting in over the edge of the drawn squares: a wider blur of the fog,
    // only added inside the clear area, thinned into wisps by a second noise.
    let smoke = fog;
    for (let k = 0; k < 3; k++) smoke = boxBlur(smoke, w, h, SMOKE);
    const wisps = valueNoise(w, h, 7);
    for (let k = 0; k < w * h; k++) {
      const s = Math.min(1, smoke[k] * 1.5) * (0.35 + 0.9 * wisps[k]);
      const a = Math.max(fog[k], Math.min(0.92, s));
      im.data[4 * k] = im.data[4 * k + 1] = im.data[4 * k + 2] = 255;
      im.data[4 * k + 3] = Math.round(a * 255);
    }
    g.putImageData(im, 0, 0);
    return { canvas: c, w, h, cw, ch, shot };
  }

  // Smooth noise in [0, 1] over a w x h grid (two octaves, for the wobbly cloud edge).
  function valueNoise(w, h, seed0 = 99) {
    let seed = seed0;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const out = new Float32Array(w * h), sm = (t) => t * t * (3 - 2 * t);
    for (const [cell, amp] of [[RES * 0.45, 0.65], [RES * 0.18, 0.35]]) {
      const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
      const v = Array.from({ length: gw * gh }, rnd);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = sm(fx - x0), ty = sm(fy - y0);
          const a = v[y0 * gw + x0], b = v[y0 * gw + x0 + 1], c = v[(y0 + 1) * gw + x0], d = v[(y0 + 1) * gw + x0 + 1];
          out[y * w + x] += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
        }
    }
    return out;
  }

  // Tileable cloud texture (a few octaves of smooth value noise).
  function buildClouds() {
    const N = 256, c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d"), im = g.createImageData(N, N);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const octaves = [8, 16, 32, 64].map((p) => ({ p, v: Array.from({ length: p * p }, rnd) }));
    const sm = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let s = 0, amp = 0.55, tot = 0;
        for (const { p, v } of octaves) {
          const fx = (x / N) * p, fy = (y / N) * p, x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = sm(fx - x0), ty = sm(fy - y0), x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
          const a = v[y0 * p + x0], b = v[y0 * p + x1], cc = v[y1 * p + x0], dd = v[y1 * p + x1];
          s += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dd * tx) * ty);
          tot += amp; amp *= 0.5;
        }
        const n = s / tot, k = 4 * (y * N + x);
        const l = Math.max(0, n - 0.35) * 1.6;                    // light wisps
        im.data[k] = 120; im.data[k + 1] = 132; im.data[k + 2] = 146;
        im.data[k + 3] = Math.round(Math.min(1, l) * 150);
      }
    g.putImageData(im, 0, 0);
    return c;
  }

  let last = "", lastT = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (typeof mapItem === "undefined" || !mapItem || !mask) return;
    const dpr = window.devicePixelRatio || 1, r = canvas.parentElement.getBoundingClientRect();
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    const p0 = mapItem.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const p1 = mapItem.imageToViewerElementCoordinates(new OpenSeadragon.Point(info.width, info.height));
    const view = [W, H, p0.x.toFixed(1), p0.y.toFixed(1), p1.x.toFixed(1)].join();
    if (view === last && t - lastT < 80) return;   // clouds drift at ~12 fps when the map is still
    last = view; lastT = t;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = BASE;
    ctx.fillRect(0, 0, W, H);
    // Clouds move with the map (a bit slower, like they float above it) and drift with the wind.
    const zoom = ((p1.x - p0.x) * dpr) / info.width;            // screen px per image px
    const k = Math.min(6, Math.max(1.2, zoom * 40)) * dpr;      // cloud texture scale
    const drift = t * 0.004;
    for (const [layer, f, a] of [[0, 0.8, 1], [1, 0.55, 0.6]]) {
      const pat = ctx.createPattern(cloud, "repeat");
      const kk = k * (layer ? 2.3 : 1);
      pat.setTransform(new DOMMatrix([kk, 0, 0, kk, p0.x * dpr * f + drift * (layer ? 1.6 : 1), p0.y * dpr * f + drift * 0.3]));
      ctx.globalAlpha = a;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
    // Cut out the drawn squares.
    ctx.globalCompositeOperation = "destination-in";
    ctx.imageSmoothingEnabled = true;
    const sx = ((p1.x - p0.x) * dpr) / info.width * mask.shot / RES;   // screen px per mask px
    ctx.drawImage(mask.canvas, p0.x * dpr, p0.y * dpr, mask.w * sx, mask.h * sx);
    ctx.globalCompositeOperation = "source-over";
  }
})();
