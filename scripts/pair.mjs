import crypto from "node:crypto";
import { getConfig, atomicJson } from "../server/core.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "./home.mjs";
// The same data folder ./reach uses (state/quick), whatever folder this runs in.
process.env.REACH_DATA ||= path.join(stateDir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")), "quick");
const config = getConfig();
const code = crypto.randomInt(10000000, 100000000).toString();
atomicJson(path.join(config.dataDir, "pairing.json"), {
  code,
  expiresAt: Date.now() + 600000,
});
console.log(
  `Pairing code: ${code.slice(0, 4)} ${code.slice(4)}\nOne use. Expires in 10 minutes.`,
);
