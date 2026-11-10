import test from "node:test";
import assert from "node:assert/strict";
import { applyAgentPolicy } from "../server/agent-policy.mjs";
import {
  PRESETS, presetScopes, validatePresetInvitation, presetPolicy, validPresetPolicy,
  presetRouteAllowed, presetAccess, presetAppsFromCatalog, hostGuardedPreset, validAppPath,
} from "../server/agent-presets.mjs";

const chrome = { id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome" };
const base = { name: "Muse", ttlSeconds: 900 };
const client = (preset, extra = {}) => {
  const policy = { invite: true, browser: true, preset, roots: preset === "apps" ? [] : ["/Users/me/Desktop"], ...(preset === "apps" ? { apps: [chrome] } : {}), ...extra };
  return { kind: "agent", scopes: presetScopes(policy), policy };
};

test("agents receive only bounded presets and owner-level Full control is disabled", () => {
  assert.deepEqual(PRESETS, ["apps", "files", "readonly"]);
  assert.deepEqual(presetScopes({ preset: "full" }), []);
  assert.deepEqual(presetScopes({ preset: "apps" }), ["device", "browser:read", "browser:screen", "browser:control", "browser:open"]);
  assert.deepEqual(presetScopes({ preset: "files" }), ["device", "browser:read", "files:read"]);
  assert.deepEqual(presetScopes({ preset: "files", write: true }), ["device", "browser:read", "files:read", "browser:write"]);
  assert.deepEqual(presetScopes({ preset: "readonly" }), ["device", "browser:read", "files:read", "browser:screen"]);
  assert.equal(hostGuardedPreset({ browser: true, preset: "full" }), false);
  assert.equal(hostGuardedPreset({ browser: true, preset: "apps" }), true);
  assert.equal(hostGuardedPreset({ browser: true, preset: "readonly" }), false);
});

test("invitation validation accepts Apps, Files and Read only and rejects agent Full control", () => {
  const apps = validatePresetInvitation({ ...base, preset: "apps", apps: [chrome] });
  assert.deepEqual(apps.apps, [chrome]);
  assert.equal(validatePresetInvitation({ ...base, preset: "files", folders: [{ root: 0, path: "Desktop" }], write: true }).write, true);
  const readonly = validatePresetInvitation({ ...base, preset: "readonly", hidden: [{ id: "/System/Applications/Messages.app", name: "Messages" }], terminalIds: ["reach:one", "reach:one"] });
  assert.deepEqual(readonly.terminalIds, ["reach:one"]);
  assert.equal(readonly.hidden.length, 1);
  for (const input of [
    { ...base, preset: "full" },
    { ...base, preset: "full", fullControlVersion: 1 },
    { ...base, preset: "readonly", fullControlVersion: 1 },
  ]) assert.throws(() => validatePresetInvitation(input), (error) => error.status === 403);
  assert.throws(() => validatePresetInvitation({ ...base, preset: "apps" }), /at least one app/);
  assert.throws(() => validatePresetInvitation({ ...base, preset: "files" }), /at least one folder/);
  assert.throws(() => validatePresetInvitation({ ...base, preset: "apps", apps: [chrome], folders: [{ root: 0, path: "x" }] }), /no folders/);
  assert.throws(() => validatePresetInvitation({ ...base, preset: "apps", apps: [{ id: "/Applications/1Password.app", name: "1Password" }] }), /always protected/);
});

test("legacy Full control grants fail closed at authorization and cannot reach routes", () => {
  const legacy = { kind: "agent", scopes: ["device", "browser:read", "browser:shell"], policy: { invite: true, browser: true, preset: "full", fullControlVersion: 1, roots: ["/Users/me"] } };
  assert.equal(validPresetPolicy(legacy.policy), false);
  assert.equal(applyAgentPolicy(legacy, { roots: ["/Users/me"] }), null);
  assert.equal(presetRouteAllowed(legacy, "GET", "/device"), false);
  assert.equal(presetRouteAllowed(legacy, "POST", "/browser/shell"), false);
});

test("route access follows the reduced preset and remains bounded", () => {
  const table = [
    ["GET", "/device", { apps: true, files: true, readonly: true }],
    ["GET", "/browser", { apps: true, files: true, readonly: true }],
    ["GET", "/files", { apps: false, files: true, readonly: true }],
    ["POST", "/browser/files/change", { apps: false, files: false, readonly: false }],
    ["GET", "/browser/desktop/screen", { apps: true, files: false, readonly: true }],
    ["POST", "/browser/desktop/input", { apps: true, files: false, readonly: false }],
    ["POST", "/browser/shell", { apps: false, files: false, readonly: false }],
    ["POST", "/agents/browser-invitations", { apps: false, files: false, readonly: false }],
  ];
  for (const [method, route, expected] of table)
    for (const preset of PRESETS)
      assert.equal(presetRouteAllowed(client(preset), method, route), expected[preset], `${preset} ${method} ${route}`);
  assert.equal(presetRouteAllowed(client("files", { write: true }), "POST", "/browser/files/change"), true);
  assert.equal(presetRouteAllowed(client("readonly", { terminalIds: ["reach:one"] }), "GET", "/browser/terminals/reach:one"), true);
  assert.equal(presetRouteAllowed({ ...client("readonly"), scopes: client("apps").scopes }, "POST", "/browser/desktop/input"), true,
    "authorization derives the actual scope set from the stored preset before route checks");
});

test("the agent view and app catalog stay derived from the approved preset", () => {
  const view = presetAccess(client("apps"));
  assert.deepEqual(view, { preset: "apps", presetName: "Apps", screen: true, control: true, open: true, shell: false, write: false, apps: [chrome], hidden: [] });
  const catalog = [{ ...chrome, identity: "a".repeat(64), running: true }, { id: "/Applications/1Password.app", name: "1Password", bundleId: "com.1password.1password" }];
  assert.deepEqual(presetAppsFromCatalog(catalog, [{ id: chrome.id }]), [{ ...chrome, identity: "a".repeat(64) }]);
  assert.throws(() => presetAppsFromCatalog(catalog, [{ id: "/Applications/Other.app" }]), /installed on this Mac/);
  assert.throws(() => presetAppsFromCatalog(catalog, [{ id: "/Applications/1Password.app" }]), /always protected/);
  assert.throws(() => presetAppsFromCatalog(null, [{ id: chrome.id }]), /unavailable/);
});

test("Mac app paths use POSIX syntax independently of the host platform", () => {
  assert.equal(validAppPath("/Applications/Google Chrome.app"), true);
  for (const app of ["Chrome.app", "C:\\Applications\\Chrome.app", "/Applications/../Chrome.app", "//Applications/Chrome.app", "/Applications/Chrome\\helper.app"])
    assert.equal(validAppPath(app), false, app);
});
