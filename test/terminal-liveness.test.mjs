import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// A phone that left without closing (a network change) never answers a ping:
// its terminal connection ends instead of holding one of the 64 places until
// TCP notices (reliability audit, Oct 10). A phone that answers stays.
test("a terminal connection that answers no ping is ended; one that answers stays", { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-liveness-"));
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), terminalPingMs: 150 });
  t.after(async () => { await reach.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${reach.server.address().port}/ws/terminal`;
  const owner = reach.auth.issue("test", ALL_SCOPES);
  const terminal = reach.terminals.create({ cwd: dir, name: "liveness", clientId: owner.id });
  const open = async (options) => {
    const ws = new WebSocket(url, options);
    await once(ws, "open");
    const snapshot = once(ws, "message");
    ws.send(JSON.stringify({ type: "auth", token: owner.token, sessionId: terminal.id }));
    assert.equal(JSON.parse((await snapshot)[0]).type, "snapshot");
    return ws;
  };
  const gone = await open({ autoPong: false });
  const here = await open();
  const [code] = await once(gone, "close");
  assert.equal(code, 1006, "ended without a close handshake");
  // Several pings later the one that answers is still open.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(here.readyState, WebSocket.OPEN);
  here.close();
});
