import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, hostedConnector } from "../server/core.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-auth-cache-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  const config = {
    roots: [shared],
    dataDir: path.join(root, "private"),
    agentPolicyFile: path.join(root, "none.json"),
  };
  const reader = createAuth(config);
  const file = path.join(config.dataDir, "clients.json");
  const pin = () =>
    fs.utimesSync(
      file,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
  const invite = (writer) =>
    writer.inviteBrowser({
      name: "Hosted fixture",
      transport: "funnel",
      preset: "files",
      folders: [{ root: 0, path: "" }],
      hosted: true,
      standing: true,
    });
  return { config, reader, file, pin, invite };
}

for (const separateWriter of [false, true]) {
  test(`all public-door caches observe same-mtime credential changes from ${separateWriter ? "another auth instance" : "this auth instance"}`, (t) => {
    const f = fixture(t),
      auth = f.reader;
    const writer = separateWriter
      ? createAuth(f.config, { rotatePairing: false })
      : auth;
    const first = f.invite(writer);
    f.pin();
    const connector = hostedConnector(first.invitation),
      digest = hash(connector);
    assert.equal(auth.hostedConnectors().get(digest)?.waiting, true);
    assert.equal(auth.funnelKeys().size, 0);
    assert.equal(auth.hostedKeys().size, 0);
    const binding = crypto.randomBytes(32).toString("base64url");
    writer.claimHostedInvitation(binding, { connector, clientId: "fixture" });
    f.pin();
    assert.ok(
      auth.funnelKeys().has(binding),
      "the new public browser binding is visible immediately",
    );
    assert.ok(
      auth.hostedKeys().has(binding),
      "the new hosted binding is visible immediately",
    );
    assert.equal(
      auth.hostedConnectors().get(digest)?.waiting,
      false,
      "claimed invitations stop admitting registrations",
    );
    const next = f.invite(writer);
    f.pin();
    assert.equal(
      auth.hostedConnectors().get(hash(hostedConnector(next.invitation)))
        ?.waiting,
      true,
    );

    const person = writer.issue("Fixture phone", ["device"]);
    const firstDoor = writer.issueDoorKey(person.clientId);
    f.pin();
    assert.equal(auth.doorKeyKnown(firstDoor.key), true);
    const secondDoor = writer.issueDoorKey(person.clientId);
    f.pin();
    assert.equal(
      auth.doorKeyKnown(firstDoor.key),
      false,
      "a rotated door key immediately stops opening the public door",
    );
    assert.equal(auth.doorKeyKnown(secondDoor.key), true);
    writer.revoke(person.clientId);
    f.pin();
    assert.equal(
      auth.doorKeyKnown(secondDoor.key),
      false,
      "revocation immediately closes the person's public door",
    );
  });
}

test("successful local credential writes invalidate caches even when filesystem metadata is unchanged", (t) => {
  const f = fixture(t),
    auth = f.reader;
  const person = auth.issue("Fixture phone", ["device"]);
  const first = auth.issueDoorKey(person.clientId);
  const stat = fs.statSync;
  const snapshot = stat(f.file),
    bigSnapshot = stat(f.file, { bigint: true });
  t.mock.method(fs, "statSync", (file, options) =>
    file === f.file
      ? options?.bigint
        ? bigSnapshot
        : snapshot
      : stat(file, options),
  );
  assert.equal(auth.doorKeyKnown(first.key), true);
  const second = auth.issueDoorKey(person.clientId);
  assert.equal(auth.doorKeyKnown(first.key), false);
  assert.equal(auth.doorKeyKnown(second.key), true);
});

test("missing, corrupt or uninspectable credential stores never reuse cached public-door keys", (t) => {
  const f = fixture(t),
    auth = f.reader;
  const grant = f.invite(auth),
    connector = hostedConnector(grant.invitation);
  const binding = crypto.randomBytes(32).toString("base64url");
  auth.claimHostedInvitation(binding, { connector, clientId: "fixture" });
  auth.revoke(grant.clientId); // Ended keys are intentionally remembered for useful 401 responses.
  const person = auth.issue("Fixture phone", ["device"]);
  const door = auth.issueDoorKey(person.clientId);
  assert.ok(auth.funnelKeys().has(binding));
  assert.ok(auth.hostedKeys().has(binding));
  assert.ok(auth.hostedConnectors().has(hash(connector)));
  assert.ok(auth.doorKeyKnown(door.key));
  const closed = () => {
    assert.equal(auth.funnelKeys().size, 0);
    assert.equal(auth.hostedKeys().size, 0);
    assert.equal(auth.hostedConnectors().size, 0);
    assert.equal(auth.doorKeyKnown(door.key), false);
  };
  fs.renameSync(f.file, f.file + ".saved");
  closed();
  fs.renameSync(f.file + ".saved", f.file);
  assert.ok(auth.doorKeyKnown(door.key));
  const saved = fs.readFileSync(f.file);
  fs.writeFileSync(f.file, "{ broken");
  closed();
  fs.writeFileSync(f.file, saved);
  assert.ok(
    auth.funnelKeys().has(binding),
    "ended keys are still remembered after a readable store is restored",
  );
  assert.ok(auth.hostedKeys().has(binding));
  assert.ok(auth.hostedConnectors().has(hash(connector)));
  assert.ok(auth.doorKeyKnown(door.key));
  const stat = fs.statSync;
  t.mock.method(fs, "statSync", (file, ...args) => {
    if (file === f.file)
      throw Object.assign(Error("fixture denied"), { code: "EACCES" });
    return stat(file, ...args);
  });
  closed();
});

test("a transient credential read failure does not cache denial after the store recovers", (t) => {
  const f = fixture(t),
    auth = f.reader;
  const first = f.invite(auth),
    connector = hostedConnector(first.invitation);
  const binding = crypto.randomBytes(32).toString("base64url");
  auth.claimHostedInvitation(binding, { connector, clientId: "fixture" });
  const person = auth.issue("Fixture phone", ["device"]);
  const door = auth.issueDoorKey(person.clientId);
  assert.ok(auth.funnelKeys().has(binding));
  assert.ok(auth.hostedKeys().has(binding));
  assert.ok(auth.hostedConnectors().has(hash(connector)));
  assert.ok(auth.doorKeyKnown(door.key));
  const next = f.invite(auth); // Invalidate the warm caches before the read fails.
  let denied = true;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === f.file && denied)
      throw Object.assign(Error("fixture denied"), { code: "EACCES" });
    return read(file, ...args);
  });
  assert.equal(auth.funnelKeys().size, 0);
  assert.equal(auth.hostedKeys().size, 0);
  assert.equal(auth.hostedConnectors().size, 0);
  assert.equal(auth.doorKeyKnown(door.key), false);
  denied = false; // The filesystem revision remains identical on recovery.
  assert.ok(auth.funnelKeys().has(binding));
  assert.ok(auth.hostedKeys().has(binding));
  assert.equal(
    auth.hostedConnectors().get(hash(hostedConnector(next.invitation)))
      ?.waiting,
    true,
  );
  assert.ok(auth.doorKeyKnown(door.key));
});
