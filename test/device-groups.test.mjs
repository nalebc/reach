import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";

// Your access list: one row per device, however many browsers it used.
const source = await fs.readFile(new URL("../src/device-groups.ts", import.meta.url), "utf8");
const outputText = transpile(source);
const { groupDevices } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("browsers of one phone are one row; guests and agents stay separate", () => {
  const t = (nodeId) => ({ userId: "42", nodeId });
  const rows = groupDevices([
    { id: "safari", kind: "device", tailscale: t("nPhone"), expiresAt: 10 },
    { id: "chrome", kind: "device", tailscale: t("nPhone"), deviceGroup: "nPhone", expiresAt: 30 },
    { id: "web1", kind: "device", tailscale: t("nWeb1") },
    { id: "web2", kind: "device", tailscale: t("nWeb2"), deviceGroup: "nWeb1" },
    { id: "mac", kind: "device", tailscale: t("nMac") },
    { id: "old", kind: "device" },
    { id: "guest1", kind: "guest", tailscale: t("nPhone") },
    { id: "agent1", kind: "agent" },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.ids, r.expiresAt]),
    [
      ["safari", ["safari", "chrome"], 30],
      ["web1", ["web1", "web2"], undefined],
      ["mac", ["mac"], undefined],
      ["old", ["old"], undefined],
      ["guest1", ["guest1"], undefined],
      ["agent1", ["agent1"], undefined],
    ],
  );
});
