import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
import { tskey } from "./helpers/fake-keys.mjs";

// Inviting someone (a share dialog like Claude's and ChatGPT's): a name, an
// access level, Invite; one link; everyone with access listed. The requests
// each computer receives and the link that comes out are checked exactly.
let dom, React, InviteSheet, PeopleHub, accessLabel, parseGuestLink;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ({ InviteSheet, accessLabel } = await dom.load("/src/InviteSheet.tsx"));
  ({ default: PeopleHub } = await dom.load("/src/PeopleHub.tsx"));
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
// The SHA-256 of the runtime each computer serves: every agent command pins it.
const RUNTIME = "ab".repeat(32);
const KEY = { key: tskey("auth-kTEST123456-abcdef"), hostname: "rg-ab12-k3m9x2p7qa" };

// `keyed`: true, false, or the hosts holding the invite-link credential.
// `unavailable`: why this computer can make no invite keys (a Windows Reach).
function computers({ keyed = true, failOn = "", guests = [], policyBlock = false, unavailable = "" } = {}) {
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
        if (body.accessToken !== tskey("api-good-1"))
          return reply(400, { error: "Tailscale didn't accept that token: it may have expired, or your account isn't an admin of this tailnet." });
        if (policyBlock && body.narrowDefaultWildcard !== true)
          return reply(409, { error: "Guest access is not isolated: grants[1]", canNarrowDefault: true });
        holders.add(host);
        return reply(200, { configured: true, added: ["tagOwners: tag:reach-guest → autogroup:admin", "grant: tag:reach-guest → 100.64.0.1 port 8443"], allowAll: !policyBlock });
      }
      if (body.clientSecret !== tskey("client-good")) return reply(502, { error: "Tailscale didn't accept the OAuth client. Check its ID and secret." });
      holders.add(host);
      return reply(200, { configured: true });
    }
    if (u.pathname === "/api/guests/keys")
      return reply(200, {
        configured: holders.has(host),
        ...(unavailable ? { available: false, why: unavailable } : {}),
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
      return reply(201, { invitation: secret("z"), clientId: `agent-${host}`, expiresAt: Date.now() + body.ttlSeconds * 1000, joinBy: Date.now() + 900000, scopes: ["device", "files:read"], runtime: RUNTIME });
    if (/^\/api\/guests\/[^/]+\/link$/.test(u.pathname) && init.method === "POST") {
      const id = u.pathname.split("/")[3];
      // A browser agent through the public link: its page, and the runtime its tools pin.
      const funnel = guests.find((g) => g.id === id)?.browserTransport === "funnel";
      return reply(200, { invitation: secret("n"), clientId: id, expiresAt: Date.now() + 3600000,
        ...(funnel ? { url: `https://${host}.t.ts.net/agent-browser#invite=${secret("n")}`, transport: "funnel", runtime: RUNTIME } : {}) });
    }
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
// A row's menu, by the row's name (Computer, Expires, Connects).
const menu = (c, label) => [...c.querySelectorAll(".ivt-row")].find((r) => r.querySelector(".ivt-setting-label")?.textContent.trim() === label)?.querySelector(".ivt-menu-button");
// What they may do: a list with a check, chosen with one tap.
const access = (c, label) => [...c.querySelectorAll('.inv-choices [role="radio"]')].find((b) => b.getAttribute("aria-label") === label);
const chosen = (c) => c.querySelector('.inv-choices [role="radio"][aria-checked="true"]')?.getAttribute("aria-label");
const item = (c, text) => [...c.querySelectorAll(".ivt-item")].find((b) => b.textContent.startsWith(text));
const toggle = (c, text) => [...c.querySelectorAll(".ivt-toggle")].find((t) => t.textContent.startsWith(text)).querySelector("input");
const inviteButton = (c) => c.querySelector(".ivt-submit");
const render = (props) =>
  dom.render(React.createElement(InviteSheet, { peer: macA, device: device("Mac A", "mac-a"), peers: [macA], ...props }));
// Agents & people: every row's name and its one line, in order.
const hub = (props) =>
  dom.render(React.createElement(PeopleHub, { peer: macA, device: device("Mac A", "mac-a"), peers: [macA], ...props }));
const hubRows = (c) => [...c.querySelectorAll(".ppl-row")].map((r) => [...r.querySelectorAll("strong, small")].map((e) => e.textContent).join(" | "));
const openRow = (c, name) => click([...c.querySelectorAll(".ppl-row")].find((r) => r.querySelector("strong").textContent === name));
// An invitation carries one id for all its computers (so its access can be
// changed later on each): checked on its own, set aside in the exact lists.
const posts = (log) =>
  log
    .filter(([m, , p]) => m === "POST")
    .map(([m, h, p, b]) => {
      if (p !== "/api/guests" || !b?.group) return [h, p, b];
      const { group, ...rest } = b;
      return [h, p, rest];
    });
const groups = (log) => log.filter(([m, , p]) => m === "POST" && p === "/api/guests").map(([, , , b]) => b.group);
const link = (c) => c.querySelector(".ivt-link-field").value;

test("Can watch (the default): screen and the apps you open, one keyed link", async () => {
  const log = computers();
  const view = await render();
  const c = view.container;
  assert.equal(inviteButton(c).disabled, true, "needs a name");
  assert.equal(chosen(c), "Can watch");
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
  assert.match(c.querySelector(".ivt-link").textContent, /Sam is invited/);
  assert.match(c.querySelector(".ivt-link").textContent, /Can watch · 4 hours/);
  assert.match(c.querySelector(".ivt-link").textContent, /Nothing to install/);
  assert.equal(c.querySelector(".ivt-name").value, "", "ready for the next person");
  await view.unmount();
});

// A Windows PC paints password managers and Reach's windows black in an
// invited person's picture (parity audit #12): once it says it can
// (capabilities.guestScreen, detected), the sheet offers watching and
// control as on a Mac; one that can't offers neither, and says why (found by
// the user journeys on Windows, Oct 14).
test("on a Windows PC that can hide private windows, people are invited to watch or control as on a Mac; one that can't says why", async () => {
  computers();
  const ready = { ...device("Mac A", "mac-a"), platform: "win32" };
  ready.capabilities = { ...ready.capabilities, guestScreen: true };
  const offered = await render({ peer: { ...macA, platform: "win32" }, device: ready });
  assert.ok(access(offered.container, "Can watch") && access(offered.container, "Can control"));
  assert.equal(offered.container.querySelector(".ivt-no-screen"), null);
  await offered.unmount();
  computers();
  const pc = { ...device("Mac A", "mac-a"), platform: "win32" };
  pc.capabilities = { ...pc.capabilities, guestScreen: false };
  const view = await render({ peer: { ...macA, platform: "win32" }, device: pc });
  const c = view.container;
  assert.equal(access(c, "Can watch"), undefined);
  assert.equal(access(c, "Can control"), undefined);
  assert.ok(access(c, "Can use files"), "the other roles stay");
  assert.notEqual(chosen(c), "Can watch");
  assert.equal(
    c.querySelector(".ivt-no-screen")?.textContent,
    "Watching or controlling the screen isn't offered on this Windows PC right now: Reach can't hide password managers and its own windows from invited people there.",
  );
  await view.unmount();
  // A Mac offers both, with nothing to explain.
  computers();
  const mac = await render({});
  assert.ok(access(mac.container, "Can watch") && access(mac.container, "Can control"));
  assert.equal(mac.container.querySelector(".ivt-no-screen"), null);
  await mac.unmount();
});

test("Custom on two computers: control, folders on each, terminal, editable, 1 day", async () => {
  const log = computers();
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  await name(c, "Alex");
  await click(access(c, "Custom"));
  await click(menu(c, "Computer"));
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
  await click(menu(c, "Expires"));
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
  const [a, b] = groups(log);
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(b, a, "one id for the invitation on both computers");
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
  await click(menu(c, "Computer"));
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
  await click(access(c, "Full access"));
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(posts(log)[0], ["mac-a", "/api/guests", { name: "Ali", ttlSeconds: 14400, full: true, fullControlVersion: 1 }]);
  await view.unmount();

  computers();
  view = await render();
  c = view.container;
  await name(c, "Lee");
  await click(access(c, "Can use files"));
  assert.equal(inviteButton(c).disabled, true);
  assert.equal(c.querySelector(".ivt-summary").textContent, "Lee can open the folders you choose on Mac A for 4 hours.");
  await view.unmount();

  log = computers({ failOn: "mac-b" });
  view = await render({ peers: [macA, macB] });
  c = view.container;
  await name(c, "Sam");
  await click(menu(c, "Computer"));
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
  assert.equal(c.querySelector(".ivt-setup-line"), null, "the link's own button, not a second line");
  // Setup opens from the link card too, and folds back with ×.
  await click([...c.querySelectorAll(".ivt-tailscale > button")].find((b) => b.textContent === "Set up invite links"));
  assert.ok(c.querySelector(".ivt-setup"));
  await click(c.querySelector('.ivt-setup [aria-label="Close"]'));
  assert.equal(c.querySelector(".ivt-setup"), null);
  // The fallback: they already use Tailscale.
  await click(toggle(c, "They’re already on my Tailscale"));
  assert.equal(parseGuestLink(new URL(link(c)).hash).key, "");
  await view.unmount();
});

// First-run matrix T26: a computer that can't make invite keys for now (a
// PC set up for browser sign-in, on pairing codes until Tailscale is new
// enough). The sheet says why instead of a setup that can't work, and
// Tailscale sharing (the way that does) is open from the start.
test("a computer that can't make invite links: says why, no setup, Tailscale sharing open", async () => {
  const why = "Invite links are off on this Windows PC for now: Tailscale 1.90.0 is older than 1.104; update Tailscale.";
  const log = computers({ keyed: false, unavailable: why });
  const view = await render();
  const c = view.container;
  await settle(40);
  assert.equal(c.querySelector(".ivt-setup-line"), null, "no setup to start");
  assert.equal(c.querySelector(".ivt-no-keys").textContent, why);
  await name(c, "Lee");
  await click(inviteButton(c));
  await settle(80);
  assert.match(c.querySelector(".ivt-tailscale").textContent, /Lee would need Tailscale for this link/);
  assert.ok(![...c.querySelectorAll(".ivt-tailscale button")].some((b) => b.textContent === "Set up invite links"));
  assert.equal(c.querySelector(".ivt-fallback").open, true, "Tailscale sharing, already open");
  assert.ok(!posts(log).some(([, p]) => p === "/api/guests/key" || p === "/api/guests/keys"), "no key asked for");
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
  await type(field, tskey("client-wrong-kind"));
  assert.equal(connect().disabled, true, "only an access token");
  await type(field, tskey("api-expired-9"));
  await click(connect());
  await settle(60);
  assert.match(setup.textContent, /didn't accept that token/);
  await type(field, tskey("api-good-1"));
  await click(connect());
  await settle(60);
  assert.equal(c.querySelector(".ivt-setup"), null, "done");
  assert.deepEqual(
    log.filter(([m, , p]) => m === "POST" && p === "/api/guests/keys").map(([, h, , b]) => [h, b]),
    [
      ["mac-a", { accessToken: tskey("api-expired-9") }],
      ["mac-a", { accessToken: tskey("api-good-1") }],
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

test("default all-access policy offers a reviewed fix before retrying the token", async () => {
  dom.window.localStorage.clear();
  const log = computers({ keyed: false, policyBlock: true });
  const view = await render();
  const c = view.container;
  await settle(40);
  await click(c.querySelector(".ivt-setup-line"));
  const field = c.querySelector('[aria-label="Access token"]');
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(field, tskey("api-good-1"));
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  await click([...c.querySelectorAll(".ivt-setup button")].find((b) => b.textContent === "Connect"));
  assert.match(c.querySelector(".ivt-policy-fix").textContent, /tagged devices/);
  assert.equal(c.querySelector(".ivt-policy-fix a").getAttribute("href"), "https://login.tailscale.com/admin/acls");
  await click([...c.querySelectorAll(".ivt-policy-fix button")][0]);
  assert.equal(c.querySelector(".ivt-setup"), null);
  assert.deepEqual(log.filter(([m, , p]) => m === "POST" && p === "/api/guests/keys").map(([, , , body]) => body), [
    { accessToken: tskey("api-good-1") },
    { accessToken: tskey("api-good-1"), narrowDefaultWildcard: true },
  ]);
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
  await type(field("Client secret"), tskey("client-bad"));
  await click(connect());
  await settle(60);
  assert.match(setup.textContent, /didn't accept the OAuth client/);
  assert.equal(field("Client secret").type, "password");
  await type(field("Client secret"), tskey("client-good"));
  await click(connect());
  await settle(60);
  assert.equal(c.querySelector(".ivt-setup"), null, "done");
  assert.equal(c.querySelector(".ivt-warn[role=status]"), null, "nothing to warn about");
  assert.deepEqual(
    log.filter(([m, , p]) => m === "POST" && p === "/api/guests/keys").map(([, h, , b]) => [h, b]),
    [
      ["mac-a", { clientId: "k123", clientSecret: tskey("client-bad") }],
      ["mac-a", { clientId: "k123", clientSecret: tskey("client-good") }],
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

test("agents & people: their access, joined or not, time left; end one now", async () => {
  const later = Date.now() + 2 * 3600 * 1000 + 60000;
  const log = computers({
    guests: [
      { id: "g1", kind: "guest", name: "Sam", status: "accepted", expiresAt: later, scopes: ["device", "screen", "screen:control", "apps:open"] },
      { id: "g2", kind: "guest", name: "Kim", status: "invited", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "old", kind: "guest", name: "Old", status: "expired", expiresAt: Date.now() - 1000 },
      { id: "me", kind: "device", name: "My iPhone", expiresAt: later },
    ],
  });
  const view = await hub({ peers: [macA, macB], here: [{ id: "x", name: "iPad", kind: "tablet", self: false, activity: "viewing", access: [{ kind: "invited", expiresAt: later }] }] });
  const c = view.container;
  await settle(40);
  // Who's on it now, live, before who may come in.
  assert.deepEqual([...c.querySelectorAll(".ppl-here")].map((r) => r.querySelector(".gs-label").textContent), ["iPadWatching the screen · Guest"]);
  assert.deepEqual(hubRows(c), [
    "Sam | Can control · 2 h 1 min left",
    "Kim | Not opened yet · 2 h 1 min left",
    "My iPhone | This device",
  ]);
  await openRow(c, "Kim");
  assert.equal(c.querySelector(".ppl-sheet .ivt-access .ivt-menu-button").textContent, "Can open files");
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Kim’s access"]'));
  assert.ok(log.some(([m, , p]) => m === "DELETE" && p === "/api/clients/g2"));
  await view.unmount();
});

test("someone who hasn't opened their link: a new one, the old one stops working", async () => {
  const later = Date.now() + 2 * 3600 * 1000;
  const log = computers({
    guests: [
      { id: "g2", kind: "guest", name: "Kim", status: "invited", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "g3", kind: "guest", name: "Sam", status: "accepted", expiresAt: later, scopes: ["device", "files:read"] },
    ],
  });
  const view = await hub({ toast: () => {} });
  const c = view.container;
  await settle(40);
  // Opened already: nothing to send again.
  await openRow(c, "Sam");
  assert.equal(c.querySelector('[aria-label="New invite link for Sam"]'), null);
  await click(c.querySelector('.ppl-sheet [aria-label="Close panel"]'));
  await openRow(c, "Kim");
  assert.equal(c.querySelector('[aria-label="Copy Kim’s link"]'), null, "no link kept from before");
  await click(c.querySelector('[aria-label="New invite link for Kim"]'));
  await settle(40);
  assert.ok(log.some(([m, h, p]) => m === "POST" && h === "mac-a" && p === "/api/guests/g2/link"));
  assert.ok(log.some(([m, , p, b]) => m === "POST" && p === "/api/guests/key" && b.clientIds.join() === "g2"));
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
  await click(c.querySelector('[aria-label="Copy Kim’s link"]'));
  const link = parseGuestLink(new URL(copied).hash);
  assert.equal(new URL(copied).pathname, "/guest");
  assert.deepEqual(link.invites, [{ origin: "https://mac-a.t.ts.net:8443", secret: secret("n") }]);
  assert.equal(link.key, KEY.key);
  await view.unmount();
});

// A Tools agent's new link explains itself (its /agent steps), so it carries
// the runtime's SHA-256 the steps check the download against.
test("a Tools agent's new link carries the runtime it pins", async () => {
  const later = Date.now() + 2 * 3600 * 1000;
  computers({
    guests: [{ id: "g4", kind: "agent", name: "Otter", status: "invited", expiresAt: later, scopes: ["device", "browser:read"], browserTransport: "funnel", policy: { browser: true, preset: "readonly", invite: true } }],
  });
  localStorage.setItem("reach.invite-forms", JSON.stringify({ g4: "tools" }));
  const view = await hub({ toast: () => {} });
  const c = view.container;
  await settle(40);
  await openRow(c, "Otter");
  await click(c.querySelector('[aria-label="New invite link for Otter"]'));
  await settle(40);
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
  await click(c.querySelector('[aria-label="Copy Otter’s link"]'));
  const url = new URL(copied);
  assert.equal(url.pathname, "/agent");
  const params = new URLSearchParams(url.hash.slice(1));
  assert.equal(params.get("t"), "funnel");
  assert.equal(params.get("r"), RUNTIME);
  assert.equal(params.get("i"), `https://mac-a.t.ts.net:8443~${secret("n")}`);
  localStorage.removeItem("reach.invite-forms");
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
  await click(access(c, "Can use files"));
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
  await type(setup.querySelector('[aria-label="Access token"]'), tskey("api-good-1"));
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

// Inviting an agent with Command line (folders, over Tailscale): where agent
// presets aren't offered (a computer that isn't a Mac), the same dialog, then
// one command it runs to join.
const chooseAgent = async (c) => {
  await dom.waitFor(() => c.querySelector('.inv-choices [aria-label="Can edit"]'));
  await settle(40);
};

test("an agent: one computer, a folder, what it may do, then one command to give it", async () => {
  const log = computers();
  const view = await render({ peers: [macA, macB], initialKind: "agent" });
  const c = view.container;
  await settle(40);
  await chooseAgent(c);
  assert.equal(c.querySelector(".ivt-name").placeholder, "Name the agent");
  assert.match(c.querySelector(".ivt-name").value, /^[A-Z][a-z]+ [A-Z][a-z]+$/, "a fresh silly name to start");
  await name(c, "Claude on my server");
  assert.equal(chosen(c), "Can edit");
  assert.equal(c.querySelector(".ivt-summary").textContent, "Claude on my server can read and edit the folders you choose on Mac A for 1 week.");
  assert.equal(inviteButton(c).disabled, true, "a folder first");
  // One computer: picking Mac B replaces Mac A.
  await click(menu(c, "Computer"));
  await click(item(c, "Mac B"));
  assert.equal(menu(c, "Computer").textContent, "Mac B");
  await settle(40);
  await click(c.querySelector('[aria-label="Share Projects"]'));
  assert.match(access(c, "Can run commands").textContent, /Commands run as you, so they can reach beyond those folders/);
  await click(access(c, "Can run commands"));
  await click(menu(c, "Expires"));
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
  assert.match(card.textContent, /Can run commands · 30 days/);
  assert.match(card.textContent, /Needs Node\.js 22 or later, nothing else/);
  // A line and a link (Oct 12): the link explains itself and pins the
  // runtime its computer named (r=), as an invite from Agents does.
  const link = c.querySelector('[aria-label="Link for the agent"]').value;
  const agentLink = new URL(link);
  assert.equal(agentLink.origin, "https://mac-b.t.ts.net");
  assert.equal(agentLink.pathname, "/agent", "never a link a browser would use");
  assert.deepEqual(parseGuestLink(agentLink.hash), { ...KEY, invites: [{ origin: macB.url, secret: secret("z") }] });
  assert.equal(new URLSearchParams(agentLink.hash.slice(1)).get("r"), RUNTIME);
  let copied = "";
  dom.window.navigator.clipboard = { writeText: async (t) => (copied = t) };
  await click([...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Copy"));
  assert.equal(copied, `Connect to my Mac with Reach: open this link and follow its steps, then I approve the code it shows. Keep the link to yourself.\n\n${link}`);
  // Another: the form again, with a new name.
  await click([...card.querySelectorAll("button")].find((b) => b.textContent === "Invite another agent"));
  assert.equal(c.querySelector(".inv-form").hidden, false);
  assert.notEqual(c.querySelector(".ivt-name").value, "Claude on my server");
  await view.unmount();
});

// Security audit M5: a key from another computer couldn't tell when this
// agent's access ends there, so its device would outlive it. None is made.
test("an agent on a computer without the setup: no key from a linked one, a command for your tailnet", async () => {
  const log = computers({ keyed: ["mac-a"] });
  const view = await render({ peers: [macA, macB], initialKind: "agent" });
  const c = view.container;
  await settle(40);
  await chooseAgent(c);
  await name(c, "Codex");
  await click(menu(c, "Computer"));
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
    ],
  );
  const link = c.querySelector('[aria-label="Link for the agent"]').value;
  assert.equal(parseGuestLink(new URL(link).hash).key || "", "");
  await view.unmount();
});

test("agent invitations show waiting, approved, denied, joined and expired connection states", async () => {
  const later = Date.now() + 7 * 86400 * 1000;
  const log = computers({
    guests: [
      { id: "a1", kind: "agent", name: "Builder", policy: { invite: true }, status: "accepted", expiresAt: later, scopes: ["device", "files:read", "files:write", "exec"] },
      { id: "a2", kind: "agent", name: "Reader", policy: { invite: true }, status: "invited", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "a3", kind: "agent", name: "Late", policy: { invite: true }, status: "expired", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "a4", kind: "agent", name: "Waiting", policy: { invite: true }, status: "pending", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "a5", kind: "agent", name: "Allowed", policy: { invite: true }, status: "approved", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "a6", kind: "agent", name: "Denied", policy: { invite: true }, status: "denied", expiresAt: later, scopes: ["device", "files:read"] },
      { id: "cli", kind: "agent", name: "Policy agent", policy: { profile: "work" }, expiresAt: later, scopes: ["device", "files:read"] },
      // Always: stored as ten years, shown as what it is (not "87599 h").
      { id: "a7", kind: "agent", name: "Keeper", policy: { invite: true, browser: true, standing: true }, status: "invited", expiresAt: Date.now() + 10 * 365 * 86400 * 1000, scopes: ["device", "files:read"] },
    ],
  });
  const view = await hub();
  const c = view.container;
  await settle(40);
  // What needs you comes first.
  assert.deepEqual(hubRows(c), [
    "Waiting | Waiting for your approval",
    "Builder | Can run commands · 7 days left",
    "Reader | Not joined yet · 7 days left",
    "Late | Request expired",
    "Allowed | Approved · connecting",
    "Denied | Denied",
    "Policy agent | Read files · 7 days left",
    "Keeper | Not joined yet · Always",
  ]);
  await openRow(c, "Keeper");
  const ends = [...c.querySelectorAll(".ppl-sheet .gs-row")].find((r) => r.querySelector(".gs-label")?.textContent === "Ends");
  assert.equal(ends?.querySelector(".gs-value")?.textContent.trim(), "After a week unused");
  await click(c.querySelector('.ppl-sheet [aria-label="Close panel"]'));
  await settle(20);
  await openRow(c, "Builder");
  assert.equal(c.querySelector(".ppl-sheet .ivt-access .ivt-menu-button").textContent, "Can run commands");
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Builder’s access"]'));
  assert.ok(log.some(([m, , p]) => m === "DELETE" && p === "/api/clients/a1"));
  await view.unmount();
});

test("an agent without invite links: still a command (for a machine on your tailnet); setup adds its key", async () => {
  dom.window.localStorage.clear();
  const log = computers({ keyed: false });
  const view = await render({ initialKind: "agent" });
  const c = view.container;
  await settle(40);
  await chooseAgent(c);
  await name(c, "Codex");
  await click(c.querySelector('[aria-label="Share Projects"]'));
  await click(inviteButton(c));
  await settle(80);
  assert.deepEqual(posts(log).map(([h, p]) => p), ["/api/agents/invitations"]);
  const card = c.querySelector('[aria-label="Agent invitation"]');
  assert.match(card.textContent, /Without invite links, its machine needs Tailscale on your tailnet/);
  assert.equal(parseGuestLink(new URL(c.querySelector('[aria-label="Link for the agent"]').value).hash).key, "");
  await click([...card.querySelectorAll(".ivt-tailscale > button")].find((b) => b.textContent === "Set up invite links"));
  const setup = c.querySelector(".ivt-setup");
  const type = async (el, v) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
  };
  await type(setup.querySelector('[aria-label="Access token"]'), tskey("api-good-1"));
  await click([...setup.querySelectorAll("button")].find((b) => b.textContent === "Connect"));
  await settle(120);
  const keyCall = log.find(([m, , p]) => m === "POST" && p === "/api/guests/key");
  assert.deepEqual(keyCall[3].clientIds, ["agent-mac-a"]);
  assert.ok(keyCall[3].ttlSeconds > 7 * 86400 - 100 && keyCall[3].ttlSeconds <= 7 * 86400);
  assert.ok(keyCall[3].keySeconds > 880 && keyCall[3].keySeconds <= 900);
  const fixed = new URL(c.querySelector('[aria-label="Link for the agent"]').value);
  assert.equal(fixed.pathname, "/agent");
  assert.deepEqual(parseGuestLink(fixed.hash), { ...KEY, invites: [{ origin: macA.url, secret: secret("z") }] }, "the same invitation, now with a key");
  assert.match(c.querySelector('[aria-label="Agent invitation"]').textContent, /nothing else/);
  await view.unmount();
  dom.window.localStorage.clear();
});

test("clean to the end (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});
