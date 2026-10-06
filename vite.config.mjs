import { defineConfig } from "vite";
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/ws": { target: "ws://127.0.0.1:4317", ws: true },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      // start.html: the public start page (server/public-start.mjs).
      input: { index: "index.html", start: "start.html", agent: "agent.html" },
      output: {
        // xterm loads only with a terminal. Other libraries (React, icons) get
        // their own chunk, which stays cached across Reach updates. Capacitor's
        // web shims are loaded on demand, so they stay out of it.
        manualChunks: (id) =>
          id.includes("/node_modules/@xterm/")
            ? "terminal"
            : // The public start page needs only this helper, not all libraries.
              /vite\/(preload-helper|modulepreload-polyfill)/.test(id)
              ? "preload"
              : (id.includes("/node_modules/") || id.startsWith("\0")) &&
                  !id.includes("/dist/esm/web.js")
                ? "vendor"
                : undefined,
      },
    },
  },
});
