import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { firstInstall, finishFirstSetup, SIGN_IN_LINK } from "./helpers/first-install.mjs";

// Opt in: actually downloads Reach's pinned Node (including its checksum
// check), runs npm ci and builds the interface. Tailscale stays simulated.
// Nothing is installed globally and the whole temporary checkout is removed.
test("source first install without Node, npm, Go or Tailscale: runtime, dependencies, build, setup, phone approval and file", {
  skip: process.platform !== "linux" || !process.env.REACH_TEST_SOURCE_INSTALL,
  timeout: 240000,
}, async t => {
  const reach = await firstInstall(t, { source: true, missing: true, status: { BackendState: "NeedsLogin" } });
  await reach.until(/preparing a private Node.js runtime/);
  await reach.until(/Install Tailscale to continue/, 120000);
  await reach.until(/Choose 1–\d+ \[\d+\], or q to cancel: /);
  reach.answer("");
  await reach.until(/waiting for Tailscale to be installed/);
  await reach.installTailscale();
  await reach.until(SIGN_IN_LINK);
  await reach.fake.setStatus({ BackendState: "Running" });
  await finishFirstSetup(reach, { source: true });
  assert.match(reach.output(), /Go isn't installed, so phones need the Tailscale app/);
  assert.ok((await fs.stat(path.join(reach.app, "dist/index.html"))).size > 0);
  const config = await reach.request("/reach-start.json", { public: true });
  assert.equal(config.json.tailnet, null, "without a Go build the start page offers the phone app");
  const request = await reach.request("/api/auth/requests", { body: { name: "First source-install phone" } });
  assert.equal(request.status, 202, request.text);
  assert.equal((await reach.request("/api/files")).status, 401);
  reach.answer(request.json.verification);
  let result;
  for (let n = 0; n < 100; n++) {
    result = await reach.request(`/api/auth/requests/${request.json.id}`, { body: { secret: request.json.secret } });
    if (result.json.token) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(result.json.status, "approved");
  const file = await reach.request("/api/files/text?root=0&path=welcome.txt", { token: result.json.token });
  assert.equal(file.status, 200);
  assert.match(file.text, /First installation works/);
});


// This must refuse before copying files, downloading a runtime or spawning
// anything: a Mac's app-bundled Tailscale bypasses an emptied PATH.
test("the cold source-install harness refuses macOS before setup", { skip: process.platform !== "darwin" }, async t => {
  t.mock.method(fs, "mkdtemp", async () => { throw Error("unsafe cold source initialization"); });
  await assert.rejects(firstInstall(t, { source: true }), /cold source.*Linux/i);
});
