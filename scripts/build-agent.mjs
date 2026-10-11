// Bundles Reach for agents (scripts/agent-remote.mjs and what it uses) into
// one file, dist/agent.mjs, that an invited agent downloads from the
// computer's start page and runs with plain Node 18+.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { keepRuntime } from "../server/runtime-archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Every file the bundle was built from, beside it: Reach rebuilds the bundle
// when any of them changes (scripts/bootstrap.mjs), so a change to a tool's
// schema reaches agents without a hand-kept list of files. A dotfile: the
// phone interface's file server never serves it.
export const inputsFile = (outfile) =>
  path.join(path.dirname(outfile), `.${path.basename(outfile, ".mjs")}-inputs.json`);
// The tailnet client agents fetch from the start page (tailnet/dist): its
// files' SHA-256s ride inside the runtime, which the invitation pins, so what
// an agent runs is exactly what this computer built (connections audit,
// Oct 10).
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
export const tailnetManifest = (dir = path.join(root, "tailnet", "dist")) => path.join(dir, "tailnet.json");
export function tailnetPins(dir = path.join(root, "tailnet", "dist")) {
  try {
    const m = JSON.parse(fs.readFileSync(tailnetManifest(dir), "utf8"));
    const pin = (name) => ({ name, sha256: sha256(fs.readFileSync(path.join(dir, path.basename(name)))) });
    return { exec: pin(m.exec), wasm: pin(m.wasm) };
  } catch {
    return null;
  }
}
// What lets an agent keep up with this computer once it has a copy: its
// self-update, and Reach's own tool list and call plans. Every start builds
// from the shared tree, so a build made while another session's edit had any
// of it out would freeze every agent that took it (Oct 10: the 14:48 build
// shipped without the updater). Such a build is never handed out.
const KEEPS_UP = {
  "self-update": "function runtimeUpdater(",
  "the computer's runtime": '"/api/device/runtime"',
  "Reach's tool list": '"/api/browser/mcp/tools"',
  "Reach's call plans": '"/api/browser/mcp/plan"',
};
export const missingKeepUp = (text) => Object.entries(KEEPS_UP).filter(([, mark]) => !text.includes(mark)).map(([what]) => what);
export async function buildAgent(outfile = path.join(root, "dist/agent.mjs")) {
  // Built beside it first, a dotfile no file server hands out, then checked.
  const next = path.join(path.dirname(outfile), `.${path.basename(outfile)}.next`);
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "scripts/agent-remote.mjs")],
    outfile: next,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    // ws's optional native helpers: it works without them.
    external: ["bufferutil", "utf-8-validate"],
    banner: {
      js: 'import { createRequire as reachRequire } from "node:module"; const require = reachRequire(import.meta.url);',
    },
    // Only the bundle may replace itself with the computer's newer runtime
    // (scripts/agent-remote.mjs): never a source checkout.
    define: { REACH_AGENT_BUNDLE: "true", REACH_TAILNET_PINS: JSON.stringify(tailnetPins()) },
    metafile: true,
    legalComments: "inline",
    logLevel: "warning",
  });
  const missing = missingKeepUp(fs.readFileSync(next, "utf8"));
  if (missing.length && fs.existsSync(outfile)) {
    fs.rmSync(next, { force: true });
    // The last good runtime stays; the next start with the code back rebuilds.
    console.error(`Reach for agents kept its last build: this one lacks ${missing.join(", ")}, so agents that took it would stop keeping up.`);
    return outfile;
  }
  fs.renameSync(next, outfile);
  const inputs = Object.keys(metafile.inputs).filter((file) => !file.split(/[\\/]/).includes("node_modules"));
  // A new tailnet client rebuilds the runtime that pins it.
  if (fs.existsSync(tailnetManifest())) inputs.push(path.relative(root, tailnetManifest()));
  inputs.sort();
  fs.writeFileSync(inputsFile(outfile), JSON.stringify(inputs, null, 2) + "\n");
  keepRuntime(outfile);
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(
    `Built ${path.relative(root, await buildAgent(process.argv[2] && path.resolve(process.argv[2])))}`,
  );
