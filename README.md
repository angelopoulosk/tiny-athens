# tiny athens

An isometric pixel-art map of Athens with live buses and trolleys, in the spirit of [tiny.london](https://tiny.london). It is made almost entirely on a MacBook Air, with a small open image model instead of a big cloud pipeline.

**How it's made**

1. Athens is rendered from Google's photorealistic 3D tiles through one fixed isometric camera.
2. Gemini redraws about 100 of those renders as pixel art ("teacher" drawings). Automatic checks drop drawings that look like photos or don't line up.
3. A small style model (a LoRA on Stable Diffusion 1.5 with ControlNet) is trained on the Mac from those drawings.
4. The Mac draws each area as one seamless image, then cuts it into zoomable tiles.
5. The viewer (`viewer/`, published with GitHub Pages) shows the map, with live OASA buses and trolleys from the [athens-transit-rt](https://angelospk.github.io/athens-transit-rt/) API behind [staseis.gr](https://staseis.gr).

The map grows in stages: new areas are drawn around finished ones without seams.

**Build it yourself:** see [GUIDE.md](GUIDE.md).

## Credits

- Map imagery derived from Google Photorealistic 3D Tiles. Map data ©Google.
- Live transit: [athens-transit-rt](https://github.com/angelospk/athens-transit-rt) (OASA open data).
- Renderer adapted from Andy Coenen's [isometric-nyc](https://github.com/cannoneyed/isometric-nyc) (MIT, see `assets/LICENSE-isometric-nyc.txt`); the style sample in `assets/` comes from it too.
- Method after Boris Starkov's write-up of [tiny.london](https://tiny.london/how/).
- Models: Stable Diffusion 1.5 (CreativeML OpenRAIL-M) and ControlNet canny by lllyasviel.
