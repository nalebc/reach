import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { presetFixture as fixture, apps } from "./helpers/preset-fixture.mjs";

// Preset invitations end to end: created from a pinned phone over the
// private listener, redeemed by the agent, and checked route by route. Native
// screen, input and app helpers are stand-ins; nothing touches this computer.
const { chrome, notes, onePassword, messages } = apps;

test("each preset issues its fixed scopes and reports itself to the agent", async (t) => {
  const f = await fixture(t);
  const full = await f.join({ preset: "full" });
  assert.equal(full.created.preset, "full");
  assert.deepEqual(full.created.scopes, ["device", "browser:read", "files:read", "browser:write", "browser:screen", "browser:control", "browser:open", "browser:shell"]);
  const view = await full.as("/api/browser");
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.preset, "full");
  assert.equal(view.body.presetName, "Full control");
  assert.deepEqual([view.body.screen, view.body.control, view.body.shell, view.body.write, view.body.open], [true, true, true, true, true]);
  assert.deepEqual(view.body.roots.map((root) => root.path), [f.home, "/"], "Full control without chosen folders sees every shared folder");
  assert.equal(view.body.screenNotice, undefined);
  assert.equal(view.body.restrictedTerminal, undefined);

  const apps = await f.join({ preset: "apps", apps: [{ id: chrome.id }] });
  assert.deepEqual(apps.created.scopes, ["device", "browser:read", "browser:screen", "browser:control", "browser:open"]);
  const appsView = await apps.as("/api/browser");
  assert.deepEqual(appsView.body.apps, [{ id: chrome.id, name: "Google Chrome", bundleId: "com.google.Chrome" }]);
  assert.deepEqual(appsView.body.roots, []);
  assert.equal(appsView.body.shell, false);
  const stored = f.reach.auth.list().find((client) => client.id === apps.created.clientId);
  assert.equal(stored.policy.apps[0].identity, chrome.identity, "the app is bound to its signing identity from the catalog");
  assert.ok(stored.browserAppApprover, "taking the Mac binds the approving phone");

  const files = await f.join({ preset: "files", folders: [{ root: 0, path: "Desktop/Project" }], write: true });
  assert.deepEqual(files.created.scopes, ["device", "browser:read", "files:read", "browser:write"]);
  const filesView = await files.as("/api/browser");
  assert.deepEqual(filesView.body.roots.map((root) => root.path), [path.join(f.home, "Desktop", "Project")]);
  assert.deepEqual([filesView.body.screen, filesView.body.control, filesView.body.write], [false, false, true]);
  const filesStored = f.reach.auth.list().find((client) => client.id === files.created.clientId);
  assert.equal(filesStored.browserAppApprover, undefined, "reading and editing files never locks Reach to one phone");

  const readonly = await f.join({ preset: "readonly", hidden: [{ id: messages.id }, { id: onePassword.id }] });
  assert.deepEqual(readonly.created.scopes, ["device", "browser:read", "files:read", "browser:screen"]);
  const readonlyView = await readonly.as("/api/browser");
  assert.deepEqual(readonlyView.body.hidden.map((app) => app.name), ["Messages", "1Password"]);
  assert.equal(readonlyView.body.control, false);
});

test("the owner's picker lists every app with the protected ones marked", async (t) => {
  const f = await fixture(t);
  const options = await f.call("/api/agents/browser-options");
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.equal(options.body.desktopAvailable, true);
  assert.equal(options.body.maxFunnelSeconds, 86400);
  const byName = Object.fromEntries(options.body.presetApps.map((app) => [app.name, app]));
  assert.equal(byName["Google Chrome"].protected, false, "host browsers are the point of Full control and Apps");
  assert.equal(byName["Google Chrome"].running, true);
  assert.equal(byName["1Password"].protected, true);
  assert.match(byName["1Password"].reason, /always protected/);
  assert.equal(byName.Terminal.protected, false);
  assert.equal(byName.Terminal.runsCommands, true);
  assert.equal(byName.Notes.runsCommands, undefined);
  assert.ok(!options.body.presetApps.some((app) => app.identity), "signing identities stay on the computer");
});

test("what a preset refuses at creation", async (t) => {
  const f = await fixture(t);
  const refused = async (body, status, pattern, options) => {
    const result = await f.invite(body, options);
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.match(result.body.error, pattern);
  };
  await refused({ preset: "apps", apps: [{ id: onePassword.id }] }, 403, /always protected/);
  await refused({ preset: "apps", apps: [{ id: "/Applications/Nope.app" }] }, 400, /installed on this Mac/);
  await refused({ preset: "apps" }, 400, /at least one app/);
  await refused({ preset: "files" }, 400, /at least one folder/);
  await refused({ preset: "files", folders: [{ root: 1, path: "" }] }, 403, /Home, system/, undefined);
  assert.equal((await f.invite({ preset: "readonly", folders: [{ root: 1, path: "" }] })).status, 201, "Read only may watch any shared folder");
  await refused({ preset: "full", screen: "apps" }, 400, /unsupported fields/);
  await refused({ preset: "full", restrictedTerminal: true }, 400, /unsupported fields/);
  await refused({ preset: "full", folders: [{ root: 0, path: "Missing" }] }, 404, /no longer available/);
  // Taking the Mac needs the phone's own Tailscale connection, as app sessions did.
  await refused({ preset: "full" }, 403, /native Tailscale/, { node: "nWasm" });
  await refused({ preset: "apps", apps: [{ id: chrome.id }] }, 403, /native Tailscale/, { node: "nWasm" });
  // Reading never needs it.
  assert.equal((await f.invite({ preset: "readonly" }, { node: "nWasm" })).status, 201);
  assert.equal((await f.invite({ preset: "files", folders: [{ root: 0, path: "Desktop/Project" }] }, { node: "nWasm" })).status, 201);
  // Only the owner invites.
  const files = await f.join({ preset: "files", folders: [{ root: 0, path: "Desktop/Project" }] });
  assert.equal((await files.as("/api/agents/browser-invitations", { method: "POST", body: { name: "X", ttlSeconds: 600, preset: "readonly" } })).status, 403);
});

test("screen presets need the Mac's screen helpers; Files does not", async (t) => {
  const f = await fixture(t, { desktopAvailable: false });
  for (const body of [{ preset: "full" }, { preset: "readonly" }, { preset: "apps", apps: [{ id: chrome.id }] }]) {
    const result = await f.invite(body);
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.match(result.body.error, /Screen Recording and Accessibility/);
  }
  assert.equal((await f.invite({ preset: "files", folders: [{ root: 0, path: "Desktop/Project" }] })).status, 201);
  const options = await f.call("/api/agents/browser-options");
  assert.equal(options.body.desktopAvailable, false);
  assert.deepEqual(options.body.presetApps, []);
  const bare = await fixture(t, { withDesktop: false });
  assert.equal((await bare.invite({ preset: "readonly" })).status, 503);
});

test("every route outside the preset's allowlist is refused, including the earlier agent routes", async (t) => {
  const f = await fixture(t);
  const readonly = await f.join({ preset: "readonly" });
  const files = await f.join({ preset: "files", folders: [{ root: 0, path: "Desktop/Project" }] });
  const denied = async (as, method, route, body) => {
    const result = await as(route, { method, ...(body && method !== "GET" ? { body } : {}) });
    assert.equal(result.status, 403, `${method} ${route} -> ${result.status} ${JSON.stringify(result.body)}`);
  };
  for (const [method, route, body] of [
    ["POST", "/api/browser/terminal", { command: "pwd", root: 0 }],
    ["GET", "/api/browser/terminal/history"],
    ["POST", "/api/browser/requests", { type: "terminal", root: 0, command: "pwd", reason: "x" }],
    ["GET", "/api/browser/requests"],
    ["GET", "/api/browser/screen"],
    ["POST", "/api/browser/scroll", { direction: "down" }],
    ["GET", "/api/browser/apps"],
    ["POST", "/api/browser/apps/input", { target: "x", action: { type: "click", x: 0.5, y: 0.5 } }],
    ["POST", "/api/browser/desktop/input", { action: { type: "click", x: 0.5, y: 0.5 } }],
    ["POST", "/api/browser/shell", { command: "ls" }],
    ["POST", "/api/browser/files/change", { op: "write", root: 0, path: "a.txt", content: "x" }],
    ["GET", "/api/clients"],
    ["GET", "/api/agents/browser-requests"],
    ["GET", "/api/browser/agents"],
    ["PUT", "/api/files/text", { root: 0, path: "a.txt", content: "x" }],
    ["GET", "/api/browser/terminals/reach:one"],
  ]) await denied(readonly.as, method, route, body);
  for (const [method, route] of [["GET", "/api/browser/desktop/screen"], ["GET", "/api/browser/desktop/front"], ["GET", "/api/browser/desktop/apps"], ["POST", "/api/browser/desktop/open"]])
    await denied(files.as, method, route, { app: chrome.id });
  // What they may do: read their folders.
  const listing = await files.as("/api/files?root=0&path=");
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  assert.ok(listing.body.items?.some((item) => item.name === "brief.txt"));
  const text = await files.as("/api/files/text?root=0&path=brief.txt");
  assert.equal(text.status, 200);
  assert.ok(JSON.stringify(text.body).includes("A project brief"), JSON.stringify(text.body));
});

test("changing a preset later keeps the same rules and can only narrow its hold on the Mac", async (t) => {
  const f = await fixture(t);
  const full = await f.join({ preset: "full" });
  const change = (id, body) => f.call(`/api/guests/${id}/access`, { method: "POST", body });
  // Full control -> Read only: input scopes go, the agent's live helper is cancelled.
  let result = await change(full.created.clientId, { preset: "readonly", folders: "keep" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.scopes, ["device", "browser:read", "files:read", "browser:screen"]);
  assert.ok(f.cancelled.includes(full.created.clientId));
  let view = await full.as("/api/browser");
  assert.equal(view.body.preset, "readonly");
  assert.equal((await full.as("/api/browser/desktop/input", { method: "POST", body: { action: { type: "click", x: 0.5, y: 0.5 } } })).status, 403);
  // Read only can't become Full control again without a new invitation from the phone.
  result = await change(full.created.clientId, { preset: "full", folders: "keep" });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /new invitation/);
  // Apps: the app list changes, bound to the catalog; a protected app is refused; the earlier form's fields are refused.
  const apps = await f.join({ preset: "apps", apps: [{ id: chrome.id }] });
  result = await change(apps.created.clientId, { apps: [{ id: notes.id }] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.policy.apps.map((app) => app.name), ["Notes"]);
  assert.equal(result.body.policy.apps[0].identity, notes.identity);
  assert.equal((await change(apps.created.clientId, { apps: [{ id: onePassword.id }] })).status, 403);
  assert.equal((await change(apps.created.clientId, { screen: "apps" })).status, 409);
  assert.equal((await change(apps.created.clientId, { restrictedTerminal: true })).status, 400);
  // Files: the edit switch and folders.
  const files = await f.join({ preset: "files", folders: [{ root: 0, path: "Desktop/Project" }] });
  result = await change(files.created.clientId, { write: true, folders: "keep" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.scopes.includes("browser:write"));
  result = await change(files.created.clientId, { preset: "readonly", folders: [] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.policy.roots, [f.home, "/"], "Read only without chosen folders sees every shared folder");
  assert.equal((await change(files.created.clientId, { preset: "files", folders: [] })).status, 400);
  assert.equal((await change(files.created.clientId, { preset: "apps", apps: [{ id: chrome.id }], folders: [] })).status, 409);
});

test("agents hold their own session only", async (t) => {
  const f = await fixture(t);
  const one = await f.join({ preset: "readonly" });
  const two = await f.join({ preset: "readonly" });
  assert.equal((await one.as(`/api/clients/${two.created.clientId}`, { method: "DELETE" })).status, 403);
  assert.equal((await two.as("/api/browser")).status, 200);
  assert.equal((await one.as("/api/device/access", { method: "DELETE" })).status, 200);
  assert.equal((await one.as("/api/browser")).status, 401);
  assert.equal((await two.as("/api/browser")).status, 200);
});
