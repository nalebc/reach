import { transformSync } from "esbuild";

// An interface source (src/*.ts) as JavaScript a test can import: types
// removed, the rest as written (ES2022 modules). TypeScript 7 is a native
// compiler without a JavaScript API, so esbuild (already Reach's agent
// bundler) does this.
export const transpile = (source) =>
  transformSync(source, { loader: "ts", format: "esm", target: "es2022" }).code;
