import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";

// A live connection the host guard turns away used to vanish without a word:
// the phone's screen never opened and Reach's log said nothing.
test("a live connection refused by the host guard is logged, once per moment, with its route", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-guard-log-"));
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    // Unreadable clients: the guard is active and refuses (fails closed).
    browserHostGuard: {
      clients: () => {
        throw Error("fixture");
      },
      lookup: async () => ({}),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.join(" "));
  t.after(async () => {
    console.warn = warn;
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `ws://127.0.0.1:${reach.server.address().port}`;
  const attempt = (route) =>
    new Promise((resolve) => {
      const ws = new WebSocket(base + route);
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("refused"));
    });
  assert.equal(await attempt("/ws/screen"), "refused");
  assert.equal(await attempt("/ws/screen"), "refused");
  assert.equal(await attempt("/ws/\u001bnot-a-route"), "refused");
  const lines = logged.filter((l) => l.includes("host guard"));
  assert.equal(lines.filter((l) => l.includes("/ws/screen")).length, 1, "a reconnect loop doesn't flood the log");
  assert.match(lines[0], /^Reach: \/ws\/screen connection refused by the host guard: \S/);
  // A route that isn't Reach's is named generically, never echoed.
  assert.ok(lines.some((l) => l.startsWith("Reach: a live connection refused")));
  assert.equal(lines.some((l) => l.includes("not-a-route")), false);
});
