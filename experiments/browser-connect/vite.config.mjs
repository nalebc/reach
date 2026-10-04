import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // A hot reload destroys an in-memory browser node during login. Keep the
  // experiment stable until the user explicitly reloads.
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    hmr: false,
    watch: null,
  },
  build: { outDir: "dist" },
});
