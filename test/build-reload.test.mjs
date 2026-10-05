import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startDom } from "./dom/harness.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

let dom, reload;
before(async () => {
  dom = await startDom({ mobile: true });
  reload = await dom.load("/src/build-reload.ts");
});
after(() => dom?.close());

test("a page left open on an old phone interface reloads once Reach serves a new one, never mid-typing", () => {
  const { noteBuild, forgetBuild, busyHere } = reload;
  forgetBuild();
  let reloads = 0;
  const waits = [];
  const options = { reload: () => reloads++, busy: () => busyHere(dom.document), wait: (f) => waits.push(f) };
  // The first build seen is this page's; the same again changes nothing.
  noteBuild("old", options);
  noteBuild("old", options);
  noteBuild(undefined, options);
  assert.equal(reloads, 0);
  // A message half written: the reload waits for it.
  const field = dom.document.createElement("textarea");
  field.value = "half a thought";
  dom.document.body.append(field);
  noteBuild("new", options);
  assert.equal(reloads, 0);
  assert.equal(waits.length, 1);
  // Sent (or cleared): the page takes the new interface, once.
  field.value = "";
  waits.shift()();
  assert.equal(reloads, 1);
  noteBuild("newer", options);
  assert.equal(reloads, 1);
  field.remove();
  // A question being answered or a sign-in under way counts as busy too.
  const card = dom.document.createElement("div");
  card.className = "sign-in";
  card.setAttribute("role", "group");
  dom.document.body.append(card);
  assert.equal(busyHere(dom.document), true);
  card.remove();
  assert.equal(busyHere(dom.document), false);
});

test("Reach's live connection says which phone interface it serves", { timeout: 15000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "reach-build-"));
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, ".reach") });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const socket = new WebSocket(`ws://127.0.0.1:${reach.server.address().port}/ws/presence`);
  try {
    await once(socket, "open");
    const reply = once(socket, "message");
    socket.send(JSON.stringify({ type: "auth", token: reach.auth.issue("My phone", ALL_SCOPES).token, kind: "phone" }));
    const [value] = await reply;
    const html = new URL("../dist/index.html", import.meta.url);
    const expected = fs.existsSync(html)
      ? crypto.createHash("sha256").update(fs.readFileSync(html)).digest("base64url").slice(0, 12)
      : undefined;
    assert.equal(JSON.parse(value.toString()).changes?.build, expected);
  } finally {
    socket.close();
    reach.server.close();
    await reach.close?.();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
