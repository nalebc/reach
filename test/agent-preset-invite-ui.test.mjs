import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The owner's invite, as ChatGPT would: how the agent connects (three tiles),
// what it may do (a list with a check; Apps and Files ask which), its name
// and how long as quiet rows with defaults, then Create invite. Choosing
// never sends anything. The message the agent reads describes the issued
// invitation and what stays closed.
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
function mock({ desktopAvailable = true, maxFunnelSeconds = 86400, standingAllowed = false, toolsStandingAllowed = false } = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || "GET", route, body]);
    if (route === "/api/agents/browser-options") return reply({ terminals: [], desktopAvailable, presetApps, screenAvailable: true, appAccessAvailable: false, apps: [], ...(maxFunnelSeconds ? { maxFunnelSeconds } : {}), ...(standingAllowed ? { standingAllowed } : {}), ...(toolsStandingAllowed ? { toolsStandingAllowed } : {}) });
    if (route === "/api/agents/browser-invitations")
      return reply({ invitation: secret, url: `https://mac.tail.ts.net/agent-browser#invite=${secret}`, clientId: "muse", preset: body.preset, expiresAt: Date.now() + 3600000, joinBy: Date.now() + 900000, scopes: [], runtime: "ab".repeat(32) });
    if (route === "/api/files") return reply({ items: [] });
    if (route === "/api/guests/key") return reply({ key: "tskey-auth-k1", hostname: "rf-ab12-agent" });
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

test("Full control: chosen with a check, made with Create invite, nothing else to fill", { skip: process.platform !== "darwin" && "agent presets need macOS (its protected file and screen helpers)" }, async () => {
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
  assert.match(text, /^Open this link in your browser, then I approve the code it shows\./);
  assert.match(text, /You get full control of my Mac/);
  assert.match(text, /all apps, files, browser pages and shell commands/);
  assert.doesNotMatch(text, /stay out|except|hidden apps/);
  assert.doesNotMatch(text, /Saved tools|hands come first|One agent acts|not sandboxed/, "nothing long or outdated");
  assert.match(text, /Ask me before paying, sending or deleting anything\. Don't share this link\./);
  assert.ok(text.split(/\s+/).length <= 80, "short enough to read");
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
  assert.match(message(c), /You get only "Google Chrome", on my screen\./);
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
  assert.match(message(c), /You can read and change files in "\/Users\/me\/Project"\. No screen, no commands\./);
  assert.doesNotMatch(message(c), /One agent acts/);
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
  assert.match(message(c), /You can look: my screen/);
  assert.match(message(c), /Hidden from you: "Messages" and "Mail"\./);
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
  assert.match(message(c), /Your access lasts until I end it\. Keep the link: it brings this browser back\./);
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
  assert.match(text, /^Connect to my Mac with Reach\. Run this once \(Node\.js 22 or later\), then I approve the code it shows:/);
  assert.match(text, /curl -fsSL --create-dirs -o ~\/\.reach-agent\/agent\.mjs\.new https:\/\/mac\.tail\.ts\.net\/agent\.mjs && node -e '[^\n]*' ~\/\.reach-agent\/agent\.mjs\.new (?:ab){32} && mv ~\/\.reach-agent\/agent\.mjs\.new ~\/\.reach-agent\/agent\.mjs && printf '%s\\n' 'https:\/\/mac\.tail\.ts\.net\/agent#i=https%3A%2F%2Fmac\.tail\.ts\.net%3A8443[^']+&t=funnel' \| node ~\/\.reach-agent\/agent\.mjs join/, "the private address rides in the link");
  assert.doesNotMatch(text, /tskey-auth/);
  assert.match(text, /Then add Reach as an MCP server: node ~\/\.reach-agent\/agent\.mjs mcp/);
  assert.match(text, /all apps, files, browser pages and shell commands/);
  assert.doesNotMatch(text, /window\.reach|Sign in:/);
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
  assert.match(text, /curl -fsSL --create-dirs -o ~\/\.reach-agent\/agent\.mjs\.new https:\/\/mac\.tail\.ts\.net\/agent\.mjs && node -e '[^\n]*' ~\/\.reach-agent\/agent\.mjs\.new (?:ab){32} && mv ~\/\.reach-agent\/agent\.mjs\.new ~\/\.reach-agent\/agent\.mjs && printf '%s\\n' 'https:\/\/mac\.tail\.ts\.net\/agent#i=[^']+&t=funnel' \| node ~\/\.reach-agent\/agent\.mjs join/);
  assert.doesNotMatch(text, /No Tailscale invite key/);
  assert.match(text, /On Windows, in PowerShell[^\n]*:\n\n\[Net\.ServicePointManager\]::SecurityProtocol = 'Tls12'; \$d = "\$HOME\\\.reach-agent"; .*Invoke-WebRequest -UseBasicParsing -Uri https:\/\/mac\.tail\.ts\.net\/agent\.mjs .*\| node "\$d\\agent\.mjs" join/);
});

test("the invite form renders without React warnings", () => assert.deepEqual(dom.errors, []));
