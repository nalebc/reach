import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";
import { softAuthenticator } from "./helpers/soft-authenticator.mjs";

// Face ID on your phone confirms each agent connection you allow (Settings →
// Agents, Oct 10). Your own devices turn it on, once Face ID is set up on
// this computer; from then on Approve needs a Face ID answer made for that
// very request, from that very phone, used once. Deny never does. Turning it
// off takes Face ID too, and the last passkey stays while it's on: a
// credential alone never lifts it. A guest, an agent or a Face ID-joined
// browser can neither use it nor see or change the setting.
const HOST = "mac-a.t.ts.net";
const owner = { userId: "42", login: "me@example.test" };
const NODES = {
  "100.64.0.10": { id: "nPhone", user: 42, name: "iphone" },
  "100.64.0.11": { id: "nMac", user: 42, name: "mac-browser" },
  "100.64.0.12": { id: "nGuest", user: 42, name: "guest-laptop" },
  "100.64.0.13": { id: "nPad", user: 42, name: "ipad-browser" },
  "100.64.0.20": {
    id: "agent-vm",
    user: 7,
    name: "rg-ab12-guest00001",
    tags: ["tag:reach-guest"],
  },
  "100.64.0.21": {
    id: "nFace",
    user: 7,
    name: "rf-mac-a-ab12",
    tags: ["tag:reach-guest"],
  },
};
const IP = Object.fromEntries(
  Object.entries(NODES).map(([ip, n]) => [n.id, ip]),
);
// The invited agent's own device, as Reach's identity resolver sees it.
const AGENT_NODE = {
  userId: "",
  nodeId: "agent-vm",
  tagged: true,
  validUntil: Date.now() + 3600000,
};
const skip = process.platform === "win32";

async function start(t) {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-admission-faceid-")),
  );
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  const socketDir = fs.mkdtempSync("/tmp/reach-af-sock-");
  const socketPath = path.join(socketDir, "s");
  const privateDir = path.join(dir, "private");
  const reach = await createReach({
    roots: [shared],
    dataDir: privateDir,
    port: 0,
    publicOrigin: `https://${HOST}:8443`,
    tailscaleOwner: owner,
    tailscaleIdentity: {
      lookup: async (ip) => {
        const n = NODES[ip];
        return (
          n && {
            Node: {
              StableID: n.id,
              User: n.user,
              Name: `${n.name}.t.ts.net.`,
              KeyExpiry: "0001-01-01T00:00:00Z",
              ...(n.tags ? { Tags: n.tags } : {}),
            },
            UserProfile: {
              ID: n.user,
              LoginName: n.user === 42 ? owner.login : `user${n.user}@x.test`,
            },
          }
        );
      },
    },
    tailscaleStatus: async () => ({
      Self: { TailscaleIPs: ["100.64.0.5"] },
      Peer: {},
    }),
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  await reach.listenPrivate(socketPath);
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  // A request as Tailscale Serve delivers it, from one of the devices above.
  const call = (node, route, { method = "POST", body, token } = {}) =>
    new Promise((resolve, reject) => {
      const n = NODES[IP[node]];
      const req = http.request(
        {
          socketPath,
          path: route,
          method,
          headers: {
            Host: "localhost",
            "X-Forwarded-For": IP[node],
            ...(n.tags ? {} : { "Tailscale-User-Login": owner.login }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              json: JSON.parse(text || "null"),
            }),
          );
        },
      );
      req.once("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  const phone = reach.auth.issue("iPhone", ALL_SCOPES, "device", {
    tailscale: { userId: "42", nodeId: "nPhone" },
    nodeName: "iphone",
  });
  const asPhone = (route, options = {}) =>
    call("nPhone", route, { token: phone.token, ...options });
  const authenticator = softAuthenticator({ origin: `https://${HOST}:8443` });
  const addFaceId = async () => {
    const options = await asPhone("/api/auth/passkeys/options", { body: {} });
    assert.equal(options.status, 200, JSON.stringify(options.json));
    const added = await asPhone("/api/auth/passkeys", {
      body: { credential: authenticator.create(options.json), label: "iPhone" },
    });
    assert.equal(added.status, 201, JSON.stringify(added.json));
    return added.json;
  };
  // A browser that signed in with Face ID alone (server/face-join.mjs): the
  // owner's, with every scope, but on a tagged device of its own.
  const faceJoined = (passkeyId) =>
    reach.auth.issue("Face ID browser", ALL_SCOPES, "device", {
      tailscale: {
        userId: "",
        nodeId: "nFace",
        tagged: true,
        faceJoin: true,
        passkeyId,
      },
      nodeName: "rf-mac-a-ab12",
    });
  // A command-line agent invited from the phone, waiting on its first join.
  const waitingAgent = async (name) => {
    const grant = await asPhone("/api/agents/invitations", {
      body: { name, ttlSeconds: 600, folders: [{ root: 0, path: "" }] },
    });
    assert.equal(grant.status, 201, JSON.stringify(grant.json));
    const claim = reach.auth.redeemGuest(grant.json.invitation, AGENT_NODE);
    assert.equal(claim.status, "pending");
    return claim;
  };
  const decide = (claim, body = { decision: "approve" }, options = {}) =>
    asPhone(`/api/agents/admissions/${claim.requestId}`, { body, ...options });
  const faceIdOptions = (claim, options = {}) =>
    asPhone(`/api/agents/admissions/${claim.requestId}/passkey/options`, {
      body: {},
      ...options,
    });
  // What the agent sees of its request (collecting its credential once approved).
  const joined = (claim) =>
    reach.auth.pollAgentAdmission(
      claim.requestId,
      claim.requestSecret,
      AGENT_NODE,
    );
  const settings = () => asPhone("/api/settings", { method: "GET" });
  const activity = async (title) =>
    (await asPhone("/api/activity", { method: "GET" })).json.some(
      (e) => e.title === title,
    );
  return {
    reach,
    call,
    phone,
    asPhone,
    authenticator,
    addFaceId,
    faceJoined,
    waitingAgent,
    decide,
    faceIdOptions,
    joined,
    settings,
    activity,
    privateDir,
  };
}

test(
  "the setting: your own devices turn it on once Face ID is set up here; off takes Face ID, and the last passkey stays while it's on",
  { skip, timeout: 30000 },
  async (t) => {
    const {
      reach,
      call,
      asPhone,
      authenticator,
      addFaceId,
      faceJoined,
      settings,
      activity,
      privateDir,
    } = await start(t);
    assert.notEqual((await settings()).json.faceIdForAgents, true);
    // Not before Face ID is set up on this computer.
    const early = await asPhone("/api/settings", {
      body: { faceIdForAgents: true },
    });
    assert.equal(early.status, 409);
    assert.match(early.json.error, /Add Face ID in Settings first/);
    assert.equal(
      (await asPhone("/api/settings/passkey/options", { body: {} })).status,
      404,
    );
    const key = await addFaceId();
    for (const body of [
      { faceIdForAgents: "yes" },
      { faceIdForAgents: true, screen: true },
      { faceIdForAgents: true, credential: { type: "public-key" } },
    ])
      assert.equal(
        (await asPhone("/api/settings", { body })).status,
        400,
        JSON.stringify(body),
      );
    const on = await asPhone("/api/settings", {
      body: { faceIdForAgents: true },
    });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.faceIdForAgents, true);
    assert.equal((await settings()).json.faceIdForAgents, true);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(privateDir, "settings.json"), "utf8"),
      ).faceIdForAgents,
      true,
      "kept across restarts",
    );
    assert.ok(await activity("Face ID for agent approvals turned on"));
    // Screen viewing is set as it always was.
    assert.equal(
      (await asPhone("/api/settings", { body: { screen: "yes" } })).status,
      400,
    );
    assert.equal(
      (await asPhone("/api/settings", { body: { screen: false } })).status,
      200,
    );
    assert.equal((await settings()).json.faceIdForAgents, true);
    // A guest (even with full access) or an agent: neither reads nor changes it.
    const invite = reach.auth.inviteGuest({
      name: "G",
      ttlSeconds: 600,
      full: true,
    });
    const guest = reach.auth.redeemGuest(invite.invitation, {
      userId: "42",
      nodeId: "nGuest",
    });
    assert.equal(
      (
        await call("nGuest", "/api/device", {
          method: "GET",
          token: guest.token,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("nGuest", "/api/settings", {
          method: "GET",
          token: guest.token,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("nGuest", "/api/settings", {
          token: guest.token,
          body: { faceIdForAgents: false },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("nGuest", "/api/settings/passkey/options", {
          token: guest.token,
          body: {},
        })
      ).status,
      403,
    );
    const agent = reach.auth.issue("Bot", ["device", "files:read"], "agent");
    assert.equal(
      (await call("nMac", "/api/device", { method: "GET", token: agent.token }))
        .status,
      200,
    );
    assert.equal(
      (
        await call("nMac", "/api/settings", {
          method: "GET",
          token: agent.token,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("nMac", "/api/settings", {
          token: agent.token,
          body: { faceIdForAgents: false },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("nMac", "/api/settings/passkey/options", {
          token: agent.token,
          body: {},
        })
      ).status,
      403,
    );
    // Even an agent credential given every scope: not a device of yours.
    const file = path.join(privateDir, "clients.json");
    const clients = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(
      clients.find((c) => c.id === agent.clientId),
      { scopes: ALL_SCOPES },
    );
    atomicJson(file, clients);
    const tampered = await call("nMac", "/api/settings", {
      token: agent.token,
      body: { faceIdForAgents: false },
    });
    assert.equal(tampered.status, 403, JSON.stringify(tampered.json));
    assert.equal(
      (
        await call("nMac", "/api/settings/passkey/options", {
          token: agent.token,
          body: {},
        })
      ).status,
      403,
    );
    // A browser that signed in with Face ID alone: every scope, but not on
    // your Tailscale account, so no say over this (as with Face ID itself).
    const browser = faceJoined(key.id);
    assert.equal(
      (
        await call("nFace", "/api/device", {
          method: "GET",
          token: browser.token,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("nFace", "/api/settings", {
          token: browser.token,
          body: { faceIdForAgents: false },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("nFace", "/api/settings/passkey/options", {
          token: browser.token,
          body: {},
        })
      ).status,
      403,
    );
    assert.equal((await settings()).json.faceIdForAgents, true, "still on");
    // Your own device, but a tap alone: not off. Nor is the last passkey
    // removed from under it; the one that would be left is fine to remove.
    const plainOff = await asPhone("/api/settings", {
      body: { faceIdForAgents: false },
    });
    assert.equal(plainOff.status, 403);
    assert.match(plainOff.json.error, /Face ID turns this off/);
    const kept = await asPhone(`/api/auth/passkeys/${key.id}`, {
      method: "DELETE",
    });
    assert.equal(kept.status, 409);
    assert.match(kept.json.error, /Turn that off in Settings → Agents first/);
    assert.equal(
      (await asPhone("/api/auth/passkeys", { method: "GET" })).json.passkeys
        .length,
      1,
    );
    assert.equal((await settings()).json.faceIdForAgents, true, "still on");
    // Off with Face ID: this device's own challenge, answered in the tap.
    const options = await asPhone("/api/settings/passkey/options", {
      body: {},
    });
    assert.equal(options.status, 200, JSON.stringify(options.json));
    assert.equal(options.json.rpId, HOST);
    assert.equal(options.json.userVerification, "required");
    const spoofed = await asPhone("/api/settings", {
      body: {
        faceIdForAgents: false,
        credential: authenticator.get(options.json, {
          from: "https://evil.example",
        }),
      },
    });
    assert.equal(spoofed.status, 401, JSON.stringify(spoofed.json));
    assert.equal(
      (await settings()).json.faceIdForAgents,
      true,
      "a refused answer changes nothing",
    );
    const fresh = await asPhone("/api/settings/passkey/options", { body: {} });
    const off = await asPhone("/api/settings", {
      body: {
        faceIdForAgents: false,
        credential: authenticator.get(fresh.json),
      },
    });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(off.json.faceIdForAgents, false);
    assert.equal((await settings()).json.faceIdForAgents, false);
    assert.ok(
      await activity(
        "Face ID for agent approvals turned off with Face ID (iPhone)",
      ),
    );
    // Off: the passkey can go; back where it started (and off is a plain
    // tap while nothing is in force).
    assert.equal(
      (await asPhone(`/api/auth/passkeys/${key.id}`, { method: "DELETE" }))
        .status,
      200,
    );
    assert.equal(
      (await asPhone("/api/settings", { body: { faceIdForAgents: true } }))
        .status,
      409,
    );
    assert.equal(
      (await asPhone("/api/settings", { body: { faceIdForAgents: false } }))
        .status,
      200,
    );
  },
);

test(
  "on: Approve needs a Face ID answer for that request, from that phone, used once; Deny never; off: the code alone, as before",
  { skip, timeout: 30000 },
  async (t) => {
    const {
      reach,
      call,
      asPhone,
      authenticator,
      addFaceId,
      faceJoined,
      waitingAgent,
      decide,
      faceIdOptions,
      joined,
      activity,
    } = await start(t);
    // Face ID set up, the setting off: approving works as before, and a
    // Face ID answer is taken when the phone offers one.
    const key = await addFaceId();
    const first = await waitingAgent("First");
    assert.equal((await decide(first)).status, 200);
    const firstJoined = joined(first);
    assert.equal(firstJoined.status, "approved");
    assert.ok(firstJoined.token);
    const second = await waitingAgent("Second");
    const offered = await faceIdOptions(second);
    assert.equal(offered.status, 200, JSON.stringify(offered.json));
    assert.equal(offered.json.rpId, HOST);
    assert.equal(offered.json.userVerification, "required");
    const withFaceId = await decide(second, {
      decision: "approve",
      credential: authenticator.get(offered.json),
    });
    assert.equal(withFaceId.status, 200, JSON.stringify(withFaceId.json));
    assert.equal(withFaceId.json.token, undefined);
    assert.equal(joined(second).status, "approved");
    assert.ok(
      await activity(
        "Approved an invited agent's connection with Face ID (iPhone)",
      ),
    );

    // On: a plain approve is refused, and the connection keeps waiting.
    assert.equal(
      (await asPhone("/api/settings", { body: { faceIdForAgents: true } }))
        .status,
      200,
    );
    const third = await waitingAgent("Third");
    const plain = await decide(third);
    assert.equal(plain.status, 403);
    assert.match(plain.json.error, /Face ID confirms agent approvals/);
    assert.equal(joined(third).status, "pending");
    assert.ok(
      (await asPhone("/api/agents/admissions", { method: "GET" })).json.some(
        (a) => a.requestId === third.requestId,
      ),
    );
    // Deny never needs it.
    const denied = await waitingAgent("Denied");
    assert.equal((await decide(denied, { decision: "deny" })).status, 200);
    assert.equal(joined(denied).status, "denied");
    // An answer made for another request: refused, nothing approved.
    const other = await waitingAgent("Other");
    const forOther = await faceIdOptions(other);
    assert.equal(forOther.status, 200);
    const crossed = await decide(third, {
      decision: "approve",
      credential: authenticator.get(forOther.json),
    });
    assert.equal(crossed.status, 401, JSON.stringify(crossed.json));
    assert.equal(joined(third).status, "pending");
    // Options asked by the phone, answered from another device of yours: refused.
    const mac = reach.auth.issue("Mac browser", ALL_SCOPES, "device", {
      tailscale: { userId: "42", nodeId: "nMac" },
      nodeName: "mac-browser",
    });
    const forThird = await faceIdOptions(third);
    assert.equal(forThird.status, 200);
    const elsewhere = await call(
      "nMac",
      `/api/agents/admissions/${third.requestId}`,
      {
        token: mac.token,
        body: {
          decision: "approve",
          credential: authenticator.get(forThird.json),
        },
      },
    );
    assert.equal(elsewhere.status, 401, JSON.stringify(elsewhere.json));
    assert.equal(joined(third).status, "pending");
    // An answer from another page: refused, and the challenge is spent by it.
    const spoofed = await decide(third, {
      decision: "approve",
      credential: authenticator.get(forThird.json, {
        from: "https://evil.example",
      }),
    });
    assert.equal(spoofed.status, 401, JSON.stringify(spoofed.json));
    const spent = await decide(third, {
      decision: "approve",
      credential: authenticator.get(forThird.json),
    });
    assert.equal(spent.status, 401, JSON.stringify(spent.json));
    assert.equal(joined(third).status, "pending");
    // Challenges never cross routes: one for a new browser of yours, or for
    // the setting, approves no agent, and an agent's approves no browser.
    const browserAsk = await call("nPad", "/api/auth/requests", {
      body: { name: "iPad" },
    });
    assert.equal(browserAsk.status, 202, JSON.stringify(browserAsk.json));
    assert.equal(browserAsk.json.passkey, true);
    const browserRoute = `/api/auth/requests/${browserAsk.json.id}/passkey`;
    const forBrowser = await call("nPad", `${browserRoute}/options`, {
      body: { secret: browserAsk.json.secret },
    });
    assert.equal(forBrowser.status, 200, JSON.stringify(forBrowser.json));
    const browserOnAgent = await decide(third, {
      decision: "approve",
      credential: authenticator.get(forBrowser.json),
    });
    assert.equal(
      browserOnAgent.status,
      401,
      JSON.stringify(browserOnAgent.json),
    );
    const forSetting = await asPhone("/api/settings/passkey/options", {
      body: {},
    });
    assert.equal(forSetting.status, 200);
    const settingOnAgent = await decide(third, {
      decision: "approve",
      credential: authenticator.get(forSetting.json),
    });
    assert.equal(
      settingOnAgent.status,
      401,
      JSON.stringify(settingOnAgent.json),
    );
    const forAgent = await faceIdOptions(third);
    const agentOnBrowser = await call("nPad", browserRoute, {
      body: {
        secret: browserAsk.json.secret,
        credential: authenticator.get(forAgent.json),
      },
    });
    assert.equal(
      agentOnBrowser.status,
      401,
      JSON.stringify(agentOnBrowser.json),
    );
    const polled = await call(
      "nPad",
      `/api/auth/requests/${browserAsk.json.id}`,
      { body: { secret: browserAsk.json.secret } },
    );
    assert.equal(polled.json.status, "pending", "the browser is still waiting");
    const agentOnSetting = await asPhone("/api/settings", {
      body: {
        faceIdForAgents: false,
        credential: authenticator.get(forAgent.json),
      },
    });
    assert.equal(
      agentOnSetting.status,
      401,
      JSON.stringify(agentOnSetting.json),
    );
    assert.equal(
      (await asPhone("/api/settings", { method: "GET" })).json.faceIdForAgents,
      true,
      "still on",
    );
    assert.equal(joined(third).status, "pending");
    // A browser that signed in with Face ID alone: no challenge for it, and
    // while this is on, no approving either.
    const browser = faceJoined(key.id);
    assert.equal(
      (
        await call("nFace", "/api/device", {
          method: "GET",
          token: browser.token,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "nFace",
          `/api/agents/admissions/${third.requestId}/passkey/options`,
          { token: browser.token, body: {} },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call("nFace", `/api/agents/admissions/${third.requestId}`, {
          token: browser.token,
          body: { decision: "approve" },
        })
      ).status,
      403,
    );
    assert.equal(joined(third).status, "pending");
    // Fresh options, a real answer: approved, and the agent joins.
    const fresh = await faceIdOptions(third);
    assert.equal(fresh.status, 200);
    const ok = await decide(third, {
      decision: "approve",
      credential: authenticator.get(fresh.json),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.status, "approved");
    assert.equal(joined(third).status, "approved");
    // Decided, or unknown: no options for it. A credential never goes with
    // Deny, and nothing else goes with a decision.
    assert.equal((await faceIdOptions(third)).status, 404);
    assert.equal(
      (
        await faceIdOptions({
          requestId: "00000000-0000-4000-8000-000000000000",
        })
      ).status,
      404,
    );
    const fourth = await waitingAgent("Fourth");
    const withDeny = await faceIdOptions(fourth);
    assert.equal(
      (
        await decide(fourth, {
          decision: "deny",
          credential: authenticator.get(withDeny.json),
        })
      ).status,
      400,
    );
    assert.equal(
      (await decide(fourth, { decision: "approve", scopes: ALL_SCOPES }))
        .status,
      400,
    );
    assert.equal(
      (
        await decide(fourth, {
          decision: "approve",
          credential: "not a credential",
        })
      ).status,
      400,
    );
    assert.equal(
      (await decide(fourth, { decision: "approve", credential: null })).status,
      400,
    );
    assert.equal(joined(fourth).status, "pending");
    // A guest, even with full access, and the agent that joined: refused everywhere here.
    const invite = reach.auth.inviteGuest({
      name: "G",
      ttlSeconds: 600,
      full: true,
    });
    const guest = reach.auth.redeemGuest(invite.invitation, {
      userId: "42",
      nodeId: "nGuest",
    });
    for (const [node, token] of [
      ["nGuest", guest.token],
      ["agent-vm", firstJoined.token],
    ]) {
      assert.equal(
        (await call(node, "/api/device", { method: "GET", token })).status,
        200,
        node,
      );
      assert.equal(
        (await call(node, "/api/agents/admissions", { method: "GET", token }))
          .status,
        403,
        node,
      );
      assert.equal(
        (
          await call(
            node,
            `/api/agents/admissions/${fourth.requestId}/passkey/options`,
            { token, body: {} },
          )
        ).status,
        403,
        node,
      );
      assert.equal(
        (
          await call(node, `/api/agents/admissions/${fourth.requestId}`, {
            token,
            body: { decision: "approve" },
          })
        ).status,
        403,
        node,
      );
      assert.equal(
        (await call(node, "/api/settings", { method: "GET", token })).status,
        403,
        node,
      );
      assert.equal(
        (await call(node, "/api/settings/passkey/options", { token, body: {} }))
          .status,
        403,
        node,
      );
    }
    assert.equal(joined(fourth).status, "pending");
    // Off again, with Face ID: the code alone approves, as before, from any
    // device of yours (the Face ID browser included, as before).
    const forOff = await asPhone("/api/settings/passkey/options", { body: {} });
    assert.equal(
      (
        await asPhone("/api/settings", {
          body: {
            faceIdForAgents: false,
            credential: authenticator.get(forOff.json),
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("nFace", `/api/agents/admissions/${fourth.requestId}`, {
          token: browser.token,
          body: { decision: "approve" },
        })
      ).status,
      200,
    );
    assert.equal(joined(fourth).status, "approved");
  },
);

test(
  "a computer without Face ID (no passkey, or no https link): approvals as before, nothing to turn on",
  { timeout: 30000 },
  async (t) => {
    const dir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "reach-admission-nofaceid-")),
    );
    const shared = path.join(dir, "shared");
    fs.mkdirSync(shared);
    const reach = await createReach({
      roots: [shared],
      dataDir: path.join(dir, "private"),
      port: 0,
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      await reach.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const owner = reach.auth.issue("Owner phone", ALL_SCOPES);
    const call = async (route, { method = "POST", body } = {}) => {
      const response = await fetch(
        `http://127.0.0.1:${reach.server.address().port}${route}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${owner.token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        json: await response.json().catch(() => null),
      };
    };
    assert.equal(
      (await call("/api/settings", { body: { faceIdForAgents: true } })).status,
      409,
    );
    assert.equal(
      (await call("/api/settings", { body: { faceIdForAgents: false } }))
        .status,
      200,
    );
    assert.equal(
      (
        await call("/api/settings", {
          body: { faceIdForAgents: false, credential: { type: "public-key" } },
        })
      ).status,
      404,
    );
    assert.equal(
      (await call("/api/settings/passkey/options", { body: {} })).status,
      404,
    );
    const grant = await call("/api/agents/invitations", {
      body: {
        name: "Builder",
        ttlSeconds: 600,
        folders: [{ root: 0, path: "" }],
      },
    });
    assert.equal(grant.status, 201, JSON.stringify(grant.json));
    const claim = reach.auth.redeemGuest(grant.json.invitation);
    assert.equal(claim.status, "pending");
    assert.equal(
      (
        await call(
          `/api/agents/admissions/${claim.requestId}/passkey/options`,
          { body: {} },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(`/api/agents/admissions/${claim.requestId}`, {
          body: { decision: "approve", credential: { type: "public-key" } },
        })
      ).status,
      404,
    );
    assert.equal(
      reach.auth.pollAgentAdmission(claim.requestId, claim.requestSecret)
        .status,
      "pending",
    );
    assert.equal(
      (
        await call(`/api/agents/admissions/${claim.requestId}`, {
          body: { decision: "approve" },
        })
      ).status,
      200,
    );
    assert.equal(
      reach.auth.pollAgentAdmission(claim.requestId, claim.requestSecret)
        .status,
      "approved",
    );
  },
);
