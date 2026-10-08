import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The owner's invite: one preset, then only what that preset needs. The
// message the agent reads describes the issued invitation and what stays closed.
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
const choose = (c, title) => click(c.querySelector(`[aria-label="Access preset"] input[aria-label="${title}"]`));
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function mock({ desktopAvailable = true, maxFunnelSeconds = 86400, standingAllowed = false } = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || "GET", route, body]);
    if (route === "/api/agents/browser-options") return reply({ terminals: [], desktopAvailable, presetApps, screenAvailable: true, appAccessAvailable: false, apps: [], ...(maxFunnelSeconds ? { maxFunnelSeconds } : {}), ...(standingAllowed ? { standingAllowed } : {}) });
    if (route === "/api/agents/browser-invitations")
      return reply({ invitation: secret, url: `https://mac.tail.ts.net/agent-browser#invite=${secret}`, clientId: "muse", preset: body.preset, expiresAt: Date.now() + 3600000, joinBy: Date.now() + 900000, scopes: [] });
    if (route === "/api/files") return reply({ items: [] });
    return reply({ error: "Unexpected request" }, 404);
  };
  return calls;
}
const open = async (options) => {
  let made;
  const view = await render(React.createElement(BrowserInvite, { peer, device, keyPeer: peer, onSetup() {}, onCreated: (...args) => { made = args; } }));
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Access preset"]'));
  await dom.waitFor(() => c.querySelector('[aria-label="Access duration"]'));
  return { c, made: () => made, ...options };
};
const issued = (calls) => calls.find(([, route]) => route === "/api/agents/browser-invitations")?.[2];
const message = (c) => c.querySelector('textarea[aria-label="AI browser invitation message"]').value;

test("one preset is the whole form: Full control creates with nothing else", async () => {
  const calls = mock();
  const { c, made } = await open();
  const name = c.querySelector('[aria-label="AI browser name"]').value;
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.equal(button(c, "Create invite link").disabled, true);
  assert.match(c.textContent, /What can it access\?/);
  const titles = [...c.querySelectorAll('[aria-label="Access preset"] input')].map((input) => input.getAttribute("aria-label"));
  assert.deepEqual(titles, ["Full control", "Apps", "Files", "Read only"]);
  await choose(c, "Full control");
  assert.match(c.textContent, /commands can read sensitive files or change Reach/);
  assert.match(c.textContent, /guardrails, not a sandbox/);
  assert.match(c.textContent, /Touching the Mac pauses input/);
  assert.match(c.textContent, /gets full control of this Mac for 30 minutes/);
  assert.equal(button(c, "Create invite link").disabled, false);
  await click(button(c, "Create invite link"));
  await dom.waitFor(() => issued(calls));
  assert.deepEqual(issued(calls), { name, transport: "funnel", ttlSeconds: 1800, preset: "full" });
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.equal(dom.document.activeElement.textContent, "Your invite is ready", "focus moves to the result after creation");
  const text = message(c);
  assert.match(text, /^Open this temporary Reach link in your browser/);
  assert.match(text, /Preset: Full control\./);
  assert.match(text, /Full control is not sandboxed/);
  assert.match(text, /password fields and password apps/);
  assert.match(text, /Reach and Tailscale/);
  assert.match(text, /One agent acts on the Mac at a time/);
  assert.match(text, /Never invite anyone, delegate access, or share this link/);
  assert.ok(text.split("\n\n")[0].split(/\s+/).length <= 190, "short enough to read");
  assert.equal(text.split("\n").at(-1), `https://mac.tail.ts.net/agent-browser#invite=${secret}`);
  assert.equal(made()[1], text.split("\n").at(-1));
  assert.doesNotMatch(text, /approval|view only/i);
});

test("Apps: pick apps with real names; protected apps are shown locked with their reason; terminals carry a caution", async () => {
  const calls = mock();
  const { c } = await open();
  await choose(c, "Apps");
  assert.equal(button(c, "Create invite link").disabled, true);
  assert.match(c.textContent, /Pick at least one app/);
  assert.equal(c.querySelector('[aria-label="Allow 1Password"]'), null, "always protected apps have no switch");
  assert.match(c.querySelector(".ag-locked").textContent, /1Password.*always protected/);
  await click(c.querySelector('[aria-label="Allow Google Chrome"]'));
  assert.match(c.textContent, /Runs commands as you/, "Terminal is offered with a caution");
  assert.match(c.textContent, /Google Chrome, nothing else for 30 minutes/);
  await click(button(c, "1 hour"));
  await click(button(c, "Create invite link"));
  await dom.waitFor(() => issued(calls));
  assert.deepEqual(issued(calls), { name: issued(calls).name, transport: "funnel", ttlSeconds: 3600, preset: "apps", apps: [{ id: "/Applications/Google Chrome.app" }] });
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.match(message(c), /Preset: Apps\. You see and use only "Google Chrome"/);
  assert.match(message(c), /Nothing else is visible or clickable/);
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
  assert.match(c.textContent, /Changes land in your real folders at once/);
  await click(button(c, "Create invite link"));
  await dom.waitFor(() => issued(calls));
  assert.deepEqual(issued(calls), { name: issued(calls).name, transport: "funnel", ttlSeconds: 1800, preset: "files", folders: [{ root: 0, path: "" }], write: true });
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.match(message(c), /Preset: Files\. You read and change files in only "\/Users\/me\/Project"/);
  assert.doesNotMatch(message(c), /One agent acts/);
  // Another invitation: Read only, hiding the apps where codes arrive.
  await click(button(c, "Invite another agent"));
  await choose(c, "Read only");
  await click(button(c, "Hide Messages and Mail"));
  assert.match(c.textContent, /a look at the screen and files, except Messages and Mail, no touching/);
  await click(button(c, "Create invite link"));
  await dom.waitFor(() => calls.filter(([, route]) => route === "/api/agents/browser-invitations").length === 2);
  const second = calls.filter(([, route]) => route === "/api/agents/browser-invitations")[1][2];
  assert.deepEqual(second, { name: second.name, transport: "funnel", ttlSeconds: 1800, preset: "readonly", hidden: [{ id: "/System/Applications/Messages.app" }, { id: "/System/Applications/Mail.app" }] });
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.match(message(c), /Preset: Read only\. You look/);
  assert.match(message(c), /The owner also hid "Messages" and "Mail"/);
});

test("a day of access is offered only when the server allows it", async () => {
  const calls = mock();
  const { c } = await open();
  await choose(c, "Full control");
  await click(button(c, "24 hours"));
  assert.match(c.textContent, /full control of this Mac for 24 hours/);
  assert.match(c.textContent, /A day is long for an agent on your Mac/);
  await click(button(c, "Create invite link"));
  await dom.waitFor(() => issued(calls));
  assert.equal(issued(calls).ttlSeconds, 86400);
  mock({ maxFunnelSeconds: 0 });
  const older = await open();
  assert.equal(button(older.c, "24 hours"), undefined, "an older server never sees a choice it would refuse");
});

test("Always sends no end time and tells the owner and the agent it lasts until ended", async () => {
  const calls = mock({ standingAllowed: true });
  const { c } = await open();
  await choose(c, "Read only");
  await click(button(c, "Always"));
  assert.match(c.textContent, /a look at the screen and files, no touching until you end it/);
  assert.match(c.textContent, /comes back from the same browser with no new invite\. The link works once; for a new browser, tap Reopen link/);
  await click(button(c, "Create invite link"));
  await dom.waitFor(() => issued(calls));
  assert.equal(issued(calls).standing, true);
  assert.equal(issued(calls).ttlSeconds, undefined, "Always has no duration to send");
  await dom.waitFor(() => c.querySelector('[aria-label="AI browser invitation message"]'));
  assert.match(c.textContent, /Until you end it in Settings → Agents/);
  assert.doesNotMatch(c.textContent, /Join by/);
  assert.match(message(c), /lasts until the owner ends it, in this browser.*The link works once; for a different browser, ask the owner to reopen it/);
  assert.doesNotMatch(message(c), /temporary/);
  mock();
  const older = await open();
  assert.equal(button(older.c, "Always"), undefined, "an older server never sees a choice it would refuse");
});

test("without the Mac's screen helpers, only Files can be created, and the form says why", async () => {
  mock({ desktopAvailable: false });
  const { c } = await open();
  for (const title of ["Full control", "Apps", "Read only"]) assert.equal(c.querySelector(`[aria-label="Access preset"] input[aria-label="${title}"]`).disabled, true, title);
  assert.equal(c.querySelector('[aria-label="Access preset"] input[aria-label="Files"]').disabled, false);
  assert.match(c.textContent, /Screen presets need this Mac's Screen Recording and Accessibility/);
});

test("the invite form renders without React warnings", () => assert.deepEqual(dom.errors, []));
