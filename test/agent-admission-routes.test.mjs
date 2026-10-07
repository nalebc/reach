import { expectFileResponse } from "./helpers/protected-files.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";

async function start(t) {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-admission-http-")),
  );
  const shared = path.join(dir, "shared");
  const privateDir = path.join(dir, "private");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, "brief.txt"), "Shared brief");
  const reach = await createReach({
    roots: [shared],
    dataDir: privateDir,
    desktopTerminals: {
      platform: "linux",
      run: async () => assert.fail("No native terminal access"),
    },
    browserCapture: async () => assert.fail("No real screen capture"),
    browserInput: async () => assert.fail("No native screen input"),
  });
  const owner = reach.auth.issue("Owner phone", ALL_SCOPES);
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    reach.server.once("error", reject);
    reach.server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const call = async (
    route,
    { token = owner.token, method = "GET", body, headers = {} } = {},
  ) => {
    const response = await fetch(origin + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  };
  const invite = async (kind = "browser", extra = {}) => {
    const result = await call(
      kind === "browser"
        ? "/api/agents/browser-invitations"
        : "/api/agents/invitations",
      {
        method: "POST",
        body: {
          name: kind === "browser" ? "Muse" : "CLI agent",
          ttlSeconds: 600,
          folders: [{ root: 0, path: "" }],
          ...extra,
        },
      },
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const claim = async (grant) => {
    const result = await call("/api/invitations/redeem", {
      token: "",
      method: "POST",
      body: { invitation: grant.invitation },
    });
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.status, "pending");
    assert.equal(result.body.token, undefined);
    assert.equal(result.body.clientId, grant.clientId);
    return result.body;
  };
  const poll = (receipt, extra = {}) =>
    call(`/api/invitations/claims/${receipt.requestId}/status`, {
      token: "",
      method: "POST",
      body: { secret: receipt.requestSecret },
      ...extra,
    });
  const decide = (receipt, decision, extra = {}) =>
    call(`/api/agents/admissions/${receipt.requestId}`, {
      method: "POST",
      body: { decision },
      ...extra,
    });
  const changeClient = (id, changes) => {
    const file = path.join(privateDir, "clients.json");
    const clients = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(
      clients.find((client) => client.id === id),
      changes,
    );
    atomicJson(file, clients);
  };
  return {
    reach,
    owner,
    call,
    invite,
    claim,
    poll,
    decide,
    changeClient,
    privateDir,
  };
}

for (const kind of ["browser", "cli"])
  test(`${kind} invitation cannot access the laptop until its owner approves the first join`, async (t) => {
    const { reach, call, invite, claim, poll, decide } = await start(t);
    const grant = await invite(kind);
    const receipt = await claim(grant);
    assert.equal(receipt.kind, "agent");
    assert.equal(typeof receipt.verificationCode, "string");
    assert.ok(receipt.verificationCode.length >= 4);
    for (const token of [
      grant.invitation,
      receipt.requestSecret,
      receipt.verificationCode,
    ]) {
      assert.equal(reach.auth.verify(token), null);
      assert.equal((await call("/api/device", { token })).status, 401);
    }
    const pending = await poll(receipt);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, "pending");
    assert.equal(pending.body.token, undefined);
    const listed = await call("/api/agents/admissions");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].clientId, grant.clientId);
    assert.equal(listed.body[0].verificationCode, receipt.verificationCode);
    assert.equal(
      JSON.stringify(listed.body).includes(receipt.requestSecret),
      false,
    );
    assert.equal(JSON.stringify(listed.body).includes(grant.invitation), false);
    const approved = await decide(receipt, "approve");
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(
      approved.body.token,
      undefined,
      "the owner does not receive the agent's credential",
    );
    const joined = await poll(receipt);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.status, "approved");
    assert.equal(joined.body.clientId, grant.clientId);
    assert.deepEqual(joined.body.scopes, grant.scopes);
    assert.equal(
      (await call("/api/device", { token: joined.body.token })).status,
      200,
    );
    const brief = await call("/api/files/text?root=0&path=brief.txt", { token: joined.body.token });
    // CLI grants use the ordinary file API; browser grants require the protected helper.
    if (kind === "browser") expectFileResponse(brief, body => assert.equal(body.text, "Shared brief"));
    else { assert.equal(brief.status, 200); assert.equal(brief.body.text, "Shared brief"); }
    assert.equal(
      (
        await call("/api/invitations/redeem", {
          token: "",
          method: "POST",
          body: { invitation: grant.invitation },
        })
      ).status,
      401,
    );
    const repeated = await poll(receipt);
    assert.equal(
      repeated.body?.token,
      undefined,
      "the receipt releases at most one active credential",
    );
    assert.deepEqual((await call("/api/agents/admissions")).body, []);
  });

test("human guest invitations retain immediate redemption without an agent admission request", async (t) => {
  const { call } = await start(t);
  const grant = await call("/api/guests", {
    method: "POST",
    body: { name: "Guest", ttlSeconds: 600, folders: [{ root: 0, path: "" }] },
  });
  assert.equal(grant.status, 201);
  const joined = await call("/api/invitations/redeem", {
    token: "",
    method: "POST",
    body: { invitation: grant.body.invitation },
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.kind, "guest");
  assert.equal(
    (await call("/api/device", { token: joined.body.token })).status,
    200,
  );
  assert.deepEqual((await call("/api/agents/admissions")).body, []);
});

test("only a paired owner device can inspect, approve, or deny admissions", async (t) => {
  const { reach, call, invite, claim, decide, poll, changeClient } =
    await start(t);
  const receipt = await claim(await invite());
  const guestGrant = reach.auth.inviteGuest({
    name: "Full guest",
    ttlSeconds: 600,
    full: true,
  });
  const guest = reach.auth.redeemGuest(guestGrant.invitation);
  const agent = reach.auth.issue("Legacy agent", ["device"], "agent");
  changeClient(agent.clientId, { scopes: ALL_SCOPES });
  const limited = reach.auth.issue("Limited device", ["device"]);
  for (const token of [guest.token, agent.token, limited.token]) {
    assert.equal((await call("/api/agents/admissions", { token })).status, 403);
    assert.equal((await decide(receipt, "approve", { token })).status, 403);
    assert.equal((await decide(receipt, "deny", { token })).status, 403);
  }
  assert.equal(
    (await decide(receipt, "approve", { token: receipt.requestSecret })).status,
    401,
  );
  assert.equal((await poll(receipt)).body.status, "pending");
  await decide(receipt, "approve");
  const connected = await poll(receipt);
  const second = await claim(await invite());
  assert.equal(
    (await decide(second, "approve", { token: connected.body.token })).status,
    403,
  );
  assert.equal((await poll(second)).body.status, "pending");
});

test("an invitation can be claimed once, and neither a wrong receipt nor forged identity headers can take over", async (t) => {
  const { reach, call, invite, claim, poll, decide } = await start(t);
  const grant = await invite();
  const receipt = await claim(grant);
  assert.equal(
    (
      await call("/api/invitations/redeem", {
        token: "",
        method: "POST",
        body: { invitation: grant.invitation },
      })
    ).status,
    401,
  );
  for (const secret of [
    "",
    "wrong",
    grant.invitation,
    receipt.verificationCode,
  ]) {
    const wrong = await poll(receipt, { body: { secret } });
    assert.ok(
      [400, 401, 403, 404].includes(wrong.status),
      JSON.stringify(wrong.body),
    );
    assert.equal(wrong.body?.token, undefined);
  }
  assert.equal((await poll(receipt)).body.status, "pending");
  await decide(receipt, "approve");
  const results = await Promise.all([poll(receipt), poll(receipt)]);
  assert.equal(results.filter((result) => result.body?.token).length, 1);

  const bound = await invite("cli");
  const node = {
    userId: "",
    nodeId: "agent-vm",
    tagged: true,
    validUntil: Date.now() + 60000,
  };
  const nodeReceipt = reach.auth.redeemGuest(bound.invitation, node);
  await decide(nodeReceipt, "approve");
  const missingIdentity = await poll(nodeReceipt, {
    headers: {
      "x-forwarded-for": "100.64.1.2",
      "tailscale-user-login": "owner@example.test",
      "tailscale-node-id": "agent-vm",
    },
  });
  assert.ok(
    [401, 403, 404].includes(missingIdentity.status),
    JSON.stringify(missingIdentity.body),
  );
  assert.equal(missingIdentity.body?.token, undefined);
  const joined = reach.auth.pollAgentAdmission(
    nodeReceipt.requestId,
    nodeReceipt.requestSecret,
    node,
  );
  assert.equal(joined.status, "approved");
  assert.equal(reach.auth.verify(joined.token, node)?.id, bound.clientId);
});

test("denial and revocation prevent the claim from ever issuing a token", async (t) => {
  const { call, invite, claim, poll, decide } = await start(t);
  const denied = await claim(await invite());
  assert.equal((await decide(denied, "deny")).status, 200);
  const deniedPoll = await poll(denied);
  assert.equal(deniedPoll.body.status, "denied");
  assert.equal(deniedPoll.body.token, undefined);
  assert.ok(
    [400, 403, 404, 409, 410].includes(
      (await decide(denied, "approve")).status,
    ),
  );
  const revoked = await claim(await invite("cli"));
  await call(`/api/clients/${revoked.clientId}`, { method: "DELETE" });
  const revokedPoll = await poll(revoked);
  assert.equal(revokedPoll.body?.token, undefined);
  assert.ok(
    revokedPoll.status >= 400 ||
      ["revoked", "expired", "denied"].includes(revokedPoll.body?.status),
  );
  assert.ok(
    [400, 401, 403, 404, 409, 410].includes(
      (await decide(revoked, "approve")).status,
    ),
  );
});

test("expired claims and changed grants fail closed before and after approval", async (t) => {
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => realNow() + offset);
  const { reach, invite, claim, poll, decide, changeClient } = await start(t);
  const expired = await claim(await invite());
  offset = expired.expiresAt - realNow() + 1;
  const expiredPoll = await poll(expired);
  assert.equal(expiredPoll.body?.token, undefined);
  assert.ok(
    expiredPoll.status >= 400 || expiredPoll.body?.status === "expired",
  );
  offset = 0;
  for (const afterApproval of [false, true]) {
    const grant = await invite("cli");
    const receipt = await claim(grant);
    if (afterApproval)
      assert.equal((await decide(receipt, "approve")).status, 200);
    const current = reach.auth
      .list()
      .find((client) => client.id === grant.clientId);
    changeClient(grant.clientId, { scopes: [...current.scopes, "exec"] });
    if (!afterApproval)
      assert.ok((await decide(receipt, "approve")).status >= 400);
    const changed = await poll(receipt);
    assert.equal(changed.body?.token, undefined);
    assert.ok(
      changed.status >= 400 ||
        ["revoked", "expired", "denied"].includes(changed.body?.status),
    );
  }
});

test("admission decisions cannot replace the reviewed grant and malformed polls cannot consume it", async (t) => {
  const { call, invite, claim, poll, decide } = await start(t);
  const receipt = await claim(await invite());
  for (const body of [
    { decision: "approve", scopes: ALL_SCOPES },
    { decision: "approve", clientId: "another-client" },
    { decision: "allow-all" },
    { decision: ["approve"] },
  ])
    assert.equal((await decide(receipt, "approve", { body })).status, 400);
  for (const secret of [null, {}, [], [receipt.requestSecret]]) {
    const result = await poll(receipt, { body: { secret } });
    assert.ok([400, 401, 403, 404].includes(result.status));
    assert.equal(result.body?.token, undefined);
  }
  assert.equal((await poll(receipt)).body.status, "pending");
  assert.equal((await decide(receipt, "approve")).status, 200);
  const joined = await poll(receipt);
  assert.equal(
    (await call("/api/device", { token: joined.body.token })).status,
    200,
  );
});
