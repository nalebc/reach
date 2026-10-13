import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { transpile } from "./helpers/transpile.mjs";
import {
  identityDigest,
  computerIdentity,
} from "../server/computer-identity.mjs";
import { createReach } from "../server/index.mjs";
const sourceUrl = new URL("../src/api.ts", import.meta.url);
const source = await fs.readFile(sourceUrl, "utf8");
const outputText = transpile(source);
// A data URL has no relative module base. Keep the actual production helper,
// resolving its import against the original TypeScript file before loading.
const resolvedOutput = outputText.replaceAll(
  JSON.stringify("../server/agent-transport.mjs"),
  JSON.stringify(new URL("../server/agent-transport.mjs", sourceUrl).href),
);
const { compactPeers, upsertPeer, reconcilePeers, sameComputer } = await import(
  `data:text/javascript;base64,${Buffer.from(resolvedOutput).toString("base64")}`
);
const peer = (overrides = {}) => ({
  id: "install-old",
  name: "My Mac",
  platform: "darwin",
  url: "https://mac.tail123.ts.net:8443",
  token: "old-fixture",
  ...overrides,
});
const device = (overrides = {}) => ({
  id: "install-new",
  computerId: "machine-a",
  name: "My Mac",
  platform: "darwin",
  network: { hostname: "mac.tail123.ts.net" },
  ...overrides,
});

test("pairing the same endpoint after reset replaces the stale row and token", () => {
  const old = peer();
  const next = peer({
    id: "install-new",
    token: "new-fixture",
    url: old.url + "/",
  });
  assert.deepEqual(upsertPeer([old], next), [next]);
  assert.deepEqual(compactPeers([old, next]), [next]);
});
test("one computer remains one row across addresses and installation IDs", () => {
  const old = peer({ computerId: "machine-a", url: "http://localhost:4317" });
  const next = peer({
    id: "new-install",
    computerId: "machine-a",
    token: "new-fixture",
  });
  assert.deepEqual(upsertPeer([old], next), [next]);
});
test("different computers with identical names are never merged by name", () => {
  const a = peer({ computerId: "machine-a" });
  const b = peer({
    id: "install-b",
    computerId: "machine-b",
    url: "https://other.tail123.ts.net:8443",
  });
  assert.equal(sameComputer(a, b), false);
  assert.equal(compactPeers([a, b]).length, 2);
  assert.equal(
    sameComputer(peer(), peer({ id: "different", url: b.url })),
    false,
  );
  // Strong, conflicting identities also win over an address that was reused.
  assert.equal(sameComputer(a, { ...b, url: a.url }), false);
});
test("migration checks all old credentials and keeps the one that authenticates", async () => {
  const working = peer({ token: "working-fixture" }),
    broken = peer({ id: "broken", token: "revoked-fixture" });
  const checked = [];
  const result = await reconcilePeers([working, broken], async (p) => {
    checked.push(p.token);
    if (p === broken) throw Error("401");
    return device();
  });
  assert.equal(checked.length, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].token, "working-fixture");
  assert.equal(result[0].id, "install-new");
  assert.equal(result[0].computerId, "machine-a");
});
test("authenticated tailnet aliases reconcile an old address without matching names", async () => {
  const old = peer({ url: "https://mac.tail123.ts.net:443" });
  const working = peer({
    id: "working",
    url: "http://localhost:4317",
    token: "working-fixture",
  });
  const result = await reconcilePeers([old, working], async (p) => {
    if (p === old) throw Error("offline");
    return device({ computerId: undefined });
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].url, working.url);
});
test("failed checks preserve distinct offline computers and reject malformed metadata", async () => {
  const a = peer(),
    b = peer({ id: "b", url: "https://b.tail123.ts.net:8443" });
  const result = await reconcilePeers([a, b], async () => ({}));
  assert.deepEqual(result, [a, b]);
});
test("computer identity is normalized, opaque and separate from install state", () => {
  const uuid = "12345678-1234-1234-1234-123456789ABC";
  assert.equal(
    identityDigest(uuid, "darwin"),
    identityDigest(uuid.toLowerCase() + "\n", "darwin"),
  );
  assert.match(identityDigest(uuid, "darwin"), /^[a-f0-9]{64}$/);
  assert.notEqual(
    identityDigest(uuid, "darwin"),
    identityDigest(uuid, "win32"),
  );
  for (const value of [
    undefined,
    "",
    "unknown",
    "00000000-0000-0000-0000-000000000000",
  ])
    assert.equal(identityDigest(value, "darwin"), null);
});
test("reset installation state keeps the OS computer identity and independent session stores", async (t) => {
  const stable = await computerIdentity();
  if (!stable) {
    t.skip("OS identity is unavailable");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-identity-test-"));
  const a = await createReach({
    roots: [root],
    dataDir: path.join(root, "first"),
  });
  const b = await createReach({
    roots: [root],
    dataDir: path.join(root, "second"),
  });
  try {
    const first = JSON.parse(
      await fs.readFile(path.join(root, "first/device.json"), "utf8"),
    );
    const second = JSON.parse(
      await fs.readFile(path.join(root, "second/device.json"), "utf8"),
    );
    assert.notEqual(first.id, second.id);
    assert.equal(first.computerId, second.computerId);
    assert.equal(first.computerId, stable);
    assert.notEqual(a.terminals, b.terminals);
    assert.notEqual(a.codex, b.codex);
  } finally {
    await a.close();
    await b.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
