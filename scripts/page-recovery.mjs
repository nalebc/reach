import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";

// HTML module entries are combined by Vite. Recovery needs its own complete
// script, so a blocked app dependency cannot prevent it from starting too.
export function pageRecovery() {
  let root, filename;
  return {
    name: "reach-independent-recovery",
    apply: "build",
    configResolved(config) { root = config.root; },
    async buildStart() {
      const result = await build({
        entryPoints: [path.join(root, "src/recovery-entry.ts")],
        bundle: true, write: false, minify: true, format: "iife",
        target: ["es2020", "safari14"], logLevel: "silent",
      });
      const source = result.outputFiles[0].contents;
      const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
      filename = `assets/r2-recovery-${hash}.js`;
      this.emitFile({ type: "asset", fileName: filename, source, name: "recovery-entry.js", originalFileName: "src/recovery-entry.ts" });
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(/<script\b[^>]*\bsrc="\/src\/recovery-entry\.ts"[^>]*><\/script>/g,
          `<script async src="/${filename}" data-reach-recovery></script>`);
      },
    },
  };
}
