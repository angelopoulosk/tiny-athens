# tiny athens — step-by-step guide

An isometric pixel-art map of Athens in the style of [tiny.london](https://tiny.london), made entirely on an M-series MacBook with free services. This first run draws a **pilot area**: the Acropolis, Plaka, Thissio and Filopappou hill, about 1.8 × 1.3 km.

The pipeline:

1. **Render.** Your Mac renders Athens from Google's photorealistic 3D tiles through one fixed isometric camera.
2. **Teacher drawings.** Gemini (free tier) redraws about 100 of those renders as pixel art. Automatic checks throw out bad drawings.
3. **Train.** Your Mac trains a small style model (a "LoRA" on Stable Diffusion 1.5) from those drawings.
4. **Generate.** Your Mac draws the whole area as **one image**, so there are no seams between tiles.
5. **View.** The result is cut into zoomable tiles and opened in a little web viewer.

| Step | Time on an M4 Air (pilot) | Can stop and resume? |
|---|---|---|
| 0–2 Keys and setup | 20–40 min (mostly downloads) | yes |
| 3 Render | 15–30 min | yes |
| 4 Teacher drawings | 20–60 min | yes (also across days) |
| 5 Train | 1–2 h | yes |
| 6 Preview | 5–10 min each | — |
| 7 Generate | about 1–2 h | yes |
| 8 Tiles and viewer | a few minutes | — |

**Cost: €0.** The only thing that could ever charge you is the Google Maps key, and step 1 shows how to cap that.

> **Shortcut:** after step 1 (the keys), `bash run_all.sh` runs steps 2–8 by itself in one go, skipping the manual review and tuning. Re-run it any time; it continues where it stopped. The sections below explain each step and let you do them by hand.

> **Before long runs:** keep the Mac plugged in, on a hard surface, in a cool spot. Put `caffeinate -i` in front of a command (as shown below) so the Mac doesn't sleep. You can still use the Mac lightly while it works. Closing the lid stops the job, but you can resume it.

---

## 1. Get the two free API keys

### Google Map Tiles API key (for the 3D city)

1. Go to <https://console.cloud.google.com/> and sign in with a Google account.
2. Create a project (top bar → project picker → **New project**, e.g. `tiny-athens`).
3. Google asks for a **billing account with a card**. Maps APIs require one even for free use. The pilot uses a tiny fraction of the free monthly allowance. To be safe, set a budget alert: **Billing → Budgets & alerts → Create budget → €1**.
4. Open **APIs & Services → Library**, search **Map Tiles API**, and click **Enable**.
5. Open **APIs & Services → Credentials → Create credentials → API key**. Copy it.
6. Optional but wise: click the key → **API restrictions → Restrict key → Map Tiles API**.

### Gemini API key (for the teacher drawings)

1. Go to <https://aistudio.google.com/apikey>.
2. Click **Create API key** and copy it.

Don't attach billing to this one. The free tier is enough and keeps you at €0. The free limits are roughly 10 drawings a minute and a few hundred a day; the script stays inside them.

---

## 2. Set up the Mac (one time)

1. Put the `tiny-athens` folder somewhere easy, e.g. your **Documents** folder.
2. If you don't have **Node.js**, install the LTS version from <https://nodejs.org> (the macOS installer).
3. Open **Terminal** (Spotlight → "Terminal") and run:

```bash
cd ~/Documents/tiny-athens
bash setup.sh
```

This installs Python and its libraries (into the project folder only), a headless browser for rendering, the 3D renderer, and downloads the two AI models (~3 GB). It needs about **15 GB free**. At the end it should print `Apple GPU (MPS) available: True`.

4. Add your keys:

```bash
open -e .env
```

Paste the Google key after `GOOGLE_TILES_API_KEY=` and the Gemini key after `GEMINI_API_KEY=`. Save and close.

> Every command below is run from inside the `tiny-athens` folder (`cd ~/Documents/tiny-athens`).

---

## 3. Render the pilot area

```bash
uv run scripts/render.py --area pilot
```

This renders the 18 shots of the area, the ring of shots around it (context for later), and about 80 random shots nearby (extra training material only). It skips anything already rendered, so you can re-run it after an interruption.

**Check:** open `out/render_pilot.jpg`. You should see the Acropolis and Plaka from above at an angle, looking like a 3D Google Earth view.

If something looks off:
- **All sky-blue or blank:** the Google key isn't working. Check that the Map Tiles API is enabled and the key is in `.env`.
- **Blurry:** lower `error_target` in `config.json` (e.g. 4) and delete the `renders/` folder before re-running. This downloads more detail.
- **Area in the wrong place:** change `center_lat` / `center_lon` of `pilot` in `config.json`, then re-run. Don't change anything under `"camera"`.

To watch it work, add `--show` to the command.

---

## 4. Teacher drawings from Gemini

```bash
uv run scripts/make_pairs.py
```

Gemini redraws up to 120 render shots as pixel art, about one every 7 seconds. Each drawing is checked automatically:

- **flat:** is it real pixel art, not a filtered photo?
- **edges:** does it keep the buildings in the same place as the render?

Bad drawings are retried twice, then dropped. If the daily free quota runs out, the script says so; run it again the next day and it continues.

**Review:** open `pairs/review.html` in your browser (double-click it). The render is on the left and the drawing on the right; faded rows were rejected.

- **Delete** any accepted drawing you don't like from `pairs/targets/`. Look for invented buildings, wrong places, a messy style, or cars.
- If good-looking drawings were rejected, lower `min_flat_share` or `min_edge_match` in `config.json` a little and run again. The script prints the typical scores to guide you.
- Aim for **60–100 good drawings**. More variety (streets, parks, hills, monuments) gives better results.

---

## 5. Train the style model

```bash
caffeinate -i uv run scripts/train_lora.py
```

This first encodes the drawings (a few minutes), then trains for 1,500 steps. It prints progress and the time left, and saves a checkpoint every 250 steps (`out/lora/step_250`, `step_500`, …). If it stops, run the same command to continue. The finished model goes to `out/lora/final/`.

---

## 6. Preview a small patch and tune

```bash
uv run scripts/generate.py --area pilot --preview
```

This draws only the cell in the middle of the area plus a little around it (5–10 min), and saves the render and drawing side by side in `out/previews/`.

To compare without your style model:

```bash
uv run scripts/generate.py --area pilot --preview --no-lora
```

Settings you can try, one at a time:

| If the drawing… | Try |
|---|---|
| looks too much like the photo | `--strength 0.7` (default 0.6) |
| invents things, or buildings drift | `--strength 0.5` or `--control 1.0` |
| looks washed out or too wild | `--guidance 4` or `--guidance 7` (default 5) |
| looks better with an earlier model | `--lora step_1000` |

Once you like a combination, write it into `config.json` under `"generate"` so the full run uses it.

---

## 7. Generate the whole pilot area

```bash
caffeinate -i uv run scripts/generate.py --area pilot
```

This draws the whole area as one image and prints the time left. Progress is saved after every step; if it stops, run the same command to continue. When it finishes:

- the map cells are in `out/cells/`
- an overview is in `out/map_pilot.jpg`

To redraw after changing settings, add `--redo`.

---

## 8. Make tiles and open the viewer

```bash
uv run scripts/make_tiles.py
uv run python -m http.server 8000 -d viewer
```

Open <http://localhost:8000>. Scroll to zoom and drag to move. The **3D render** button (or the `r` key) switches to the original render for comparison. Press `Ctrl+C` in Terminal to stop the viewer.

---

## Growing the map in stages

The camera under `"camera"` in `config.json` is fixed for the whole future map. **Never change it**, or new stages won't line up with old ones.

To add the next stage (an example `centre` area is already in `config.json`):

```bash
uv run scripts/render.py --area centre
caffeinate -i uv run scripts/generate.py --area centre
uv run scripts/make_tiles.py
```

Cells you already finished are **kept and pinned**: the new area grows out of them instead of being stitched on, so there's no seam. Only the new cells are drawn. You can add your own areas the same way: give each a name, `center_lat`, `center_lon`, `shots_x`, `shots_y`. Each shot is about 300 m wide.

Keep areas to roughly **12 × 8 shots or less** per run on a 16 GB Mac, and use several areas for bigger regions.

Keep using the same style model for every stage. If you retrain it later, redraw the earlier areas with `--redo` so the style matches everywhere.

---

## Live buses and trolleys

Click **🚍 Live transit** in the viewer to see OASA buses and trolleys moving on the map, with their line number on each dot. Hover a dot for its delay. Grey dots have a position more than 2 minutes old.

The data comes from [athens-transit-rt](https://angelospk.github.io/athens-transit-rt/), the public API behind [staseis.gr](https://staseis.gr), built on OASA open data. It needs no key and no extra program: the viewer fetches it directly, only for the part of Athens your map covers, and only when the API says new positions are ready (at most every 10 seconds). It keeps working when the map is published online.

To put a GPS position on the slanted map, the viewer needs the ground height there. `make_tiles.py` measures it from Google's 3D tiles on a 40 m grid and saves the result in `viewer/geo.json`. The first time takes about 10–20 minutes; after you add an area, only the new part is measured. To redo it by hand: `uv run scripts/make_geo.py`.

Right around the Acropolis there are few roads, so expect only a handful of vehicles in the pilot area. Busier streets appear as you grow the map.

---

## Publishing (optional, free)

The `viewer/` folder is a complete static website. To put it online for free with GitHub Pages:

1. Create a repository on GitHub, e.g. `tiny-athens`.
2. Upload the contents of `viewer/` (including `tiles/`).
3. In the repository settings, go to **Pages → Deploy from a branch → main / root**.

The site appears at `https://<your-username>.github.io/tiny-athens`. Keep the credits line in the viewer. Read Google's Map Tiles terms before publishing imagery derived from their tiles.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `command not found: uv` | Open a new Terminal window (setup added it to your PATH), or run `source ~/.local/bin/env`. |
| `MPS available: False` | You need macOS 13 or newer on Apple Silicon. Run `softwareupdate -l`. |
| Render shots are blank or sky-blue | Check the Google key, and that the Map Tiles API is enabled for that project. |
| Gemini: model not found | Google renamed the free image model. Put the new name in `GEMINI_IMAGE_MODEL` in `.env`. |
| Gemini rejects everything | Look at `pairs/review.html`. If the drawings look fine, lower the two thresholds in `config.json`. |
| Out of memory during generate | Make the area smaller, or set `margin_px` to 256 in `config.json`. |
| A run was interrupted | Run the same command again; every step resumes. |
| Black image after generate | Report the message. As a test, run `--preview --no-lora`. |

## What's in the folder

```
config.json          camera, areas and all settings
.env                 your two API keys (never share this file)
setup.sh             one-time setup
render/              the 3D renderer page (three.js + Google 3D tiles)
scripts/render.py    step 3
scripts/make_pairs.py  step 4
scripts/train_lora.py  step 5
scripts/generate.py  steps 6-7 (the seamless joint sampler)
scripts/make_tiles.py  step 8 (also runs make_geo.py for live transit)
scripts/make_geo.py  GPS -> map pixel table for live transit
viewer/              the web viewer (and later, the website)
renders/ pairs/ out/ created as you go
```

Credits: renderer adapted from Andy Coenen's [isometric-nyc](https://github.com/cannoneyed/isometric-nyc) (MIT; the style sample in `assets/` comes from it too). The method follows Boris Starkov's write-up of [tiny.london](https://tiny.london/how/). Models: Stable Diffusion 1.5 (CreativeML OpenRAIL-M) and ControlNet canny by lllyasviel.
