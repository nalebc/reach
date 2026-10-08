import { defineConfig } from "vite";
import fs from "node:fs";
export default defineConfig({
  plugins: [
    {
      name: "reach-pdf-image-fallbacks",
      generateBundle() {
        for (const name of [
          "jbig2_nowasm_fallback.js",
          "openjpeg_nowasm_fallback.js",
        ])
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${name}`,
            source: fs.readFileSync(
              new URL(
                `./node_modules/pdfjs-dist/wasm/${name}`,
                import.meta.url,
              ),
            ),
          });
      },
    },
  ],
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
        // Previous delivery failures could be cached as immutable 404s. Keep a
        // stable new URL generation for the entire import graph so affected
        // phones recover without clearing their paired-device storage.
        entryFileNames: "assets/r2-[name]-[hash].js",
        chunkFileNames: "assets/r2-[name]-[hash].js",
        assetFileNames: "assets/r2-[name]-[hash][extname]",
        // xterm loads only with a terminal. Other libraries (React, icons) get
        // their own chunk, which stays cached across Reach updates. Capacitor's
        // web shims are loaded on demand, so they stay out of it.
        manualChunks: (id) =>
          id.includes("/node_modules/highlight.js/")
            ? "syntax"
            : /\/node_modules\/(react-markdown|remark[^/]*|rehype[^/]*|unified|micromark[^/]*|mdast[^/]*|hast[^/]*|unist[^/]*|vfile[^/]*)\//.test(
                  id,
                )
              ? "markdown"
              : id.includes("/node_modules/pdfjs-dist/")
                ? "pdf"
                : id.includes("/node_modules/@xterm/")
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
