import { spawnSync } from "node:child_process";
import { prepareTailscale } from "./tailscale.mjs";
const cli = process.env.REACH_TAILSCALE || "tailscale";
try {
  const origin = await prepareTailscale(8443);
  const result = spawnSync(
    cli,
    [
      "serve",
      "--bg",
      "--https=8443",
      `http://127.0.0.1:${process.env.PORT || 4317}`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0)
    throw Error(
      "Enable Tailscale Serve using the link above, then run npm run share again.",
    );
  console.log(
    `\nOpen on your phone: ${origin}\nKeep Tailscale connected on both devices. Run npm run pair for a fresh pairing code.\nTo stop sharing: tailscale serve --https=8443 off`,
  );
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
