// Renders Google's photorealistic 3D tiles of Athens through ONE fixed
// orthographic camera. Each "shot" (i, j) is a 1024 px square of a single
// global pixel lattice, made by shifting the camera frustum, never the camera.
// Adapted from Andy Coenen's isometric-nyc renderer (MIT).

import { TilesRenderer, WGS84_ELLIPSOID, CAMERA_FRAME } from "3d-tiles-renderer";
import {
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
} from "3d-tiles-renderer/plugins";
import { Matrix4, Scene, WebGLRenderer, OrthographicCamera, MathUtils, Vector3, Raycaster } from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

import config from "../config.json";

const cam = config.camera;
const SHOT = cam.shot_px;
const MPP = cam.meters_per_pixel;
// Reads the key straight from .env (GOOGLE_TILES_API_KEY), with the old
// VITE_-prefixed name kept as a fallback for any .env written before this fix.
const API_KEY = import.meta.env.GOOGLE_TILES_API_KEY || import.meta.env.VITE_GOOGLE_TILES_API_KEY;

window.TILES_LOADED = false;
window.READY = false;
window.RENDER_ERROR = null;
if (!API_KEY || API_KEY.startsWith("paste-")) {
  window.RENDER_ERROR = "GOOGLE_TILES_API_KEY is missing from .env";
}

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x87ceeb);
renderer.setPixelRatio(1);
renderer.setSize(SHOT, SHOT);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 20000);

const tiles = new TilesRenderer();
tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: API_KEY, autoRefreshToken: true }));
tiles.registerPlugin(new TileCompressionPlugin());
tiles.registerPlugin(
  new GLTFExtensionsPlugin({
    dracoLoader: new DRACOLoader().setDecoderPath(
      "https://www.gstatic.com/draco/versioned/decoders/1.5.7/"
    ),
  })
);
tiles.errorTarget = cam.error_target ?? 6; // lower = sharper, more downloads (library default 16)
tiles.group.rotation.x = -Math.PI / 2; // tiles are Z-up, three.js is Y-up
scene.add(tiles.group);
tiles.group.updateMatrixWorld(true);
tiles.addEventListener("load-error", (e) => {
  console.warn("tile load error", e);
});

// Place the single camera: looking at the origin from the given azimuth and
// elevation, 3 km back along its own view axis.
const frame = new Matrix4();
WGS84_ELLIPSOID.getObjectFrame(
  cam.origin_lat * MathUtils.DEG2RAD,
  cam.origin_lon * MathUtils.DEG2RAD,
  cam.origin_height_m,
  cam.azimuth_deg * MathUtils.DEG2RAD,
  cam.elevation_deg * MathUtils.DEG2RAD,
  0,
  frame,
  CAMERA_FRAME
);
frame.multiply(new Matrix4().makeTranslation(0, 0, 3000));
frame.premultiply(tiles.group.matrixWorld);
frame.decompose(camera.position, camera.quaternion, camera.scale);
camera.updateMatrixWorld(true);

let changedAt = performance.now();
let stableSince = 0;

// Shot (i, j) covers global pixels x in [i*SHOT, (i+1)*SHOT), y in [j*SHOT, (j+1)*SHOT).
// Screen y grows downwards, view-space y grows upwards.
window.setShot = (i, j) => {
  const s = SHOT * MPP;
  camera.left = i * s;
  camera.right = (i + 1) * s;
  camera.top = -j * s;
  camera.bottom = -(j + 1) * s;
  camera.updateProjectionMatrix();
  window.TILES_LOADED = false;
  changedAt = performance.now();
  stableSince = 0;
};

// Global pixel position of a lat/lon (at the given ellipsoid height).
window.latLonToPx = (lat, lon, height) => {
  const p = new Vector3();
  WGS84_ELLIPSOID.getCartographicToPosition(
    lat * MathUtils.DEG2RAD,
    lon * MathUtils.DEG2RAD,
    height ?? cam.origin_height_m,
    p
  );
  p.applyMatrix4(tiles.group.matrixWorld);
  p.applyMatrix4(camera.matrixWorldInverse);
  return [p.x / MPP, -p.y / MPP];
};

// Ground (ellipsoid) height at each [lat, lon], measured by dropping a ray
// straight down onto the loaded 3D tiles. To skip roofs and trees, each point
// takes the LOWEST hit among a few samples a little around it. Returns null
// where nothing is loaded. Only tiles near the current shot are loaded, so
// call setShot first and wait for TILES_LOADED.
const raycaster = new Raycaster();
const TOP_M = 1500, BOTTOM_M = -100;
function dropRay(lat, lon) {
  const a = new Vector3(), b = new Vector3();
  WGS84_ELLIPSOID.getCartographicToPosition(lat * MathUtils.DEG2RAD, lon * MathUtils.DEG2RAD, TOP_M, a);
  WGS84_ELLIPSOID.getCartographicToPosition(lat * MathUtils.DEG2RAD, lon * MathUtils.DEG2RAD, BOTTOM_M, b);
  a.applyMatrix4(tiles.group.matrixWorld);
  b.applyMatrix4(tiles.group.matrixWorld);
  const len = a.distanceTo(b);
  raycaster.set(a, b.clone().sub(a).normalize());
  raycaster.far = len;
  const hits = raycaster.intersectObject(tiles.group, true);
  if (!hits.length) return null;
  // Distance along the ray maps linearly onto height (the ray follows the normal).
  return TOP_M - (hits[0].distance / len) * (TOP_M - BOTTOM_M);
}
window.groundHeights = (points, spreadM = 10) => {
  const dLat = spreadM / 111320;
  return points.map(([lat, lon]) => {
    const dLon = dLat / Math.cos(lat * MathUtils.DEG2RAD);
    let best = null;
    for (const [u, v] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const h = dropRay(lat + u * dLat, lon + v * dLon);
      if (h != null && (best == null || h < best)) best = h;
    }
    return best;
  });
};

window.setShot(0, 0);
window.READY = true;

function animate() {
  requestAnimationFrame(animate);
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.update();
  renderer.render(scene, camera);

  // Loaded = nothing downloading or parsing for 1.5 s, at least 2.5 s after a move.
  const now = performance.now();
  const busy = tiles.isLoading || tiles.stats.downloading > 0 || tiles.stats.parsing > 0;
  if (busy || now - changedAt < 2500) {
    stableSince = 0;
    window.TILES_LOADED = false;
  } else if (stableSince === 0) {
    stableSince = now;
  } else if (now - stableSince > 1500) {
    window.TILES_LOADED = true;
  }
}
animate();
