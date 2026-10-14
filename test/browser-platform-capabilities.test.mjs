import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

async function fixture(t, overrides = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-browser-platform-"));
  const root = path.join(temp, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "brief.txt"), "The owner's files still work.");
  const reach = await createReach({
    roots: [root], dataDir: path.join(temp, "private"), port: 0,
    browserAppSupported: false, agentDesktop: null,
    desktopTerminals: { platform: "linux", run: async () => assert.fail("No native terminal discovery") },
    ...overrides,
  });
  t.after(async () => { await reach.close(); await fs.rm(temp, { recursive: true, force: true }); });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const owner = reach.auth.issue("Owner", ALL_SCOPES, "device");
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const call = async (route, body, token = owner.token) => {
    const response = await fetch(url + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const invite = () => call("/api/agents/browser-invitations", {
    name: "File task", preset: "files", ttlSeconds: 600, transport: "tailnet",
    folders: [{ root: 0, path: "" }],
  });
  return { reach, call, invite };
}

test("browser options expose the actual host's protected file support", async (t) => {
  const f = await fixture(t);
  const options = await f.call("/api/agents/browser-options");
  assert.equal(options.status, 200);
  assert.equal(options.body.protectedFilesSupported, process.platform === "darwin");
  assert.equal(options.body.desktopAvailable, false);
  if (process.platform !== "darwin") {
    const before = f.reach.auth.list();
    const invite = await f.invite();
    assert.equal(invite.status, 503);
    assert.match(invite.body.error, process.platform === "win32" ? /Agent file access isn't ready on this Windows PC yet/ : /file access requires macOS/);
    assert.deepEqual(f.reach.auth.list(), before, "unsupported host issues no credential");
  }
});

test("unsupported browser file invitations fail before credentials; owner and scoped CLI files still work", async (t) => {
  // Exercise the unavailable capability on every CI host without altering
  // process.platform or substituting a permissive native file implementation.
  const f = await fixture(t, { browserFilesSupported: false });
  const options = await f.call("/api/agents/browser-options");
  assert.equal(options.body.protectedFilesSupported, false);
  const before = f.reach.auth.list();
  const refused = await f.invite();
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.match(refused.body.error, process.platform === "win32" ? /Agent file access isn't ready on this Windows PC yet/ : /file access requires macOS/);
  assert.deepEqual(f.reach.auth.list(), before, "failed creation leaves no usable or pending credential");
  const ownFiles = await f.call("/api/files?root=0&path=");
  assert.equal(ownFiles.status, 200);
  assert.ok(ownFiles.body.items.some((item) => item.name === "brief.txt"));
  const ownTerminals = await f.call("/api/terminals");
  assert.equal(ownTerminals.status, 200);
  const cli = f.reach.auth.issue("Scoped CLI", ["device", "files:read"], "agent");
  const read = await f.call("/api/files/text?root=0&path=brief.txt", null, cli.token);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.text, "The owner's files still work.");
});

test("desktop agent presets require native desktop capability before issuing access", async t => {
  const f = await fixture(t);
  const before = f.reach.auth.list();
  for (const preset of ["full", "apps", "readonly"]) {
    const result = await f.call("/api/agents/browser-invitations", {
      name: "Unavailable desktop", preset, ttlSeconds: 600, transport: "tailnet",
      ...(preset === "full" ? { fullControlVersion: 1 } : {}),
      ...(preset === "apps" ? { apps: [{ id: "/Applications/Safari.app" }] } : {}),
    });
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.match(result.body.error, /Screen access for agents/);
    assert.deepEqual(f.reach.auth.list(), before, `${preset} must issue no credential without the native capability`);
  }
});
