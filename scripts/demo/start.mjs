// Local UI-only fixture. Never starts Reach, Tailscale, or a real terminal.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.PORT || 5201);
// Match the companion's policy so preview/worker captures exercise its real
// browser restrictions instead of Vite's unrestricted development defaults.
const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const server = await createServer({
  configFile: false,
  root,
  optimizeDeps: { include: ["pdfjs-dist", "react", "react-dom/client"] },
  server: { host: "127.0.0.1", port, strictPort: true,
    headers: { "Content-Security-Policy": policy, "X-Content-Type-Options": "nosniff" } },
  plugins: [
    {
      name: "reach-readme-demo",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            '<!doctype html><html><head><title>Reach UI demo · Sample data</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/demo/entry.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
});
await server.listen();
console.log(`Reach UI demo (sample data only): http://127.0.0.1:${port}`);
