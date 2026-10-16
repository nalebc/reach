import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { main } from "../scripts/agent-remote.mjs";
import { main as credentialMain } from "../scripts/agent-cli.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";

async function fixture(t) {
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-expiry-")));
  const shared = path.join(temporary, "shared");
  fs.mkdirSync(shared);
  const reach = await createReach({ roots: [shared], dataDir: path.join(temporary, "private"), screen: false });
  t.after(async () => { await reach.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const grant = reach.auth.inviteAgent({ name: "Timed agent", ttlSeconds: 60, folders: [{ root: 0, path: "" }] });
  const joined = admitAgent(reach.auth, grant.invitation);
  const home = path.join(temporary, "agent-home");
  const conn = path.join(home, "fixture");
  fs.mkdirSync(conn, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(conn, "credential.json"), JSON.stringify({
    version: 1, via: "direct", computer: "Fixture", origin: `http://127.0.0.1:${reach.server.address().port}`,
    token: joined.token, clientId: joined.clientId, scopes: joined.scopes,
    expiresAt: joined.expiresAt, joinedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const credentialFile = path.join(temporary, "legacy-credential.json");
  fs.writeFileSync(credentialFile, JSON.stringify({ url: `http://127.0.0.1:${reach.server.address().port}`, ...joined }), { mode: 0o600 });
  const previousHome = process.env.REACH_AGENT_HOME;
  process.env.REACH_AGENT_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.REACH_AGENT_HOME;
    else process.env.REACH_AGENT_HOME = previousHome;
  });
  let output = "";
  t.mock.method(process.stdout, "write", chunk => { output += chunk; return true; });
  const call = async (legacy = false) => {
    output = "";
    const code = legacy
      ? await credentialMain(["device", "--credential", credentialFile, "--allow-local"])
      : await main(["call", "reach_device", "{}", "--allow-local"]);
    return { code, device: JSON.parse(output) };
  };
  return { reach, joined, call, legacyCall: () => call(true) };
}

test("an owner-extended CLI connection still works after its saved expiry passes", async t => {
  const f = await fixture(t);
  const extended = f.joined.expiresAt + 60_000;
  f.reach.auth.changeAccess(f.joined.clientId, { folders: "keep", expiresAt: extended });
  t.mock.method(Date, "now", () => f.joined.expiresAt + 1000);
  assert.ok(f.reach.auth.verify(f.joined.token), "the owner extended this same credential on Reach");
  const result = await f.call();
  assert.equal(result.code, 0);
  assert.equal(result.device.access.expiresAt, extended);
});

for (const ended of ["expired", "revoked"]) test(`Reach still refuses a CLI grant that is ${ended} with stale local expiry`, async t => {
  const f = await fixture(t);
  const extended = f.joined.expiresAt + 60_000;
  f.reach.auth.changeAccess(f.joined.clientId, { folders: "keep", expiresAt: extended });
  if (ended === "revoked") f.reach.auth.revoke(f.joined.clientId);
  t.mock.method(Date, "now", () => ended === "expired" ? extended + 1000 : f.joined.expiresAt + 1000);
  assert.equal(f.reach.auth.verify(f.joined.token), null);
  await assert.rejects(f.call(), { status: 401 }, "the computer remains the authority for the live deadline and revocation");
});

test("the credential-file CLI accepts the same grant when its owner extended the saved expiry", async t => {
  const f = await fixture(t), extended = f.joined.expiresAt + 60_000;
  f.reach.auth.changeAccess(f.joined.clientId, { folders: "keep", expiresAt: extended });
  t.mock.method(Date, "now", () => f.joined.expiresAt + 1000);
  assert.ok(f.reach.auth.verify(f.joined.token));
  const result = await f.legacyCall();
  assert.equal(result.code, 0);
  assert.equal(result.device.access.expiresAt, extended);
});

for (const ended of ["expired", "revoked"]) test(`the credential-file CLI still lets Reach refuse a grant that is ${ended}`, async t => {
  const f = await fixture(t), extended = f.joined.expiresAt + 60_000;
  f.reach.auth.changeAccess(f.joined.clientId, { folders: "keep", expiresAt: extended });
  if (ended === "revoked") f.reach.auth.revoke(f.joined.clientId);
  t.mock.method(Date, "now", () => ended === "expired" ? extended + 1000 : f.joined.expiresAt + 1000);
  assert.equal(f.reach.auth.verify(f.joined.token), null);
  await assert.rejects(f.legacyCall(), { status: 401 });
});
