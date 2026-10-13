#!/usr/bin/env node
// `reach` on your PATH (npm install --global @nalebc/reach): the same launcher
// as ./reach in a source checkout. Reach itself runs under a supervisor that
// starts it again in this window when it stopped by itself
// (scripts/supervise.mjs); every other command runs as before.
import { fileURLToPath } from "node:url";
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("Reach needs Node.js 22 or newer. Install it from https://nodejs.org, then run reach again.");
  process.exitCode = 1;
} else {
  const { runsReach, superviseReach } = await import("../scripts/supervise.mjs");
  const args = process.argv.slice(2);
  if (runsReach(args) && process.env.REACH_SUPERVISED !== "1")
    process.exitCode = await superviseReach({ script: fileURLToPath(new URL("../scripts/bootstrap.mjs", import.meta.url)), args });
  else await import("../scripts/bootstrap.mjs");
}
