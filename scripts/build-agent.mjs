// Bundles Reach for agents (scripts/agent-remote.mjs and what it uses) into
// one file, dist/agent.mjs, that an invited agent downloads from the
// computer's start page and runs with plain Node 18+.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function buildAgent(outfile = path.join(root, "dist/agent.mjs")) {
  await build({
    entryPoints: [path.join(root, "scripts/agent-remote.mjs")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    // ws's optional native helpers: it works without them.
    external: ["bufferutil", "utf-8-validate"],
    banner: {
      js: 'import { createRequire as reachRequire } from "node:module"; const require = reachRequire(import.meta.url);',
    },
    legalComments: "inline",
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(
    `Built ${path.relative(root, await buildAgent(process.argv[2] && path.resolve(process.argv[2])))}`,
  );
