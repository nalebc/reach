import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
import { tskey } from "./helpers/fake-keys.mjs";

// The owner's invite, as ChatGPT would: how the agent connects (three tiles),
// what it may do (a list with a check; Apps and Files ask which), its name
// and how long as quiet rows with defaults, then Create invite. Choosing
// never sends anything. The message the agent reads is a line and a link
// (Oct 12): what it may do and the rules come when it connects.
let dom, React, BrowserInvite;
const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
const device = { name: "My Mac", roots: [{ id: 0, name: "Project", path: "/Users/me/Project" }] };
const secret = "b".repeat(43);
const presetApps = [
  { id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome", running: true, protected: false },
  { id: "/System/Applications/Notes.app", name: "Notes", bundleId: "com.apple.Notes", running: false, protected: false },
  { id: "/System/Applications/Utilities/Terminal.app", name: "Terminal", bundleId: "com.apple.Terminal", running: true, protected: false, runsCommands: true },
  { id: "/Applications/1Password.app", name: "1Password", bundleId: "com.1password.1password", running: false, protected: true, reason: "Passwords, security prompts and Reach's lifeline are always protected." },
  { id: "/System/Applications/Messages.app", name: "Messages", bundleId: "com.apple.MobileSMS", running: true, protected: false },
  { id: "/System/Applications/Mail.app", name: "Mail", bundleId: "com.apple.mail", running: false, protected: false },
];
before(async () => {
  dom = await startDom();
  React = dom.React;
  ({ default: BrowserInvite } = await dom.load("/src/BrowserInvite.tsx"));
});
after(async () => dom?.close());
const views = new Set();
const render = async (element) => { const view = await dom.render(element); views.add(view); return view; };
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });
const click = async (element) => { assert.ok(element, "element exists"); element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await settle(40); };
const button = (c, label) => [...c.querySelectorAll("button")].find((item) => item.textContent.trim() === label || item.getAttribute("aria-label") === label);
// A row's menu: open it, see its options, pick one.
const rowMenu = (c, label) => [...c.querySelectorAll(".ivt-row")].find((r) => r.querySelector(".ivt-setting-label")?.textContent.trim() === label)?.querySelector(".ivt-menu-button");
const openMenu = async (c, label) => {
  const menu = rowMenu(c, label);
  if (menu?.getAttribute("aria-expanded") !== "true") await click(menu);
  return c.querySelector(".ivt-menu-list");
};
const closeMenu = async (c, label) => {
  const menu = rowMenu(c, label);
  if (menu?.getAttribute("aria-expanded") === "true") await click(menu);
};
const items = (list) => [...list.querySelectorAll(".ivt-item")];
const item = (list, label) => items(list).find((b) => b.querySelector("strong").textContent === label);
const pick = async (c, row, label) => click(item(await openMenu(c, row), label));
const offered = async (c, row, label) => {
  const found = !!item(await openMenu(c, row), label);
  await closeMenu(c, row);
  return found;
};
const presets = (c) => [...c.querySelectorAll('[aria-label="Access preset"] [role="radio"]')];
const preset = (c, title) => presets(c).find((b) => b.getAttribute("aria-label") === title);
const choose = (c, title) => click(preset(c, title));
// How it connects: Command (Tools), Connector (Hosted) or Web link (Web page).
const place = (c, label) => [...c.querySelectorAll('[aria-label="How the agent connects"] [role="radio"]')].find((b) => b.textContent.trim() === label);
const create = (c) => click(button(c, "Create invite"));
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function mock({ desktopAvailable = true, protectedFilesSupported = true, desktopReason, filesUnsupportedReason, maxFunnelSeconds = 86400, standingAllowed = false, toolsStandingAllowed = false, runtime = "ab".repeat(32) } = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || "GET", route, body]);
    if (route === "/api/agents/browser-options") return reply({ terminals: [], desktopAvailable, protectedFilesSupported, desktopReason, filesUnsupportedReason, presetApps, screenAvailable: true, appAccessAvailable: false, apps: [], ...(maxFunnelSeconds ? { maxFunnelSeconds } : {}), ...(standingAllowed ? { standingAllowed } : {}), ...(toolsStandingAllowed ? { toolsStandingAllowed } : {}) });
    if (route === "/api/agents/browser-invitations")
      return reply({ invitation: secret, url: `https://mac.tail.ts.net/agent-browser#invite=${secret}`, clientId: "muse", preset: body.preset, expiresAt: Date.now() + 3600000, joinBy: Date.now() + 900000, scopes: [], ...(runtime ? { runtime } : {}) });
    if (route === "/api/files") return reply({ items: [] });
    if (route === "/api/guests/key") return reply({ key: tskey("auth-k1"), hostname: "rf-ab12-agent" });
    if (route.startsWith("/api/clients/") && init.method === "DELETE") return reply({ ok: true });
    return reply({ error: "Unexpected request" }, 404);
  };
  return calls;
}
// Tools is the default; these page tests pick Page first unless told not to.
const open = async ({ connect = "page", keyPeer = peer, onSetup = () => {} } = {}) => {
  let made;
  const view = await render(React.createElement(BrowserInvite, { peer, device, keyPeer, onSetup, onCreated: (...args) => { made = args; } }));
  const c = view.container;
  await dom.waitFor(() => preset(c, "Full control"));
  await settle(40);
  if (connect === "page") await click(place(c, "Web link"));
  return { c, made: () => made };
};
const issued = (calls) => calls.find(([, route]) => route === "/api/agents/browser-invitations")?.[2];
const message = (c) => c.querySelector('textarea[aria-label="AI browser invitation message"]').value;
// The whole message for a page agent: a line, then its link.
const PAGE = "Open this link in your browser, then I approve the code it shows. Keep the link: it brings this browser back.";
const pageMessage = `${PAGE}\n\nhttps://mac.tail.ts.net/agent-browser#invite=${secret}`;

test("Full control: chosen with a check, made with Create invite, nothing else to fill", async () => {
  const calls = mock();
  const { c, made } = await open();
  const name = c.querySelector('[aria-label="AI browser name"]').value;
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.match(c.textContent, /What can it do\?/);
  assert.equal(button(c, "Create invite").disabled, true, "a choice first");
  assert.deepEqual(presets(c).map((b) => b.getAttribute("aria-label")), ["Full control", "Apps", "Files", "Read only"]);
  assert.ok(presets(c).every((b) => b.getAttribute("aria-checked") === "false"), "nothing chosen for you");
  assert.match(c.textContent, /Every app, file and command\./);
  await choose(c, "Full control");
  assert.equal(preset(c, "Full control").getAttribute("aria-checked"), "true");
  assert.equal(issued(calls), undefined, "choosing sends nothing");
  assert.match(c.textContent, /Full control can access passwords/);
  await create(c);
  await dom.waitFor(() => issued(calls));
  assert.deepEqual(issued(calls), { name, transport: "funnel", ttlSeconds: 1800, preset: "full", fullControlVersion: 1 });
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  await dom.waitFor(() => dom.document.activeElement.textContent === `${name} is invited`);
  assert.equal(dom.document.activeElement.textContent, `${name} is invited`, "focus moves to the result after creation");
  const text = message(c);
  // A line and the link: what it may do and the rules come when it
  // connects (server/agent-guide.mjs), from its access then.
  assert.equal(text, pageMessage);
  assert.doesNotMatch(text, /full control|Ask me before|stay out/);
  assert.equal(text.split("\n").at(-1), `https://mac.tail.ts.net/agent-browser#invite=${secret}`);
  assert.equal(made()[1], text.split("\n").at(-1));
  assert.doesNotMatch(text, /approval|view only/i);
});

test("Apps: pick apps with real names; protected apps are shown locked with their reason; terminals carry a caution", async () => {
  const calls = mock();
  const { c } = await open();
  await choose(c, "Apps");
  assert.equal(button(c, "Create invite").disabled, true);
  assert.match(c.textContent, /Pick at least one app/);
  assert.equal(c.querySelector('[aria-label="Allow 1Password"]'), null, "always protected apps have no switch");
  assert.match(c.querySelector(".ag-locked").textContent, /1Password.*always protected/);
  await click(c.querySelector('[aria-label="Allow Google Chrome"]'));
  assert.match(c.textContent, /Runs commands as you/, "Terminal is offered with a caution");
  assert.match(c.textContent, /Google Chrome, nothing else for 30 minutes/);
  await pick(c, "Expires", "1 hour");
  await create(c);
  await dom.waitFor(() => issued(calls));
  assert.deepEqual(issued(calls), { name: issued(calls).name, transport: "funnel", ttlSeconds: 3600, preset: "apps", apps: [{ id: "/Applications/Google Chrome.app" }] });
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.equal(message(c), pageMessage, "the same short message for every preset");
  assert.doesNotMatch(message(c), /Chrome/);
});

test("Files: folders are required, editing is a switch; Read only can hide apps with one tap", async () => {
  const calls = mock();
  const { c } = await open();
  await choose(c, "Files");
  assert.match(c.textContent, /Pick at least one folder/);
  await click(c.querySelector('[aria-label="Share Project"]'));
  assert.match(c.textContent, /Project, read only for 30 minutes/);
  await click(c.querySelector('[aria-label="Can edit files"]'));
  assert.match(c.textContent, /Project, read and edit/);
  assert.match(c.textContent, /Changes files directly/);
  await create(c);
  await dom.waitFor(() => issued(calls));
  assert.deepEqual(issued(calls), { name: issued(calls).name, transport: "funnel", ttlSeconds: 1800, preset: "files", folders: [{ root: 0, path: "" }], write: true });
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.equal(message(c), pageMessage);
  assert.doesNotMatch(message(c), /\/Users\/me/, "no folder paths in the message");
  // Another invitation: Read only, hiding the apps where codes arrive.
  await click(button(c, "Invite another agent"));
  assert.equal(button(c, "Hide Messages and Mail"), undefined, "hiding is Read only's");
  await choose(c, "Read only");
  await click(button(c, "Hide Messages and Mail"));
  await create(c);
  await dom.waitFor(() => calls.filter(([, route]) => route === "/api/agents/browser-invitations").length === 2);
  const second = calls.filter(([, route]) => route === "/api/agents/browser-invitations")[1][2];
  assert.deepEqual(second, { name: second.name, transport: "funnel", ttlSeconds: 1800, preset: "readonly", hidden: [{ id: "/System/Applications/Messages.app" }, { id: "/System/Applications/Mail.app" }] });
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.equal(message(c), pageMessage);
  assert.doesNotMatch(message(c), /Messages|Mail/);
});

test("a day of access is offered only when the server allows it", async () => {
  const calls = mock();
  const { c } = await open();
  assert.match((await openMenu(c, "Expires")).textContent, /A day is long for an agent on your Mac/);
  await pick(c, "Expires", "24 hours");
  await choose(c, "Full control");
  await create(c);
  await dom.waitFor(() => issued(calls));
  assert.equal(issued(calls).ttlSeconds, 86400);
  mock({ maxFunnelSeconds: 0 });
  const older = await open();
  assert.equal(await offered(older.c, "Expires", "24 hours"), false, "an older server never sees a choice it would refuse");
});

test("Always sends no end time and tells the owner and the agent it lasts until ended", async () => {
  const calls = mock({ standingAllowed: true });
  const { c } = await open();
  assert.match((await openMenu(c, "Expires")).textContent, /Until you end it\. It comes back through the same link, with no new invite/);
  await pick(c, "Expires", "Always");
  await choose(c, "Read only");
  await create(c);
  await dom.waitFor(() => issued(calls));
  assert.equal(issued(calls).standing, true);
  assert.equal(issued(calls).ttlSeconds, undefined, "Always has no duration to send");
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.match(c.querySelector(".ag-done-for").textContent, /Until you end it/);
  assert.doesNotMatch(c.textContent, /Join by/);
  // The agent hears it lasts until ended when it connects (its guide).
  assert.equal(message(c), pageMessage);
  assert.doesNotMatch(message(c), /temporary/);
  mock();
  const older = await open();
  assert.equal(await offered(older.c, "Expires", "Always"), false, "an older server never sees a choice it would refuse");
});

test("without the Mac's screen helpers, only Files can be created, and the form says why", async () => {
  mock({ desktopAvailable: false });
  const { c } = await open();
  await dom.waitFor(() => preset(c, "Apps").disabled);
  for (const title of ["Full control", "Apps", "Read only"]) assert.equal(preset(c, title).disabled, true, title);
  assert.equal(preset(c, "Files").disabled, false);
  assert.match(c.textContent, /Screen presets need this Mac's Screen Recording and Accessibility/);
});

test("Tools: the same preset, one command through the public link (the private address first), and Reach's tools for the agent", async () => {
  const calls = mock({ standingAllowed: true });
  const { c, made } = await open();
  assert.ok(await offered(c, "Expires", "Always"), "a page agent may stay");
  await click(place(c, "Command"));
  assert.match(c.textContent, /It runs one command in its terminal\./);
  assert.equal(await offered(c, "Expires", "Always"), true, "Always over the public link too");
  await choose(c, "Full control");
  await create(c);
  await dom.waitFor(() => made());
  assert.equal(issued(calls).transport, "funnel", "through the public link, even where invite keys exist");
  assert.equal(issued(calls).preset, "full");
  assert.equal(calls.find(([, route]) => route === "/api/guests/key"), undefined, "no Tailscale key");
  const text = message(c);
  // A line and the link, which explains itself (its steps at /agent); the
  // private address and the runtime's SHA-256 ride in its fragment.
  assert.match(text, /^Connect to my Mac with Reach: open this link and follow its steps, then I approve the code it shows\. Keep the link to yourself\.\n\nhttps:\/\/mac\.tail\.ts\.net\/agent#i=https%3A%2F%2Fmac\.tail\.ts\.net%3A8443%7Eb{43}&t=funnel&r=(?:ab){32}$/, text);
  assert.equal(made()[1], text.split("\n").at(-1), "the link the owner shares");
  assert.doesNotMatch(text, /tskey-auth|curl|node |PowerShell|full control|Ask me before/);
});

// Always over Tools (audit conditions for Always): offered when this Mac
// makes invite keys; the Mac, not the phone, decides how long the device stays.
test("Tools: Always is offered and sent with no end time, through the public link", async () => {
  const calls = mock({ standingAllowed: true, toolsStandingAllowed: true });
  const { c, made } = await open();
  await click(place(c, "Command"));
  const expires = await openMenu(c, "Expires");
  assert.match(expires.textContent, /or a week unused/);
  assert.match(expires.textContent, /a copy used elsewhere ends the access/);
  await pick(c, "Expires", "Always");
  await choose(c, "Read only");
  await create(c);
  await dom.waitFor(() => made());
  assert.equal(issued(calls).transport, "funnel");
  assert.equal(issued(calls).standing, true);
  assert.equal(issued(calls).ttlSeconds, undefined);
  assert.equal(calls.find(([, route]) => route === "/api/guests/key"), undefined, "no Tailscale key");
});

// The fast way first: a command (Tools, through the public link), so no
// invite-link setup is ever asked for here, and no second kind of command.
test("Command (Tools) is the default, and asks for no invite-link setup", async () => {
  mock({ standingAllowed: true });
  let setup = 0;
  const { c } = await open({ connect: "default", keyPeer: null, onSetup: () => setup++ });
  assert.equal(place(c, "Command").getAttribute("aria-checked"), "true");
  assert.deepEqual([...c.querySelectorAll('[aria-label="How the agent connects"] [role="radio"]')].map((b) => b.textContent.trim()), ["Command", "Connector", "Web link"]);
  assert.equal(rowMenu(c, "Connects"), undefined, "no Command line row on a Mac");
  assert.doesNotMatch(c.textContent, /Command line|Invite with folder access/);
  assert.equal(button(c, "Set up invite links"), undefined);
  await click(place(c, "Web link"));
  assert.match(c.textContent, /It opens a link in its browser and sees your screen/);
  assert.match((await openMenu(c, "Expires")).textContent, /It comes back through the same link/);
  assert.equal(setup, 0);
});

// No invite links on this Mac: Tools goes through the public link, from any
// terminal, with no Tailscale key (scripts/agent-funnel.mjs).
test("Tools without invite links: one command through the public link, no key asked", async () => {
  const calls = mock({ standingAllowed: true });
  const { c, made } = await open({ connect: "default", keyPeer: null });
  await choose(c, "Read only");
  await create(c);
  await dom.waitFor(() => made());
  assert.equal(issued(calls).transport, "funnel");
  assert.equal(calls.find(([, route]) => route === "/api/guests/key"), undefined, "no Tailscale key");
  const text = message(c);
  assert.match(text, /^Connect to my Mac with Reach: open this link and follow its steps, then I approve the code it shows\. Keep the link to yourself\.\n\nhttps:\/\/mac\.tail\.ts\.net\/agent#i=\S+&t=funnel&r=(?:ab){32}$/);
  assert.doesNotMatch(text, /No Tailscale invite key|PowerShell/, "one message for macOS and Windows agents alike");
});

// A computer that names no runtime gets no Tools link: its steps couldn't
// check the download (connections audit, Oct 10). The invitation is taken back.
test("Tools on a computer that names no runtime: no link, the invitation taken back", async () => {
  const calls = mock({ runtime: "" });
  const { c, made } = await open({ connect: "default" });
  await choose(c, "Full control");
  await create(c);
  await dom.waitFor(() => c.querySelector(".ag-error"));
  assert.match(c.querySelector(".ag-error").textContent, /Update Reach on that computer to invite agents from it/);
  assert.equal(made(), undefined);
  assert.ok(calls.some(([method, route]) => method === "DELETE" && route === "/api/clients/muse"));
  assert.equal(c.querySelector('[aria-label="AI browser invitation message"]'), null);
});

// The computer's own word, never "Mac" off a Mac (owner rule: Mac and
// Windows the same).
test("a Windows PC is called a Windows PC in the message", async () => {
  mock();
  const windows = { ...peer, platform: "win32" };
  let made;
  const view = await render(React.createElement(BrowserInvite, { peer: windows, device: { ...device, platform: "win32" }, keyPeer: null, onSetup: () => {}, onCreated: (...args) => { made = args; } }));
  const c = view.container;
  await dom.waitFor(() => preset(c, "Full control"));
  await settle(40);
  assert.ok(presets(c).every(p => !p.disabled), "all four presets are offered when the PC supports them");
  await choose(c, "Full control");
  assert.doesNotMatch(c.textContent, /within macOS permissions/);
  await create(c);
  await dom.waitFor(() => made);
  assert.match(message(c), /^Connect to my Windows PC with Reach: open this link and follow its steps/);
  assert.doesNotMatch(message(c), /\bMac\b/);
});

test("a Windows PC that cannot prepare its helpers names the reasons on the invitation form", async () => {
  mock({ desktopAvailable: false, protectedFilesSupported: false,
    desktopReason: "Reach could not prepare screen access on this PC.",
    filesUnsupportedReason: "This PC could not prepare protected file access." });
  const view = await render(React.createElement(BrowserInvite, {
    peer: { ...peer, platform: "win32" }, device: { ...device, platform: "win32" },
    keyPeer: null, onSetup: () => {}, onCreated: () => {},
  }));
  const c = view.container;
  await dom.waitFor(() => presets(c).length === 4 && presets(c).every(p => p.disabled));
  assert.match(c.textContent, /could not prepare screen access/);
  assert.match(c.textContent, /could not prepare protected file access/);
  assert.doesNotMatch(c.textContent, /requires macOS|require macOS/);
});

test("the three messages: a line each, the link after a blank line, short", async () => {
  const { agentInviteMessage } = await dom.load("/src/BrowserInvite.tsx");
  const link = "https://mac.tail.ts.net/agent#i=x&t=funnel&r=" + "ab".repeat(32);
  assert.equal(agentInviteMessage("tools", link, "Mac"), `Connect to my Mac with Reach: open this link and follow its steps, then I approve the code it shows. Keep the link to yourself.\n\n${link}`);
  assert.equal(agentInviteMessage("hosted", "https://mac.tail.ts.net/mcp/x", "Mac"), "Add this as a custom MCP connector, then I approve the code it shows. Keep the address to yourself.\n\nhttps://mac.tail.ts.net/mcp/x");
  assert.equal(agentInviteMessage("page", "https://mac.tail.ts.net/agent-browser#invite=x", "Mac"), `${PAGE}\n\nhttps://mac.tail.ts.net/agent-browser#invite=x`);
  for (const kind of ["tools", "hosted", "page"])
    for (const word of ["Mac", "Windows PC", "computer"]) {
      const text = agentInviteMessage(kind, "LINK", word);
      assert.ok(text.endsWith("\n\nLINK"));
      assert.ok(text.length - "LINK".length < 400, `${kind}: ${text.length}`);
      assert.equal(text.split("\n").length, 3, "a line, a blank line, the link");
    }
  assert.match(agentInviteMessage("tools", "LINK", "computer"), /^Connect to my computer with Reach/);
});

test("the invite form renders without React warnings", () => assert.deepEqual(dom.errors, []));
