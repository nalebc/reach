import crypto from "node:crypto";
import path from "node:path";
import { getConfig, atomicJson } from "../server/core.mjs";
const config = getConfig();
const code = crypto.randomInt(10000000, 100000000).toString();
atomicJson(path.join(config.dataDir, "pairing.json"), {
  code,
  expiresAt: Date.now() + 600000,
});
console.log(
  `Pairing code: ${code.slice(0, 4)} ${code.slice(4)}\nOne use. Expires in 10 minutes.`,
);
