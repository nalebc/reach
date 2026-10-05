import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

// Inviting someone: one sentence ("Let Sam watch your screen on Mac A for
// 4 hours"), tap its words to choose. The requests each computer receives
// and the link that comes out are checked exactly.
let dom, React, InviteSheet, parseGuestLink;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ InviteSheet } = await dom.load("/src/InviteSheet.tsx"));
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

function computers({ keyed = true, failOn = "", guests = [] } = {}) {
  const log = [];
  let n = 0;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const host = u.hostname.split(".")[0];
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push([init.method || "GET", host, u.pathname, body]);
    const reply = (status, value) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/api/guests/keys") return reply(200, { configured: keyed });
    if (u.pathname === "/api/clients") return reply(200, { current: "me", clients: guests });
    if (u.pathname === "/api/device") return reply(200, device(host === "mac-a" ? "Mac A" : "Mac B", host));
    if (u.pathname === "/api/apps")
      return reply(200, [
        { id: "/Applications/Figma.app", name: "Figma" },
        { id: "/Applications/Notes.app", name: "Notes" },
      ]);
    if (u.pathname === "/api/guests" && init.method === "POST") {
      if (host === failOn) return reply(400, { error: "Choose a guest name, what they may use, and a duration from 1 minute to 24 hours." });
      n++;
      return reply(201, {
        invitation: secret(String.fromCharCode(96 + n)),
        clientId: `client-${host}`,
        expiresAt: Date.now() + 3600000,
        scopes: [],
        ...(body.key ? { key: "tskey-auth-kTEST123456-abcdef", hostname: "rg-ab12-k3m9x2p7qa" } : {}),
      });
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
const button = (root, text) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text || b.textContent.includes(text));
const word = (root, i) => root.querySelectorAll(".invite-word")[i];
const sentence = (root) => root.querySelector(".invite-sentence").textContent.replace(/\s+/g, " ").trim();
const render = (props) =>
  dom.render(React.createElement(InviteSheet, { peer: macA, device: device("Mac A", "mac-a"), peers: [macA], ...props }));
const posts = (log) => log.filter(([m, , p]) => m === "POST" && p === "/api/guests");

test("the sentence reads as you choose; the link is made only when complete", async () => {
  const log = computers();
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  const create = () => button(c, "Create link");
  assert.equal(create().disabled, true);
  assert.match(c.textContent, /Who is it for\?/);
  await typeInto(c.querySelector(".invite-name"), "Sam");
  assert.equal(sentence(c).replace(/^Let\s*/, "Let Sam "), "Let Sam do something on Mac A for 4 hours.");
  assert.match(c.textContent, /Choose what they can do\./);
  // What: files on both computers, editable; watch and control the screen; terminal.
  await click(word(c, 0));
  await click(button(c, "Files"));
  await click(word(c, 1)); // where
  await click(button(c, "Mac B"));
  await click(word(c, 0));
  assert.match(c.textContent, /Choose a folder on each computer\./);
  for (const chip of [...c.querySelectorAll(".invite-detail-row .invite-chip")]) await click(chip);
  await click(button(c, "Can edit"));
  await click(button(c, "Screen"));
  await click(button(c, "Watch and control"));
  await click(button(c, "Terminal"));
  assert.match(sentence(c), /edit Projects and Projects, control your screen and use a terminal on Mac A and Mac B for 4 hours\./);
  await click(word(c, 2)); // how long
  await click(button(c, "1 day"));
  assert.equal(create().disabled, false);
  await click(create());
  await settle(80);
  const common = { name: "Sam", ttlSeconds: 86400, roots: [0], write: true, screen: "control", terminal: true, agents: false };
  assert.deepEqual(posts(log), [
    ["POST", "mac-a", "/api/guests", { ...common, key: true }],
    ["POST", "mac-b", "/api/guests", common],
  ]);
  const link = c.querySelector(".invite-link").textContent;
  assert.match(link, /^https:\/\/mac-a\.t\.ts\.net\/guest#/);
  assert.deepEqual(parseGuestLink(new URL(link).hash), {
    key: "tskey-auth-kTEST123456-abcdef",
    hostname: "rg-ab12-k3m9x2p7qa",
    invites: [
      { origin: macA.url, secret: secret("a") },
      { origin: macB.url, secret: secret("b") },
    ],
  });
  assert.match(c.textContent, /Sam’s link is ready/);
  assert.match(c.textContent, /Nothing to install for them/);
  await view.unmount();
});

test("chosen apps are watch-only; Everything sends just that", async () => {
  let log = computers();
  let view = await render();
  let c = view.container;
  await typeInto(c.querySelector(".invite-name"), "Kim");
  await click(word(c, 0));
  await click(button(c, "Apps"));
  await click(button(c, "Only some"));
  await settle(40);
  assert.equal(button(c, "Create link").disabled, true, "pick at least one app");
  await click(button(c, "Figma"));
  assert.match(sentence(c), /watch Figma/);
  await click(button(c, "Create link"));
  await settle(80);
  assert.deepEqual(posts(log).map(([, , , b]) => b), [
    { name: "Kim", ttlSeconds: 14400, roots: [], write: false, screen: false, apps: ["/Applications/Figma.app"], terminal: false, agents: false, key: true },
  ]);
  await view.unmount();

  log = computers();
  view = await render();
  c = view.container;
  await typeInto(c.querySelector(".invite-name"), "Ali");
  await click(word(c, 0));
  await click(button(c, "Everything"));
  assert.match(sentence(c), /use everything you can/);
  await click(word(c, 1));
  await click(button(c, "1 hour"));
  await click(button(c, "Create link"));
  await settle(80);
  assert.deepEqual(posts(log).map(([, , , b]) => b), [{ name: "Ali", ttlSeconds: 3600, full: true, key: true }]);
  await view.unmount();
});

test("all or nothing: if one computer refuses, the others' invitations are undone", async () => {
  const log = computers({ failOn: "mac-b" });
  const view = await render({ peers: [macA, macB] });
  const c = view.container;
  await typeInto(c.querySelector(".invite-name"), "Sam");
  await click(word(c, 0));
  await click(button(c, "Terminal"));
  await click(word(c, 1));
  await click(button(c, "Mac B"));
  await click(button(c, "Create link"));
  await settle(80);
  assert.deepEqual(
    log.filter(([, , p]) => p === "/api/guests" || p.startsWith("/api/clients/")).filter(([m]) => m !== "GET").map(([m, h, p]) => `${m} ${h} ${p}`),
    ["POST mac-a /api/guests", "POST mac-b /api/guests", "DELETE mac-a /api/clients/client-mac-a"],
  );
  assert.equal(c.querySelector(".invite-link"), null);
  assert.match(c.querySelector(".invite-error").textContent, /Choose a guest name/);
  await view.unmount();
});

test("without invite keys: Tailscale sharing first, then the link", async () => {
  computers({ keyed: false });
  const view = await render();
  const c = view.container;
  await typeInto(c.querySelector(".invite-name"), "Lee");
  await click(word(c, 0));
  await click(button(c, "AI sessions"));
  await click(button(c, "Create link"));
  await settle(80);
  assert.match(c.textContent, /needs Tailscale to open it/);
  assert.equal(c.querySelector(".invite-link"), null, "no link until they can reach it");
  const already = [...c.querySelectorAll(".invite-tailscale label")].find((l) => /already on my Tailscale/.test(l.textContent));
  await click(already.querySelector("input"));
  const link = c.querySelector(".invite-link").textContent;
  assert.equal(parseGuestLink(new URL(link).hash).key, "");
  await view.unmount();
});

test("active invites: who joined, time left, end one now", async () => {
  const later = Date.now() + 2 * 3600 * 1000 + 60000;
  const log = computers({
    guests: [
      { id: "g1", kind: "guest", name: "Sam", status: "accepted", expiresAt: later },
      { id: "g2", kind: "guest", name: "Kim", status: "invited", expiresAt: later },
      { id: "old", kind: "guest", name: "Old", status: "expired", expiresAt: Date.now() - 1000 },
      { id: "me", kind: "device", name: "My iPhone", expiresAt: later },
    ],
  });
  const view = await render();
  const c = view.container;
  await settle(40);
  const rows = [...c.querySelectorAll(".invite-guest")].map((r) => r.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(rows, ["SamJoined · 2 h 1 min left", "KimNot opened yet · 2 h 1 min left"]);
  dom.window.confirm = globalThis.confirm = () => true;
  await click(c.querySelector('[aria-label="End Kim’s access"]'));
  assert.ok(log.some(([m, , p]) => m === "DELETE" && p === "/api/clients/g2"));
  await view.unmount();
});

test("rendering stayed clean (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});
