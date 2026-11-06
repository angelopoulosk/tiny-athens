import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  // Read .env (the Google key) from the project folder, one level up.
  envDir: projectRoot,
  // Expose GOOGLE_TILES_API_KEY directly, no VITE_ prefix or expansion needed.
  envPrefix: ["VITE_", "GOOGLE_"],
  server: {
    // Allow importing ../config.json
    fs: { allow: [projectRoot] },
  },
});
