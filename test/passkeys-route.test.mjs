import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { computerWord } from "../server/computer-word.mjs";
import { softAuthenticator } from "./helpers/soft-authenticator.mjs";

// Face ID end to end, as a real Reach sees it (Tailscale identity on every
// request): add it from a browser you approved, then approve a new browser of
// yours with it; nobody else's device, request or credential can.
const HOST = "mac-a.t.ts.net";
const owner = { userId: "42", login: "me@example.test" };
const NODES = {
  "100.64.0.10": { id: "nSafari", user: 42, name: "iphone-browser" },
  "100.64.0.11": { id: "nChrome", user: 42, name: "iphone-browser-1" },
  "100.64.0.12": { id: "nOther", user: 42, name: "mac-browser" },
  // This Mac itself (its own Tailscale address: the status's Self below).
  "100.64.0.5": { id: "nThisMac", user: 42, name: "mac-a" },
  "100.64.0.20": { id: "nTagged", user: 7, name: "rg-ab12-guest00001", tags: ["tag:reach-guest"] },
  "100.64.0.30": { id: "nStranger", user: 99, name: "stranger-phone" },
};
const IP = Object.fromEntries(Object.entries(NODES).map(([ip, n]) => [n.id, ip]));

// A real Reach on Tailscale Serve's private socket, and `call` for requests
// as Serve delivers them from the devices above.
async function reachWithFaceId(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-passkey-route-"));
    const socketDir = fs.mkdtempSync("/tmp/reach-pk-sock-");
    const socketPath = path.join(socketDir, "s");
    const reach = await createReach({
      roots: [dir],
      dataDir: path.join(dir, "private"),
      port: 0,
      publicOrigin: `https://${HOST}:8443`,
      tailscaleOwner: owner,
      tailscaleIdentity: {
        lookup: async (ip) => {
          const n = NODES[ip];
          return n && {
            Node: { StableID: n.id, User: n.user, Name: `${n.name}.t.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z", ...(n.tags ? { Tags: n.tags } : {}) },
            UserProfile: { ID: n.user, LoginName: n.user === 42 ? owner.login : `user${n.user}@x.test` },
          };
        },
      },
      tailscaleStatus: async () => ({ Self: { TailscaleIPs: ["100.64.0.5"] }, Peer: {} }),
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
              ...(n.tags ? {} : { "Tailscale-User-Login": n.user === 42 ? owner.login : `user${n.user}@x.test` }),
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
          },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "null") }));
          },
        );
        req.once("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    return { reach, call, dir };
}

test(
  "Face ID: added from an approved browser, then a new browser of yours is approved with it",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const { reach, call, dir } = await reachWithFaceId(t);
    const startPage = softAuthenticator({ origin: `https://${HOST}` });

    // Before any passkey: no offer, and nothing to sign.
    const early = await call("nChrome", "/api/auth/requests", { body: { name: "iPhone" } });
    assert.equal(early.status, 202);
    assert.equal(early.json.passkey, undefined);
    assert.equal((await call("nChrome", `/api/auth/requests/${early.json.id}/passkey/options`, { body: { secret: early.json.secret } })).status, 404);

    // Safari, approved here before, adds Face ID (from the start page).
    const safari = reach.auth.issue("iPhone", ALL_SCOPES, "device", {
      tailscale: { userId: "42", nodeId: "nSafari" },
      nodeName: "iphone-browser",
    });
    const options = await call("nSafari", "/api/auth/passkeys/options", { token: safari.token, body: {} });
    assert.equal(options.status, 200);
    assert.equal(options.json.rp.id, HOST);
    const added = await call("nSafari", "/api/auth/passkeys", { token: safari.token, body: { credential: startPage.create(options.json), label: "iPhone" } });
    assert.equal(added.status, 201, JSON.stringify(added.json));
    // Only your own approved device can add one: not from another device with
    // that token, not a guest (even full access), not without a credential.
    assert.equal((await call("nChrome", "/api/auth/passkeys/options", { token: safari.token, body: {} })).status, 403);
    const invite = reach.auth.inviteGuest({ name: "G", ttlSeconds: 600, full: true });
    const guest = reach.auth.redeemGuest(invite.invitation, { userId: "42", nodeId: "nOther" });
    assert.equal((await call("nOther", "/api/auth/passkeys/options", { token: guest.token, body: {} })).status, 403);
    assert.equal((await call("nOther", "/api/auth/passkeys", { method: "GET" })).status, 403);

    // Chrome on the same iPhone: a request, now offering Face ID.
    const asked = await call("nChrome", "/api/auth/requests", { body: { name: "iPhone" } });
    assert.equal(asked.json.passkey, true);
    const route = `/api/auth/requests/${asked.json.id}/passkey`;
    // Another device can't use Chrome's request, even with its secret.
    assert.equal((await call("nOther", `${route}/options`, { body: { secret: asked.json.secret } })).status, 403);
    assert.equal((await call("nChrome", `${route}/options`, { body: { secret: "wrong" } })).status, 403);
    const ask = await call("nChrome", `${route}/options`, { body: { secret: asked.json.secret } });
    assert.equal(ask.status, 200);
    assert.equal(ask.json.rpId, HOST);
    assert.equal(ask.json.userVerification, "required");
    const assertion = startPage.get(ask.json);
    const ok = await call("nChrome", route, { body: { secret: asked.json.secret, credential: assertion } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    // The usual poll now gives Chrome its own credential, bound to its device
    // and counted as the same iPhone as Safari.
    const polled = await call("nChrome", `/api/auth/requests/${asked.json.id}`, { body: { secret: asked.json.secret } });
    assert.equal(polled.json.status, "approved");
    assert.ok(polled.json.token);
    const chrome = reach.auth.list().find((c) => c.tailscale?.nodeId === "nChrome");
    assert.equal(chrome.kind, "device");
    assert.equal(chrome.deviceGroup, "nSafari", "one iPhone, two browsers");
    assert.equal((await call("nChrome", "/api/device", { method: "GET", token: polled.json.token })).status, 200);
    // Used once: the same response can't approve anything again.
    assert.equal((await call("nChrome", route, { body: { secret: asked.json.secret, credential: assertion } })).status, 403);

    // A browser on this Mac itself: anyone signed in to it could have asked
    // as you. No Face ID (the phone's sheet can't show the warning); the
    // request is marked, and its prompt here says so (D1, on both platforms).
    const here = await call("nThisMac", "/api/auth/requests", { body: { name: "This Mac's Safari" } });
    assert.equal(here.status, 202);
    assert.equal(here.json.passkey, undefined, "no Face ID offered");
    const refused = await call("nThisMac", `/api/auth/requests/${here.json.id}/passkey/options`, { body: { secret: here.json.secret } });
    assert.equal(refused.status, 403);
    const word = computerWord(process.platform);
    assert.equal(refused.json.error, `This request came from this ${word} itself: type its code in Reach on the ${word} instead.`);
    const { pendingApprovals, describeApproval } = await import("../scripts/approve-device.mjs");
    const pending = pendingApprovals(path.join(dir, "private")).find((r) => r.id === here.json.id);
    assert.equal(pending.thisComputer, true);
    assert.match(describeApproval(pending, "darwin"), /\n  From this Mac itself: anyone signed in to it could have asked\. Approve only if you just asked from a browser on it\.$/);
    assert.equal(pendingApprovals(path.join(dir, "private")).find((r) => r.id === asked.json.id)?.thisComputer, undefined, "the iPhone's wasn't");

    // Not your account, or a tagged (guest) device: no request at all.
    assert.equal((await call("nTagged", "/api/auth/requests", { body: { name: "x" } })).status, 403);
    assert.equal((await call("nStranger", "/api/auth/requests", { body: { name: "x" } })).status, 403);
    assert.equal((await call("nTagged", `${route}/options`, { body: { secret: asked.json.secret } })).status, 403);

    // Removed: new browsers go back to approving here.
    const list = await call("nSafari", "/api/auth/passkeys", { method: "GET", token: safari.token });
    assert.deepEqual(list.json.passkeys.map((p) => p.label), ["iPhone"]);
    assert.ok(list.json.passkeys[0].usedAt);
    assert.equal((await call("nSafari", `/api/auth/passkeys/${list.json.passkeys[0].id}`, { method: "DELETE", token: safari.token })).status, 200);
    assert.equal((await call("nOther", "/api/auth/requests", { body: { name: "Mac" } })).json.passkey, undefined);
  },
);

test(
  "a refused add says why, in Reach's terminal and the security record (never the answer itself); a refused Face ID answer on the setting keeps its reason",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const { reach, call } = await reachWithFaceId(t);
    const said = [];
    const log = console.log;
    console.log = (...args) => said.push(args.join(" "));
    t.after(() => {
      console.log = log;
    });
    const phone = softAuthenticator({ origin: `https://${HOST}:8443` });
    const safari = reach.auth.issue("iPhone", ALL_SCOPES, "device", {
      tailscale: { userId: "42", nodeId: "nSafari" },
      nodeName: "iphone-browser",
    });
    const options = () => call("nSafari", "/api/auth/passkeys/options", { token: safari.token, body: {} });
    const add = (credential) => call("nSafari", "/api/auth/passkeys", { token: safari.token, body: { credential, label: "iPhone" } });
    const security = async () =>
      (await call("nSafari", "/api/activity", { method: "GET", token: safari.token })).json
        .filter((e) => e.kind === "security")
        .map((e) => e.title);

    // What the page used to do: a new challenge while Face ID was up.
    const first = await options();
    await options();
    const answer = phone.create(first.json);
    const refused = await add(answer);
    assert.equal(refused.status, 401);
    assert.equal(refused.json.error, "That Face ID response is for an earlier attempt. Try again.");
    const line = "Face ID not added: That Face ID response is for an earlier attempt. Try again.";
    assert.deepEqual(said.filter((l) => /Face ID/.test(l)), [`Reach: ${line}`]);
    assert.ok((await security()).includes(line));
    assert.ok(
      !said.join("\n").includes(answer.id) && !said.join("\n").includes(answer.response.clientDataJSON),
      "nothing of the answer",
    );
    // The same reason again right away: said once.
    await add(answer);
    assert.equal(said.filter((l) => l === `Reach: ${line}`).length, 1);
    // Not your own device: said too.
    const invite = reach.auth.inviteGuest({ name: "G", ttlSeconds: 600, full: true });
    const guest = reach.auth.redeemGuest(invite.invitation, { userId: "42", nodeId: "nOther" });
    assert.equal((await call("nOther", "/api/auth/passkeys/options", { token: guest.token, body: {} })).status, 403);
    assert.ok(said.includes("Reach: Face ID not added: Only your own approved devices can manage Face ID."));
    // Added: said.
    const ok = await add(phone.create((await options()).json));
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.ok(said.includes("Reach: Face ID added (iPhone)."));
    assert.ok((await security()).includes("Face ID added (iPhone)"));
    // Too many tries in a row: adding's own words.
    let last;
    for (let i = 0; i < 12 && last?.status !== 429; i++) last = await options();
    assert.equal(last.status, 429);
    assert.equal(last.json.error, "Too many tries to add Face ID. Wait 2 minutes, then try again.");
    assert.ok(said.includes("Reach: Face ID not added: Too many tries to add Face ID. Wait 2 minutes, then try again."));

    // Settings → Agents: on, then off with an answer to an older challenge.
    // Its reason reaches the phone, not "Access expired or was revoked.".
    const setting = (body) => call("nSafari", "/api/settings", { token: safari.token, body });
    assert.equal((await setting({ faceIdForAgents: true })).json.faceIdForAgents, true);
    const ask = () => call("nSafari", "/api/settings/passkey/options", { token: safari.token, body: {} });
    const older = await ask();
    await ask();
    const stale = await setting({ faceIdForAgents: false, credential: phone.get(older.json) });
    assert.equal(stale.status, 401);
    assert.equal(stale.json.error, "That Face ID response is for an earlier attempt. Try again.");
    assert.equal(
      (await call("nSafari", "/api/settings", { method: "GET", token: safari.token })).json.faceIdForAgents,
      true,
      "still on",
    );
    const off = await setting({ faceIdForAgents: false, credential: phone.get((await ask()).json) });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(off.json.faceIdForAgents, false);
  },
);
