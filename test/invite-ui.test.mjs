import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Inviting someone (a share dialog like Claude's and ChatGPT's): a name, an
// access level, Invite; one link; everyone with access listed. The requests
// each computer receives and the link that comes out are checked exactly.
let dom, React, InviteSheet, accessLabel, parseGuestLink;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ InviteSheet, accessLabel } = await dom.load("/src/InviteSheet.tsx"));
  ({ parseGuestLink } = await dom.load("/src/start-flow.ts"));
});
after(async () => dom?.close());

const macA = { id: "a", name: "Mac A", url: "https://mac-a.t.ts.net:8443", token: "ta", platform: "darwin" };
const macB = { id: "b", name: "Mac B", url: "https://mac-b.t.ts.net:8443", token: "tb", platform: "darwin" };
const device = (name, host) => ({
  id: name,
  name,
  platform: "darwin",
  arch: "arm64",
  release: "25",
  roots: [{ id: 0, name: "Projects", path: `/Users/me/${host}/Projects` }],
  memory: { total: 1, free: 1 },
  uptime: 1,
  network: { connected: true, ips: ["100.64.0.1"], peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true, screenSupported: true, codex: true },
});
const secret = (c) => c.repeat(43);
const KEY = { key: "tskey-auth-kTEST123456-abcdef", hostname: "rg-ab12-k3m9x2p7qa" };

// `keyed`: true, false, or the hosts holding the invite-link credential.
function computers({ keyed = true, failOn = "", guests = [] } = {}) {
  const log = [];
  let n = 0;
  const holders = new Set(keyed === true ? ["mac-a", "mac-b"] : keyed === false ? [] : keyed);
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const host = u.hostname.split(".")[0];
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push([init.method || "GET", host, u.pathname, body]);
    const reply = (status, value) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/api/guests/keys" && init.method === "POST") {
      if (body.accessToken !== undefined) {
        if (body.accessToken !== "tskey-api-good-1")
          return reply(400, { error: "Tailscale didn't accept that token: it may have expired, or your account isn't an admin of this tailnet." });
        holders.add(host);
        return reply(200, { configured: true, added: ["tagOwners: tag:reach-guest → autogroup:admin", "grant: tag:reach-guest → 100.64.0.1 port 8443"], allowAll: true });
      }
      if (body.clientSecret !== "tskey-client-good") return reply(502, { error: "Tailscale didn't accept the OAuth client. Check its ID and secret." });
      holders.add(host);
      return reply(200, { configured: true });
    }
    if (u.pathname === "/api/guests/keys")
      return reply(200, {
        configured: holders.has(host),
        policy: { tagOwners: { "tag:reach-guest": ["autogroup:admin"] }, grants: [{ src: ["tag:reach-guest"], dst: ["100.64.0.1"], ip: ["tcp:8443"] }] },
      });
    if (u.pathname === "/api/clients") return reply(200, { current: "me", clients: guests });
    if (u.pathname === "/api/device") return reply(200, device(host === "mac-a" ? "Mac A" : "Mac B", host));
    if (u.pathname === "/api/guests/key" && init.method === "POST")
      return holders.has(host) ? reply(201, KEY) : reply(409, { error: "Set up invite keys first: run ./reach invites on this computer." });
    if (u.pathname === "/api/files") {
      const at = u.searchParams.get("path") || "";
      const dirs = { "": ["client", "notes"], client: ["designs"] }[at] || [];
      return reply(200, {
        items: [
          ...dirs.map((d) => ({ name: d, type: "directory", path: at ? `${at}/${d}` : d })),
          { name: "readme.txt", type: "file", path: "readme.txt" },
        ],
        path: at,
      });
    }
    if (u.pathname === "/api/guests" && init.method === "POST") {
      if (host === failOn) return reply(400, { error: "Choose a guest name, what they may use, and a duration from 1 minute to 24 hours." });
      n++;
      return reply(201, { invitation: secret(String.fromCharCode(96 + n)), clientId: `client-${host}`, expiresAt: Date.now() + 3600000, scopes: [] });
    }
    if (u.pathname === "/api/agents/invitations" && init.method === "POST")
      return reply(201, { invitation: secret("z"), clientId: `agent-${host}`, expiresAt: Date.now() + body.ttlSeconds * 1000, joinBy: Date.now() + 900000, scopes: ["device", "files:read"] });
    if (u.pathname.startsWith("/api/clients/") && init.method === "DELETE") return reply(200, { ok: true });
    return reply(404, { error: "This action does not exist." });
  };
  return log;
}
const click = async (el) => {
  assert.ok(el, "element exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(40);
};
const name = async (c, value) => {
  const input = c.querySelector(".ivt-name");
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
};
const menu = (c, i) => c.querySelectorAll(".ivt-menu-button")[i];
const item = (c, text) => [...c.querySelectorAll(".ivt-item")].find((b) => b.textContent.startsWith(text));
const toggle = (c, text) => [...c.querySelectorAll(".ivt-toggle")].find((t) => t.textContent.startsWith(text)).querySelector("input");
const inviteButton = (c) => [...c.querySelectorAll("button")].find((b) => /^Invit/.test(b.textContent.trim()));
const render = (props) =>
  dom.render(React.createElement(InviteSheet, { peer: macA, device: device("Mac A", "mac-a"), peers: [macA], ...props }));
const posts = (log) => log.filter(([m, , p]) => m === "POST").map(([m, h, p, b]) => [h, p, b]);
const link = (c) => c.querySelector(".ivt-link-field").value;

test("Can watch (the default): screen and the apps you open, one keyed link", async () => {
  const log = computers();
  const view = await render();
  const c = view.container;
  assert.equal(inviteButton(c).disabled, true, "needs a name");
  assert.equal(menu(c, 0).textContent, "Can watch");
  await name(c, "Sam");
  assert.equal(c.querySelector(".ivt-summary").textContent, "Sam can watch your screen and watch the apps you open on Mac A for 4 hours.");
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(posts(log), [
    ["mac-a", "/api/guests", { name: "Sam", ttlSeconds: 14400, roots: [], folders: [], write: false, screen: "view", apps: "all", terminal: false, agents: false }],
    ["mac-a", "/api/guests/key", { ttlSeconds: 14400, clientIds: ["client-mac-a"] }],
  ]);
  assert.deepEqual(parseGuestLink(new URL(link(c)).hash), {
    ...KEY,
    invites: [{ origin: macA.url, secret: secret("a") }],
  });
  assert.match(c.querySelector(".ivt-link").textContent, /Sam’s invite link/);
  assert.match(c.querySelector(".ivt-link").textContent, /Nothing to install/);
  assert.equal(c.querySelector(".ivt-name").value, "", "ready for the next person");
  await view.unmount();
});

test("Custom on two computers: control, folders on each, terminal, editable, 1 day", async () => {
  const log = computers();
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  await name(c, "Alex");
  await click(menu(c, 0));
  await click(item(c, "Custom"));
  await click(menu(c, 1)); // On: computers
  await click(item(c, "Mac B"));
  await click(toggle(c, "Control the screen"));
  await click(toggle(c, "Folders"));
  await settle(40);
  assert.match(c.querySelector(".ivt-summary").textContent, /Alex can control your screen and open the folders you choose on Mac A and Mac B/);
  assert.equal(inviteButton(c).disabled, true, "a folder on each computer first");
  // Mac A: go into Projects, share "client" from the list.
  await click(c.querySelector('[aria-label="Open Projects"]'));
  await settle(40);
  assert.deepEqual([...c.querySelectorAll(".fb-open strong")].map((e) => e.textContent), ["client", "notes"], "folders only, no files");
  await click(c.querySelector('[aria-label="Share client"]'));
  // Mac B: share its Projects folder itself.
  await click([...c.querySelectorAll('[role="tab"]')].find((b) => b.textContent.startsWith("Mac B")));
  await settle(40);
  await click(c.querySelector('[aria-label="Share Projects"]'));
  await click(toggle(c, "Can edit"));
  await click(toggle(c, "Terminal"));
  await click(menu(c, 2)); // For
  await click(item(c, "1 day"));
  assert.equal(c.querySelector(".ivt-summary").textContent, "Alex can control your screen, edit client and Projects and use a terminal on Mac A and Mac B for 1 day.");
  await click(inviteButton(c));
  await settle(80);
  const common = { name: "Alex", ttlSeconds: 86400, roots: [], write: true, screen: "control", terminal: true, agents: false };
  assert.deepEqual(posts(log), [
    ["mac-a", "/api/guests", { ...common, folders: [{ root: 0, path: "client" }] }],
    ["mac-b", "/api/guests", { ...common, folders: [{ root: 0, path: "" }] }],
    ["mac-a", "/api/guests/key", { ttlSeconds: 86400, clientIds: ["client-mac-a"] }],
  ]);
  assert.deepEqual(parseGuestLink(new URL(link(c)).hash).invites, [
    { origin: macA.url, secret: secret("a") },
    { origin: macB.url, secret: secret("b") },
  ]);
  await view.unmount();
});

test("inviting only to another computer still gets an invite key", async () => {
  const log = computers();
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  await name(c, "Kim");
  await click(menu(c, 1));
  await click(item(c, "Mac B"));
  await click(item(c, "Mac A")); // untick the one you're on
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(
    posts(log).map(([h, p, b]) => [h, p, p.endsWith("/key") ? b : b.name]),
    [
      ["mac-b", "/api/guests", "Kim"],
      ["mac-a", "/api/guests/key", { ttlSeconds: 14400, clientIds: [] }],
    ],
  );
  const parsed = parseGuestLink(new URL(link(c)).hash);
  assert.equal(parsed.key, KEY.key);
  assert.deepEqual(parsed.invites, [{ origin: macB.url, secret: secret("a") }]);
  await view.unmount();
});

test("Full access sends just that; files need a folder; nothing is left half-made", async () => {
  let log = computers();
  let view = await render();
  let c = view.container;
  await name(c, "Ali");
  await click(menu(c, 0));
  await click(item(c, "Full access"));
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(posts(log)[0], ["mac-a", "/api/guests", { name: "Ali", ttlSeconds: 14400, full: true }]);
  await view.unmount();

  computers();
  view = await render();
  c = view.container;
  await name(c, "Lee");
  await click(menu(c, 0));
  await click(item(c, "Can use files"));
  assert.equal(inviteButton(c).disabled, true);
  assert.equal(c.querySelector(".ivt-summary").textContent, "Lee can open the folders you choose on Mac A for 4 hours.");
  await view.unmount();

  log = computers({ failOn: "mac-b" });
  view = await render({ peers: [macA, macB] });
  c = view.container;
  await name(c, "Sam");
  await click(menu(c, 1));
  await click(item(c, "Mac B"));
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(
    log.filter(([m]) => m !== "GET").map(([m, h, p]) => `${m} ${h} ${p}`),
    ["POST mac-a /api/guests", "POST mac-b /api/guests", "DELETE mac-a /api/clients/client-mac-a"],
  );
  assert.equal(c.querySelector(".ivt-link"), null);
  assert.match(c.querySelector(".ivt-error").textContent, /Choose a guest name/);
  await view.unmount();
});

test("without invite keys: one slim line, never in the way; Tailscale sharing only as a fallback", async () => {
  const log = computers({ keyed: false });
  const view = await render();
  const c = view.container;
  await settle(40);
  assert.equal(c.querySelector(".ivt-setup-line").textContent.trim(), "Guests need a one-time setupSet up");
  assert.equal(c.querySelector(".ivt-setup"), null, "not opened until you tap it");
  await name(c, "Lee");
  await click(inviteButton(c));
  await settle(80);
  assert.ok(!posts(log).some(([, p]) => p === "/api/guests/key"), "no key without the OAuth client");
  assert.match(c.querySelector(".ivt-tailscale").textContent, /Lee would need Tailscale for this link/);
  assert.ok(
    [...c.querySelectorAll(".ivt-tailscale > button")].some((b) => b.textContent === "Set up invite links"),
    "setup comes first; Tailscale sharing is the fallback",
  );
  assert.equal(c.querySelector(".ivt-fallback summary").textContent, "They already use Tailscale");
  assert.equal(c.querySelector(".ivt-link-field"), null, "no link until they can reach it");
  // Setup opens from the link card too, and folds back with ×.
  await click([...c.querySelectorAll(".ivt-tailscale > button")].find((b) => b.textContent === "Set up invite links"));
  assert.ok(c.querySelector(".ivt-setup"));
  await click(c.querySelector('.ivt-setup [aria-label="Close"]'));
  assert.equal(c.querySelector(".ivt-setup"), null);
  assert.ok(c.querySelector(".ivt-setup-line"));
  // The fallback: they already use Tailscale.
  await click(toggle(c, "They’re already on my Tailscale"));
  assert.equal(parseGuestLink(new URL(link(c)).hash).key, "");
  await view.unmount();
});

test("set up invite links from the phone with one token, then the very next invite is one link", async () => {
  dom.window.localStorage.clear();
  const log = computers({ keyed: false });
  const view = await render();
  const c = view.container;
  await settle(40);
  await click(c.querySelector(".ivt-setup-line"));
  const setup = c.querySelector(".ivt-setup");
  // One step: get a token in Tailscale, paste it, Connect.
  const tokenPage = setup.querySelector('a[href="https://login.tailscale.com/admin/settings/keys"]');
  assert.equal(tokenPage.textContent, "Get a token");
  assert.equal(tokenPage.getAttribute("target"), "_blank");
  assert.equal(setup.querySelector("pre, code"), null, "no policy text to read");
  const field = setup.querySelector('[aria-label="Access token"]');
  assert.equal(field.type, "password");
  const type = async (el, v) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
  };
  const connect = () => [...setup.querySelectorAll("button")].find((b) => /Connect|Setting up/.test(b.textContent));
  assert.equal(connect().disabled, true);
  await type(field, "tskey-client-wrong-kind");
  assert.equal(connect().disabled, true, "only an access token");
  await type(field, "tskey-api-expired-9");
  await click(connect());
  await settle(60);
  assert.match(setup.textContent, /didn't accept that token/);
  await type(field, "tskey-api-good-1");
  await click(connect());
  await settle(60);
  assert.equal(c.querySelector(".ivt-setup"), null, "done");
  assert.deepEqual(
    log.filter(([m, , p]) => m === "POST" && p === "/api/guests/keys").map(([, h, , b]) => [h, b]),
    [
      ["mac-a", { accessToken: "tskey-api-expired-9" }],
      ["mac-a", { accessToken: "tskey-api-good-1" }],
    ],
  );
  // The policy still lets everyone reach everything: said once, plainly.
  assert.match(c.querySelector(".ivt-warn[role=status]").textContent, /lets every device reach everything/);
  await name(c, "Sam");
  await click(inviteButton(c));
  await settle(80);
  assert.equal(parseGuestLink(new URL(link(c)).hash).key, KEY.key);
  await view.unmount();
});

test("by hand still works: three short steps, and back to the token way", async () => {
  dom.window.localStorage.clear();
  const log = computers({ keyed: false });
  const view = await render();
  const c = view.container;
  await settle(40);
  await click(c.querySelector(".ivt-setup-line"));
  const byHand = () => [...c.querySelectorAll(".ivt-setup button")].find((b) => b.textContent === "Do it by hand instead");
  await click(byHand());
  let setup = c.querySelector(".ivt-setup");
  const step = () => setup.querySelector(":scope > strong").textContent;
  const next = () => click([...setup.querySelectorAll("button")].find((b) => b.textContent === "Next"));
  assert.equal(step(), "Create a guest tag");
  assert.equal(setup.querySelector('a[href*="/admin/acls"]').getAttribute("target"), "_blank");
  let copied = "";
  dom.window.navigator.clipboard = { writeText: async (t) => (copied = t) };
  await click([...setup.querySelectorAll("button")].find((b) => b.textContent === "Copy the rules"));
  assert.match(copied, /"tag:reach-guest"/);
  // Changed your mind: back to the one-token way, and here again.
  await click([...setup.querySelectorAll("button")].find((b) => b.textContent === "Use a token instead"));
  assert.ok(c.querySelector('[aria-label="Access token"]'));
  await click(byHand());
  setup = c.querySelector(".ivt-setup");
  await next();
  assert.equal(step(), "Create Reach’s key");
  assert.equal(setup.querySelector('a[href*="trust-credentials"]').getAttribute("target"), "_blank");
  await next();
  assert.equal(step(), "Paste it here");
  const field = (label) => setup.querySelector(`[aria-label="${label}"]`);
  const type = async (el, v) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
  };
  const connect = () => [...setup.querySelectorAll("button")].find((b) => /Connect|Checking/.test(b.textContent));
  assert.equal(connect().disabled, true);
  await type(field("Client ID"), "k123");
  await type(field("Client secret"), "tskey-client-bad");
  await click(connect());
  await settle(60);
  assert.match(setup.textContent, /didn't accept the OAuth client/);
  assert.equal(field("Client secret").type, "password");
  await type(field("Client secret"), "tskey-client-good");
  await click(connect());
  await settle(60);
  assert.equal(c.querySelector(".ivt-setup"), null, "done");
  assert.equal(c.querySelector(".ivt-warn[role=status]"), null, "nothing to warn about");
  assert.deepEqual(
    log.filter(([m, , p]) => m === "POST" && p === "/api/guests/keys").map(([, h, , b]) => [h, b]),
    [
      ["mac-a", { clientId: "k123", clientSecret: "tskey-client-bad" }],
      ["mac-a", { clientId: "k123", clientSecret: "tskey-client-good" }],
    ],
  );
  await view.unmount();
});

test("set up once for all computers: a linked computer's credential is used", async () => {
  dom.window.localStorage.clear();
  const log = computers({ keyed: ["mac-b"] });
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  await settle(60);
  assert.equal(c.querySelector(".ivt-setup"), null, "no setup: Mac B has it");
  await name(c, "Kim");
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(
    posts(log).map(([h, p, b]) => [h, p, p.endsWith("/key") ? b : b.name]),
    [
      ["mac-a", "/api/guests", "Kim"],
      ["mac-b", "/api/guests/key", { ttlSeconds: 14400, clientIds: [] }],
    ],
  );
  assert.equal(parseGuestLink(new URL(link(c)).hash).key, KEY.key);
  await view.unmount();
});

test("people with access: their access, joined or not, time left; end one now", async () => {
  const later = Date.now() + 2 * 3600 * 1000 + 60000;
  const log = computers({
    guests: [
      { id: "g1", kind: "guest", name: "Sam", status: "accepted", expiresAt: later, scopes: ["device", "screen", "screen:control", "apps:open"] },
      { id: "g2", kind: "guest", name: "Kim", status: "invited", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "old", kind: "guest", name: "Old", status: "expired", expiresAt: Date.now() - 1000 },
      { id: "me", kind: "device", name: "My iPhone", expiresAt: later },
    ],
  });
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  await settle(40);
  const rows = [...c.querySelectorAll(".ivt-person")].map((r) => [...r.querySelectorAll("strong, small, .ivt-role-text")].map((e) => e.textContent).join(" | "));
  assert.deepEqual(rows, [
    "You | Mac A and Mac B | Owner",
    "Sam | Controls screen · Watches apps | Joined · 2 h 1 min left",
    "Kim | Opens files | Not opened yet · 2 h 1 min left",
  ]);
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Kim’s access"]'));
  assert.ok(log.some(([m, , p]) => m === "DELETE" && p === "/api/clients/g2"));
  await view.unmount();
});

test("access names", () => {
  assert.equal(accessLabel(["admin", "device"]), "Full access");
  assert.equal(accessLabel(["device", "screen"]), "Watches screen");
  assert.equal(accessLabel(["device", "screen", "screen:control", "files:read", "files:write", "terminal", "codex"]), "Controls screen · Edits files · Terminal · AI sessions");
  assert.equal(accessLabel(["device"]), "No access");
});

test("rendering stayed clean (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});

test("the folder browser: go in and back up, share from the list or from inside", async () => {
  const log = computers();
  const view = await render();
  const c = view.container;
  await name(c, "Lee");
  await click(menu(c, 0));
  await click(item(c, "Can use files"));
  const crumbs = () => [...c.querySelectorAll(".fb-crumbs button")].map((b) => b.textContent.trim());
  assert.deepEqual(crumbs(), ["Mac A"]);
  await click(c.querySelector('[aria-label="Open Projects"]'));
  await click(c.querySelector('[aria-label="Open client"]'));
  await settle(40);
  assert.deepEqual(crumbs(), ["Mac A", "Projects", "client"]);
  // Share the folder you're in.
  await click([...c.querySelectorAll(".fb-share")][0]);
  assert.match(c.querySelector(".fb-share").textContent, /Sharing client/);
  // Back up via the path, and share another one from the list.
  await click([...c.querySelectorAll(".fb-crumbs button")].find((b) => b.textContent.trim() === "Projects"));
  await settle(40);
  await click(c.querySelector('[aria-label="Share notes"]'));
  assert.deepEqual([...c.querySelectorAll(".fb-chip")].map((e) => e.textContent.trim()), ["client", "notes"]);
  // Remove one from its chip.
  await click(c.querySelector('[aria-label="Stop sharing notes"]'));
  assert.deepEqual([...c.querySelectorAll(".fb-chip")].map((e) => e.textContent.trim()), ["client"]);
  assert.equal(c.querySelector(".ivt-summary").textContent, "Lee can open client on Mac A for 4 hours.");
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(posts(log)[0][2].folders, [{ root: 0, path: "client" }]);
  assert.deepEqual(posts(log)[0][2].roots, []);
  await view.unmount();
});

test("still clean after browsing folders (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});

test("set up after inviting: the waiting link gets its key, so they just open it", async () => {
  dom.window.localStorage.clear();
  const log = computers({ keyed: false });
  const view = await render();
  const c = view.container;
  await settle(40);
  await name(c, "Ana");
  await click(inviteButton(c));
  await settle(80);
  assert.equal(c.querySelector(".ivt-link-field"), null);
  await click([...c.querySelectorAll(".ivt-tailscale > button")].find((b) => b.textContent === "Set up invite links"));
  const setup = c.querySelector(".ivt-setup");
  assert.ok(setup, "the setup opens");
  const type = async (el, v) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
  };
  await type(setup.querySelector('[aria-label="Access token"]'), "tskey-api-good-1");
  await click([...setup.querySelectorAll("button")].find((b) => b.textContent === "Connect"));
  await settle(120);
  const keyCall = log.find(([m, , p]) => m === "POST" && p === "/api/guests/key");
  assert.deepEqual(keyCall[3].clientIds, ["client-mac-a"]);
  assert.ok(keyCall[3].ttlSeconds > 14000 && keyCall[3].ttlSeconds <= 14400);
  const parsed = parseGuestLink(new URL(link(c)).hash);
  assert.equal(parsed.key, KEY.key);
  assert.deepEqual(parsed.invites, [{ origin: macA.url, secret: secret("a") }], "the same invitation");
  assert.match(c.querySelector(".ivt-link").textContent, /Nothing to install/);
  await view.unmount();
  dom.window.localStorage.clear();
});

// Inviting an agent: the same dialog, then one command it runs to join.
const kindButton = (c, text) => [...c.querySelectorAll('.ivt-kind [role="radio"]')].find((b) => b.textContent === text);
const commandLink = (command) => command.match(/ join '([^']+)'$/)[1];

test("an agent: one computer, a folder, what it may do, then one command to give it", async () => {
  const log = computers();
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  await settle(40);
  await click(kindButton(c, "Agent"));
  assert.equal(kindButton(c, "Agent").getAttribute("aria-checked"), "true");
  assert.equal(c.querySelector(".ivt-name").placeholder, "Name the agent");
  await name(c, "Claude on my server");
  assert.equal(menu(c, 0).textContent, "Can edit");
  assert.equal(c.querySelector(".ivt-summary").textContent, "Claude on my server can read and edit the folders you choose on Mac A for 1 week.");
  assert.equal(inviteButton(c).disabled, true, "a folder first");
  // One computer: picking Mac B replaces Mac A.
  await click(menu(c, 1));
  await click(item(c, "Mac B"));
  assert.equal(menu(c, 1).textContent, "Mac B");
  await settle(40);
  await click(c.querySelector('[aria-label="Share Projects"]'));
  await click(menu(c, 0));
  assert.match(item(c, "Can run commands").textContent, /Commands run as you, so they can reach beyond those folders/);
  await click(item(c, "Can run commands"));
  await click(menu(c, 2));
  await click(item(c, "30 days"));
  assert.equal(c.querySelector(".ivt-summary").textContent, "Claude on my server can edit and run commands in Projects on Mac B for 30 days.");
  await click(inviteButton(c));
  await settle(80);
  const sent = posts(log);
  assert.deepEqual(sent[0], [
    "mac-b",
    "/api/agents/invitations",
    { name: "Claude on my server", ttlSeconds: 30 * 86400, folders: [{ root: 0, path: "" }], write: true, exec: true },
  ]);
  // The key comes from its own computer (so ending it there removes its
  // device too) and lasts only until it joins.
  assert.equal(sent[1][0], "mac-b");
  assert.equal(sent[1][1], "/api/guests/key");
  assert.equal(sent[1][2].ttlSeconds, 30 * 86400);
  assert.ok(sent[1][2].keySeconds > 880 && sent[1][2].keySeconds <= 900, String(sent[1][2].keySeconds));
  assert.deepEqual(sent[1][2].clientIds, ["agent-mac-b"]);
  assert.equal(sent.length, 2);
  const card = c.querySelector('[aria-label="Agent invitation"]');
  assert.match(card.textContent, /Claude on my server is invited/);
  assert.match(card.textContent, /Needs Node 18 or later, nothing else/);
  const command = c.querySelector('[aria-label="Command for the agent"]').value;
  assert.ok(
    command.startsWith("curl -fsSL --create-dirs -o ~/.reach-agent/agent.mjs https://mac-b.t.ts.net/agent.mjs && node ~/.reach-agent/agent.mjs join 'https://mac-b.t.ts.net/agent#"),
    command,
  );
  const agentLink = new URL(commandLink(command));
  assert.equal(agentLink.pathname, "/agent", "never a link a browser would use");
  assert.deepEqual(parseGuestLink(agentLink.hash), { ...KEY, invites: [{ origin: macB.url, secret: secret("z") }] });
  let copied = "";
  dom.window.navigator.clipboard = { writeText: async (t) => (copied = t) };
  await click([...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Copy"));
  assert.equal(copied, `Join my computer with Reach, then add the MCP server it prints:\n${command}`);
  // Back to inviting a person: their dialog as it was.
  await click(kindButton(c, "Person"));
  assert.equal(c.querySelector(".ivt-name").placeholder, "Who are you inviting?");
  assert.equal(menu(c, 0).textContent, "Can watch");
  await view.unmount();
});

test("an agent on a computer without the setup: its key comes from a linked one", async () => {
  const log = computers({ keyed: ["mac-a"] });
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  await settle(40);
  await click(kindButton(c, "Agent"));
  await name(c, "Codex");
  await click(menu(c, 1));
  await click(item(c, "Mac B"));
  await settle(40);
  await click(c.querySelector('[aria-label="Share Projects"]'));
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(
    posts(log).map(([h, p, b]) => [h, p, b.clientIds]),
    [
      ["mac-b", "/api/agents/invitations", undefined],
      ["mac-b", "/api/guests/key", ["agent-mac-b"]],
      ["mac-a", "/api/guests/key", []],
    ],
  );
  const command = c.querySelector('[aria-label="Command for the agent"]').value;
  assert.equal(parseGuestLink(new URL(commandLink(command)).hash).key, KEY.key);
  await view.unmount();
});

test("agents with access: what they can do, joined or not, or didn't join in time", async () => {
  const later = Date.now() + 7 * 86400 * 1000;
  const log = computers({
    guests: [
      { id: "a1", kind: "agent", name: "Builder", policy: { invite: true }, status: "accepted", expiresAt: later, scopes: ["device", "files:read", "files:write", "exec"] },
      { id: "a2", kind: "agent", name: "Reader", policy: { invite: true }, status: "invited", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "a3", kind: "agent", name: "Late", policy: { invite: true }, status: "expired", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "cli", kind: "agent", name: "Policy agent", policy: { profile: "work" }, expiresAt: later, scopes: ["device", "files:read"] },
    ],
  });
  const view = await render();
  const c = view.container;
  await settle(40);
  const rows = [...c.querySelectorAll(".ivt-person")].map((r) => [...r.querySelectorAll("strong, small, .ivt-role-text")].map((e) => e.textContent).join(" | "));
  assert.deepEqual(rows, [
    "You | Mac A | Owner",
    "Builder | Edits files · Runs commands | Joined · 168 h 0 min left",
    "Reader | Opens files | Not joined yet · 168 h 0 min left",
    "Late | Opens files | Didn’t join in time",
  ]);
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Builder’s access"]'));
  assert.ok(log.some(([m, , p]) => m === "DELETE" && p === "/api/clients/a1"));
  await view.unmount();
});

test("an agent without invite links: still a command (for a machine on your tailnet); setup adds its key", async () => {
  dom.window.localStorage.clear();
  const log = computers({ keyed: false });
  const view = await render();
  const c = view.container;
  await settle(40);
  await click(kindButton(c, "Agent"));
  await name(c, "Codex");
  await click(c.querySelector('[aria-label="Share Projects"]'));
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(posts(log).map(([h, p]) => p), ["/api/agents/invitations"]);
  const card = c.querySelector('[aria-label="Agent invitation"]');
  assert.match(card.textContent, /Without invite links, its machine needs Tailscale on your tailnet/);
  assert.equal(parseGuestLink(new URL(commandLink(c.querySelector('[aria-label="Command for the agent"]').value)).hash).key, "");
  await click([...card.querySelectorAll(".ivt-tailscale > button")].find((b) => b.textContent === "Set up invite links"));
  const setup = c.querySelector(".ivt-setup");
  const type = async (el, v) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
  };
  await type(setup.querySelector('[aria-label="Access token"]'), "tskey-api-good-1");
  await click([...setup.querySelectorAll("button")].find((b) => b.textContent === "Connect"));
  await settle(120);
  const keyCall = log.find(([m, , p]) => m === "POST" && p === "/api/guests/key");
  assert.deepEqual(keyCall[3].clientIds, ["agent-mac-a"]);
  assert.ok(keyCall[3].ttlSeconds > 7 * 86400 - 100 && keyCall[3].ttlSeconds <= 7 * 86400);
  assert.ok(keyCall[3].keySeconds > 880 && keyCall[3].keySeconds <= 900);
  const command = c.querySelector('[aria-label="Command for the agent"]').value;
  const fixed = new URL(commandLink(command));
  assert.equal(fixed.pathname, "/agent");
  assert.deepEqual(parseGuestLink(fixed.hash), { ...KEY, invites: [{ origin: macA.url, secret: secret("z") }] }, "the same invitation, now with a key");
  assert.match(c.querySelector('[aria-label="Agent invitation"]').textContent, /nothing else/);
  await view.unmount();
  dom.window.localStorage.clear();
});

test("clean to the end (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});
