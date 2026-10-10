import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS, presetScopes, validatePresetInvitation, presetPolicy, validPresetPolicy,
  presetRouteAllowed, presetAccess, presetAppsFromCatalog, hostGuardedPreset, validAppPath,
} from "../server/agent-presets.mjs";

const chrome = { id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome" };
const base = { name: "Muse", ttlSeconds: 900 };
const client = (preset, extra = {}) => {
  const policy = { invite: true, browser: true, preset, roots: preset === "apps" ? [] : ["/Users/me/Desktop"], ...(preset === "apps" ? { apps: [chrome] } : {}), ...extra };
  return { scopes: presetScopes(policy), policy };
};

test("each preset derives a fixed scope set and nothing else", () => {
  assert.deepEqual(PRESETS, ["full", "apps", "files", "readonly"]);
  assert.deepEqual(presetScopes({ preset: "full" }), ["device", "browser:read", "files:read", "browser:write", "browser:screen", "browser:control", "browser:open", "browser:shell"]);
  assert.deepEqual(presetScopes({ preset: "apps" }), ["device", "browser:read", "browser:screen", "browser:control", "browser:open"]);
  assert.deepEqual(presetScopes({ preset: "files" }), ["device", "browser:read", "files:read"]);
  assert.deepEqual(presetScopes({ preset: "files", write: true }), ["device", "browser:read", "files:read", "browser:write"]);
  assert.deepEqual(presetScopes({ preset: "readonly" }), ["device", "browser:read", "files:read", "browser:screen"]);
  assert.deepEqual(presetScopes({ preset: "owner" }), []);
  assert.deepEqual(presetScopes(undefined), []);
  // Stored flags from the earlier form never add scopes to a preset.
  assert.deepEqual(presetScopes({ preset: "readonly", restrictedTerminal: true, screen: "apps" }), ["device", "browser:read", "files:read", "browser:screen"]);
  assert.equal(hostGuardedPreset({ browser: true, preset: "full" }), true);
  assert.equal(hostGuardedPreset({ browser: true, preset: "apps" }), true);
  assert.equal(hostGuardedPreset({ browser: true, preset: "readonly" }), false);
  assert.equal(hostGuardedPreset({ browser: true, preset: "files" }), false);
  assert.equal(hostGuardedPreset({ preset: "full" }), false);
});

test("validation accepts exactly what each preset needs", () => {
  const full = validatePresetInvitation({ ...base, preset: "full" });
  assert.deepEqual(full, { name: "Muse", ttlSeconds: 900, joinSeconds: 900, transport: "tailnet", preset: "full", folders: [], apps: [], write: false, hidden: [], terminalIds: [] });
  const apps = validatePresetInvitation({ ...base, preset: "apps", apps: [chrome] });
  assert.deepEqual(apps.apps, [chrome]);
  const files = validatePresetInvitation({ ...base, preset: "files", folders: [{ root: 0, path: "Desktop" }], write: true });
  assert.equal(files.write, true);
  const readonly = validatePresetInvitation({ ...base, preset: "readonly", hidden: [{ id: "/System/Applications/Messages.app", name: "Messages" }], terminalIds: ["reach:one", "reach:one"] });
  assert.deepEqual(readonly.terminalIds, ["reach:one"]);
  assert.equal(readonly.hidden.length, 1);
  const funnel = validatePresetInvitation({ ...base, preset: "full", transport: "funnel", ttlSeconds: 3600 });
  assert.equal(funnel.transport, "funnel");
  const refused = (input, pattern, status = 400) => {
    assert.throws(() => validatePresetInvitation(input), (error) => { assert.equal(error.status, status); assert.match(error.message, pattern); return true; });
  };
  refused({ ...base, preset: "owner" }, /Full control, Apps, Files or Read only/);
  refused({ ...base }, /Full control, Apps, Files or Read only/);
  refused({ ...base, preset: "full", screen: "apps" }, /unsupported fields/);
  refused({ ...base, preset: "full", restrictedTerminal: true }, /unsupported fields/);
  refused({ ...base, preset: "apps" }, /at least one app/);
  refused({ ...base, preset: "apps", apps: [chrome], folders: [{ root: 0, path: "x" }] }, /no folders/);
  refused({ ...base, preset: "files" }, /at least one folder/);
  refused({ ...base, preset: "full", apps: [chrome] }, /Only the Apps preset chooses apps/);
  refused({ ...base, preset: "full", write: true }, /Only the Files preset/);
  refused({ ...base, preset: "apps", apps: [chrome], hidden: [chrome] }, /Hidden apps apply/);
  refused({ ...base, preset: "files", folders: [{ root: 0, path: "x" }], terminalIds: ["reach:a"] }, /Watching terminals/);
  refused({ ...base, preset: "apps", apps: [{ id: "/Applications/1Password.app", name: "1Password", bundleId: "com.1password.1password" }] }, /always protected/, 403);
  refused({ ...base, preset: "apps", apps: [{ id: "/Applications/Tailscale.app", name: "Tailscale" }] }, /always protected/, 403);
  refused({ ...base, preset: "apps", apps: [{ id: "Chrome.app" }] }, /up to 30 apps/);
  refused({ ...base, preset: "apps", apps: [chrome, chrome] }, /once/);
  assert.equal(validatePresetInvitation({ ...base, preset: "full", transport: "funnel", ttlSeconds: 86400 }).ttlSeconds, 86400, "a day over the public link");
  refused({ ...base, preset: "full", transport: "funnel", ttlSeconds: 86401 }, /duration/);
  refused({ ...base, preset: "full", transport: "funnel", joinSeconds: 1200 }, /duration/, 400);
  refused({ ...base, preset: "full", ttlSeconds: 30 }, /duration/);
  refused({ ...base, preset: "full", name: "Mu‮se" }, /duration/);
  refused({ ...base, preset: "full", terminalIds: ["bogus"] }, /duration/);
});

test("stored policies are re-checked: legacy fields, protected apps and bad shapes grant nothing", () => {
  const good = presetPolicy(validatePresetInvitation({ ...base, preset: "apps", apps: [chrome] }), []);
  assert.deepEqual(good, { invite: true, browser: true, preset: "apps", roots: [], apps: [chrome] });
  assert.ok(validPresetPolicy(good));
  assert.ok(validPresetPolicy(presetPolicy(validatePresetInvitation({ ...base, preset: "full" }), ["/Users/me"])));
  assert.ok(validPresetPolicy({ invite: true, browser: true, preset: "files", roots: ["/Users/me/Desktop"], write: true }));
  for (const bad of [
    { ...good, screen: "apps" },
    { ...good, restrictedTerminal: true },
    { ...good, apps: [{ id: "/Applications/Keychain Access.app", name: "Keychain Access" }] },
    { ...good, apps: [] },
    { ...good, roots: ["/Users/me"] },
    { ...good, preset: "files" },
    { invite: true, browser: true, preset: "files", roots: [] },
    { invite: true, browser: true, preset: "full", roots: ["relative"] },
    { invite: true, browser: true, preset: "readonly", roots: ["/a"], write: true },
    { invite: true, preset: "full", roots: [] },
    null,
  ]) assert.equal(validPresetPolicy(bad), false, JSON.stringify(bad));
});

test("the route allowlist follows the preset exactly", () => {
  const table = [
    ["GET", "/device", { full: true, apps: true, files: true, readonly: true }],
    ["GET", "/browser", { full: true, apps: true, files: true, readonly: true }],
    ["DELETE", "/device/access", { full: true, apps: true, files: true, readonly: true }],
    ["GET", "/files", { full: true, apps: false, files: true, readonly: true }],
    ["GET", "/files/text", { full: true, apps: false, files: true, readonly: true }],
    ["GET", "/browser/files/search", { full: true, apps: false, files: true, readonly: true }],
    ["POST", "/browser/files/change", { full: true, apps: false, files: false, readonly: false }],
    ["GET", "/browser/desktop/screen", { full: true, apps: true, files: false, readonly: true }],
    ["GET", "/browser/desktop/front", { full: true, apps: true, files: false, readonly: true }],
    ["POST", "/browser/desktop/input", { full: true, apps: true, files: false, readonly: false }],
    ["POST", "/browser/desktop/wait", { full: true, apps: true, files: false, readonly: false }],
    ["POST", "/browser/desktop/open", { full: true, apps: true, files: false, readonly: false }],
    ["GET", "/browser/desktop/apps", { full: true, apps: true, files: false, readonly: false }],
    ["POST", "/browser/shell", { full: true, apps: false, files: false, readonly: false }],
    ["GET", "/browser/shell/history", { full: true, apps: false, files: false, readonly: false }],
    ["POST", "/browser/terminal", { full: false, apps: false, files: false, readonly: false }],
    ["GET", "/browser/screen", { full: false, apps: false, files: false, readonly: false }],
    ["POST", "/browser/requests", { full: false, apps: false, files: false, readonly: false }],
    ["GET", "/browser/apps", { full: false, apps: false, files: false, readonly: false }],
    ["POST", "/agents/browser-invitations", { full: false, apps: false, files: false, readonly: false }],
    ["GET", "/clients", { full: false, apps: false, files: false, readonly: false }],
    ["PUT", "/files/text", { full: false, apps: false, files: false, readonly: false }],
    ["GET", "/browser/terminals/reach:one", { full: false, apps: false, files: false, readonly: false }],
  ];
  for (const [method, route, expected] of table)
    for (const preset of PRESETS)
      assert.equal(presetRouteAllowed(client(preset), method, route), expected[preset], `${preset} ${method} ${route}`);
  // Writing follows the Files switch; watching follows chosen terminals.
  assert.equal(presetRouteAllowed(client("files", { write: true }), "POST", "/browser/files/change"), true);
  assert.equal(presetRouteAllowed(client("readonly", { terminalIds: ["reach:one"] }), "GET", "/browser/terminals/reach:one"), true);
  assert.equal(presetRouteAllowed(client("files", { terminalIds: ["reach:one"] }), "GET", "/browser/terminals/reach:one"), true);
  // Scopes that don't match the preset are ignored, and a broken policy denies everything.
  assert.equal(presetRouteAllowed({ ...client("readonly"), scopes: [...client("full").scopes] }, "POST", "/browser/desktop/input"), true, "the scope list is checked, so derive it from the preset on every request");
  assert.equal(presetRouteAllowed({ scopes: client("full").scopes, policy: { ...client("full").policy, screen: "apps" } }, "GET", "/device"), false);
  assert.equal(presetRouteAllowed(null, "GET", "/device"), false);
});

test("the agent's own view and the catalog binding", () => {
  const view = presetAccess({ ...client("apps"), scopes: presetScopes({ preset: "apps" }) });
  assert.deepEqual(view, { preset: "apps", presetName: "Apps", screen: true, control: true, open: true, shell: false, write: false, apps: [chrome], hidden: [] });
  const catalog = [{ ...chrome, identity: "a".repeat(64), running: true }, { id: "/Applications/1Password.app", name: "1Password", bundleId: "com.1password.1password" }];
  assert.deepEqual(presetAppsFromCatalog(catalog, [{ id: chrome.id }]), [{ ...chrome, identity: "a".repeat(64) }]);
  assert.throws(() => presetAppsFromCatalog(catalog, [{ id: "/Applications/Other.app" }]), /installed on this Mac/);
  assert.throws(() => presetAppsFromCatalog(catalog, [{ id: "/Applications/1Password.app" }]), /always protected/);
  assert.equal(presetAppsFromCatalog(catalog, [{ id: "/Applications/1Password.app" }], { allowProtected: true }).length, 1);
  assert.throws(() => presetAppsFromCatalog(null, [{ id: chrome.id }]), /unavailable/);
});

// These are Mac app identifiers, even when metadata is inspected off macOS.
test("Mac app paths use POSIX syntax independently of the host platform", () => {
  assert.equal(validAppPath("/Applications/Google Chrome.app"), true);
  for (const app of ["Chrome.app", "C:\\Applications\\Chrome.app", "/Applications/../Chrome.app", "//Applications/Chrome.app", "/Applications/Chrome\\helper.app"])
    assert.equal(validAppPath(app), false, app);
});
