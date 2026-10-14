import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupInvites, KEYS_PAGE } from "../scripts/invites.mjs";
import { tskey } from "./helpers/fake-keys.mjs";

// `reach setup invites`: paste one token, see exactly what Reach adds, and
// it's done. The by-hand path stays for anyone who prefers it.
const TOKEN = tskey("api-kAbc123CNTRL-SecretPart9");

function fakeApi(policy) {
  const api = { policy, clients: [] };
  api.request = async (url, init = {}) => {
    const route = new URL(url).pathname.replace("/api/v2", "");
    const method = init.method || "GET";
    const reply = (status, body, headers = {}) => ({
      ok: status < 400,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });
    if (route === "/oauth/token") return reply(200, { access_token: "oauth-x", expires_in: 3600 });
    const auth = init.headers?.Authorization;
    if (auth === "Bearer oauth-x") {
      if (route === "/tailnet/-/devices") return reply(200, { devices: [] });
      if (route === "/tailnet/-/keys" && method === "POST") return reply(200, { id: "a1", key: tskey("auth-a1-x") });
      return reply(200, {});
    }
    if (auth !== `Bearer ${TOKEN}`) return reply(401, {});
    if (route === "/tailnet/-/acl" && method === "GET") return reply(200, api.policy, { etag: '"v1"' });
    if (route === "/tailnet/-/acl/validate") return reply(200, "");
    if (route === "/tailnet/-/acl" && method === "POST") return (api.policy = init.body), reply(200, init.body);
    if (route === "/tailnet/-/keys" && method === "POST") {
      api.clients.push(JSON.parse(init.body));
      return reply(200, { id: "k1CNTRL", key: tskey("client-k1CNTRL-secret") });
    }
    return reply(404, {});
  };
  return api;
}
function computer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-invites-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".reach", "quick"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".reach", "preferences.json"),
    JSON.stringify({ version: 1, owner: { userId: "42", login: "me@x.test" }, folders: ["/Users/me"], httpsPort: 8443 }),
  );
  fs.writeFileSync(path.join(root, ".reach", "quick", "device.json"), JSON.stringify({ id: "dev-a" }));
  return root;
}
const status = async () => ({ Self: { TailscaleIPs: ["100.64.0.5", "fd7a::5"] }, Peer: {} });

test("token path: opens the token page, shows exactly what's added, then it's ready", async (t) => {
  delete process.env.REACH_DATA;
  const root = computer(t);
  const api = fakeApi(`{"grants": [{"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]}]}`);
  const out = [];
  const asked = [];
  const opened = [];
  await setupInvites(root, {
    platform: "darwin",
    print: (m) => out.push(m),
    select: async ({ message, choices }) => (asked.push(message), choices[0].value),
    ask: async () => "",
    secret: async () => TOKEN,
    open: async (url) => opened.push(url),
    status,
    guestKeys: { request: api.request },
  });
  const text = out.join("\n");
  assert.deepEqual(asked, ["How do you want to set this up?", "Add these?"]);
  assert.deepEqual(opened, [KEYS_PAGE]);
  assert.match(text, /\+ tagOwners: tag:reach-guest → autogroup:admin/);
  assert.match(text, /\+ grant: tag:reach-guest → 100\.64\.0\.5 port 8443/);
  assert.doesNotMatch(text, /Heads up/);
  assert.match(text, /Invite links are ready/);
  assert.doesNotMatch(text, /tskey-api-/, "the token is never printed");
  assert.ok(fs.existsSync(path.join(root, ".reach", "quick", "tailscale-oauth.json")));
  assert.deepEqual(api.clients[0].scopes, ["auth_keys", "devices:core", "policy_file:read"]);
});

test("cancel at the confirmation: policy untouched, nothing saved, and setup goes on", async (t) => {
  delete process.env.REACH_DATA;
  const root = computer(t);
  const before = `{"grants": []}`;
  const api = fakeApi(before);
  const out = [];
  // Declining is a choice, not a stop: the invites step is skipped (first-run
  // matrix I4), where it used to pause the whole setup.
  assert.deepEqual(
    await setupInvites(root, {
      platform: "darwin",
      print: (m) => out.push(m),
      select: async ({ message, choices }) =>
        message === "Add these?" ? "no" : choices[0].value,
      ask: async () => "",
      secret: async () => TOKEN,
      open: async () => {},
      status,
      guestKeys: { request: api.request },
    }),
    { ready: false },
  );
  assert.match(out.join("\n"), /Nothing changed\. Set up invite links any time with \.\/reach setup invites/);
  assert.equal(api.policy, before);
  assert.equal(api.clients.length, 0);
  assert.ok(!fs.existsSync(path.join(root, ".reach", "quick", "tailscale-oauth.json")));
});

// I3: a new tailnet's default policy (every device reaches every other):
// offered to narrow that one rule to your members, as the phone does.
test("a new tailnet's default policy: narrowed to your members once you say yes, then ready", async (t) => {
  delete process.env.REACH_DATA;
  const root = computer(t);
  const api = fakeApi(`{"grants": [{"src": ["*"], "dst": ["*"], "ip": ["*"]}]}`);
  const out = [];
  const asked = [];
  const result = await setupInvites(root, {
    platform: "darwin",
    print: (m) => out.push(m),
    select: async ({ message, choices }) => (asked.push(message), choices[0].value),
    ask: async () => "",
    secret: async () => TOKEN,
    open: async () => {},
    status,
    guestKeys: { request: api.request },
  });
  assert.deepEqual(result, { ready: true });
  assert.deepEqual(asked, ["How do you want to set this up?", "Change the default rule?", "Add these?"]);
  assert.match(out.join("\n"), /every device may reach every other/);
  assert.match(out.join("\n"), /all devices → tailnet members/);
  assert.match(api.policy, /"autogroup:member"/);
});

test("a new tailnet's default policy, left as it is: nothing changed, invite links stay off", async (t) => {
  delete process.env.REACH_DATA;
  const root = computer(t);
  const before = `{"grants": [{"src": ["*"], "dst": ["*"], "ip": ["*"]}]}`;
  const api = fakeApi(before);
  const result = await setupInvites(root, {
    platform: "darwin",
    print: () => {},
    select: async ({ message, choices }) => (message === "Change the default rule?" ? "no" : choices[0].value),
    ask: async () => "",
    secret: async () => TOKEN,
    open: async () => {},
    status,
    guestKeys: { request: api.request },
  });
  assert.deepEqual(result, { ready: false });
  assert.equal(api.policy, before);
  assert.equal(api.clients.length, 0);
});

// First-run matrix T26: a Windows Reach approves phones by pairing code, so it
// can't make invite keys; `.\reach.cmd invites` says so before anything else.
test("Windows: invites as on a Mac, once Reach's folders are private; when they can't be, why, and nothing touched", async (t) => {
  const root = computer(t);
  const api = fakeApi({ grants: [] });
  await assert.rejects(
    setupInvites(root, {
      platform: "win32",
      privateFolders: async () => ({ ok: false, reason: "Reach's folder C:\\reach can be changed by other people on this PC, so browser sign-in stays off." }),
      status: async () => assert.fail("no Tailscale call before its folders are private"),
      select: async () => assert.fail("no question"),
      ask: async () => assert.fail("no question"),
      print() {},
      request: api.request,
    }),
    { message: "Reach's folder C:\\reach can be changed by other people on this PC, so browser sign-in stays off. Invite links weren't set up." },
  );
  assert.deepEqual(api.clients, []);
});
