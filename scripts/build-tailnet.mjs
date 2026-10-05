// Builds the browser tailnet client (tailnet/*.go → WebAssembly) so phones
// without the Tailscale app can sign in from the browser. Needs Go; the exact
// Go version comes from tailnet/go.mod and is fetched by Go itself.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const tailnetSource = path.join(root, "tailnet");
export const tailnetOut = path.join(tailnetSource, "dist");
const SOURCES = ["main.go", "go.mod", "go.sum"];

export function tailnetDigest(dir = tailnetSource) {
  const h = crypto.createHash("sha256");
  for (const name of SOURCES) h.update(fs.readFileSync(path.join(dir, name)));
  return h.digest("hex");
}

export function tailnetCurrent(out = tailnetOut) {
  try {
    const m = JSON.parse(
      fs.readFileSync(path.join(out, "tailnet.json"), "utf8"),
    );
    return (
      m.source === tailnetDigest() &&
      fs.existsSync(path.join(out, m.wasm)) &&
      fs.existsSync(path.join(out, m.exec))
    );
  } catch {
    return false;
  }
}

const hashed = (name, data) => {
  const ext = path.extname(name);
  return `${path.basename(name, ext)}.${crypto.createHash("sha256").update(data).digest("hex").slice(0, 12)}${ext}`;
};

export async function buildTailnet({
  out = tailnetOut,
  go = "go",
  log = console.log,
} = {}) {
  const env = {
    ...process.env,
    GOOS: "js",
    GOARCH: "wasm",
    GOTOOLCHAIN: "auto",
    CGO_ENABLED: "0",
  };
  try {
    await exec(go, ["version"], { env, timeout: 15000 });
  } catch {
    return null; // No Go: phones need the Tailscale app until it's built.
  }
  const stage = fs.mkdtempSync(path.join(path.dirname(out), ".tailnet-build-"));
  try {
    const wasmFile = path.join(stage, "reach-tailnet.wasm");
    await exec(
      go,
      ["build", "-trimpath", "-ldflags", "-s -w", "-o", wasmFile, "."],
      { cwd: tailnetSource, env, timeout: 15 * 60000, maxBuffer: 16 << 20 },
    );
    // wasm_exec.js must come from the same Go that built the module.
    const { stdout } = await exec(go, ["env", "GOROOT"], {
      cwd: tailnetSource,
      env,
      timeout: 60000,
    });
    const goroot = stdout.trim();
    const glue = [
      path.join(goroot, "lib/wasm/wasm_exec.js"),
      path.join(goroot, "misc/wasm/wasm_exec.js"),
    ].find((f) => fs.existsSync(f));
    if (!glue) throw Error("wasm_exec.js was not found in the Go toolchain.");
    const wasm = fs.readFileSync(wasmFile);
    const execJs = fs.readFileSync(glue);
    const names = {
      wasm: hashed("reach-tailnet.wasm", wasm),
      exec: hashed("wasm_exec.js", execJs),
    };
    log("Reach: compressing the browser sign-in client (one time)…");
    for (const [name, data] of [
      [names.wasm, wasm],
      [names.exec, execJs],
    ]) {
      fs.writeFileSync(path.join(stage, name), data);
      fs.writeFileSync(
        path.join(stage, `${name}.br`),
        zlib.brotliCompressSync(data, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        }),
      );
      fs.writeFileSync(
        path.join(stage, `${name}.gz`),
        zlib.gzipSync(data, { level: 9 }),
      );
    }
    fs.rmSync(wasmFile);
    fs.writeFileSync(
      path.join(stage, "tailnet.json"),
      JSON.stringify({ ...names, source: tailnetDigest() }),
    );
    fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(stage, out);
    return names;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const required = process.argv.includes("--required");
  const output = process.argv.slice(2).find((arg) => arg !== "--required");
  const out = output ? path.resolve(output) : tailnetOut;
  const names = tailnetCurrent(out)
    ? JSON.parse(fs.readFileSync(path.join(out, "tailnet.json"), "utf8"))
    : await buildTailnet({ out });
  if (required && !names)
    throw Error("Go is required to build a release with browser sign-in. Install the version in tailnet/go.mod and retry.");
  console.log(
    names ? `Built ${names.wasm} in ${out}` : "Go is not installed; skipped.",
  );
}
