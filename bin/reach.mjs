#!/usr/bin/env node
// `reach` on your PATH (npm install --global @nalebc/reach): the same launcher
// as ./reach in a source checkout. Reach itself runs under a supervisor that
// starts it again in this window when it stopped by itself
// (scripts/supervise.mjs); every other command runs as before.
import { fileURLToPath } from "node:url";
import { runsReach, superviseReach } from "../scripts/supervise.mjs";

const args = process.argv.slice(2);
if (runsReach(args) && process.env.REACH_SUPERVISED !== "1")
  process.exitCode = await superviseReach({ script: fileURLToPath(new URL("../scripts/bootstrap.mjs", import.meta.url)), args });
else await import("../scripts/bootstrap.mjs");
