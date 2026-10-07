import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeRules } from "../server/agent-guard.mjs";

test("selected-app screenshots preserve the protected-window exclusions", async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const screenshot = source.split("func shot(")[1].split("func catalog(")[0];
  assert.match(screenshot, /titleReason\(window\.title/);
  assert.match(screenshot, /including: apps, exceptingWindows: excluded/);
  assert.match(screenshot, /excludingWindows: excluded/);
  assert.doesNotMatch(screenshot, /exceptingWindows: \[\]/);
});

test("secure-field key checks use the tested native policy only for secure targets", async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const keyHandler = source.split('case "key":')[1].split('default:')[0];
  assert.match(keyHandler, /if target\.element\.secure, !secureKeyAllowed\(name, command\) \{ try refuse\(secureReason\) \}/);
  assert.doesNotMatch(keyHandler, /target\.element\.secure, !command/);
});

// The native checker's pure policy, compiled on its own (no AppKit calls run)
// and fed the same rules the server sends it. Protected apps, Reach's windows
// and addresses, the Apps preset's set and the owner's hidden apps are
// decided by this code before any event is posted.
test("compiled native desktop policy decides apps, titles and addresses like the server's rules", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-desktop-policy-"));
  try {
    const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
    const policy = source.split("// BEGIN PURE DESKTOP POLICY")[1]?.split("\n").slice(1).join("\n").split("// END PURE DESKTOP POLICY")[0];
    assert.ok(policy);
    const swift = (value) => JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, "\\u{$1}");
    const list = (values) => `[${values.map(swift).join(",")}]`;
    const rules = (preset, extra = {}) => nativeRules({ preset, ...extra }, { hosts: ["mac.tail1234.ts.net", "localhost:8443"], titles: ["reach"], protectedPaths: [], home: "/Users/me" });
    const build = (name, value) => `
var ${name} = Rules()
${name}.mode = ${swift(value.mode)}
${name}.hosts = ${list(value.hosts)}
${name}.titles = ${list(value.titles)}
${name}.allowedApps = ${value.allowedApps.length ? `[${value.allowedApps.map((app) => `["id": ${swift(app.id)}, "bundleId": ${swift(app.bundleId)}]`).join(",")}]` : "[]"}
${name}.hiddenApps = ${value.hiddenApps.length ? `[${value.hiddenApps.map((app) => `["id": ${swift(app.id)}, "bundleId": ${swift(app.bundleId)}, "name": ${swift(app.name)}]`).join(",")}]` : "[]"}
${name}.protectedAppIds = ${list(value.protectedAppIds)}
${name}.protectedAppNames = ${list(value.protectedAppNames)}
${name}.reachWords = ${list(value.reachWords)}
${name}.privatePanes = ${list(value.privatePanes)}
${name}.protectedTitleWords = ${list(value.protectedTitleWords)}
${name}.patterns = compile(${list(value.protectedPagePatterns)})
${name}.terminalLike = ${list(value.terminalLike)}
`;
    const chrome = { id: "/Applications/Google Chrome.app", bundleId: "com.google.Chrome" };
    const checks = `
import Foundation
${build("full", rules("full", { hidden: [{ id: "/System/Applications/Messages.app", bundleId: "com.apple.MobileSMS", name: "Messages" }] }))}
${build("apps", rules("apps", { apps: [chrome] }))}
${build("view", rules("readonly"))}
func check(_ value: Bool, _ label: String) { if !value { print("FAILED: " + label); exit(1) } }
// Always protected, in every mode.
for (bundle, name, path) in [
  ("com.apple.keychainaccess", "Keychain Access", "/System/Applications/Utilities/Keychain Access.app"),
  ("com.apple.Passwords", "Passwords", "/System/Applications/Passwords.app"),
  ("com.1password.1password", "1Password", "/Applications/1Password.app"),
  ("com.bitwarden.desktop", "Bitwarden", "/Applications/Bitwarden.app"),
  ("com.apple.ScreenContinuity", "iPhone Mirroring", "/System/Applications/iPhone Mirroring.app"),
  ("com.apple.ActivityMonitor", "Activity Monitor", "/System/Applications/Utilities/Activity Monitor.app"),
  ("com.apple.SecurityAgent", "SecurityAgent", "/System/Library/CoreServices/SecurityAgent.app"),
  ("io.tailscale.ipn.macos", "Tailscale", "/Applications/Tailscale.app"),
  ("com.reach.app", "Reach", "/Applications/Reach.app"),
  ("", "", "/Applications/Reach.app"),
] {
  check(appReason(bundle, name, path, full) != nil, "full protects " + name + path)
  check(appReason(bundle, name, path, apps) != nil, "apps protects " + name + path)
  check(appReason(bundle, name, path, view) != nil, "view protects " + name + path)
}
check(appReason("com.apple.keychainaccess", "x", "", full) == protectedReason, "protected reason")
check(appReason("io.tailscale.ipn.macos", "Tailscale", "", full) == reachReason, "reach reason")
// Full control: browsers, terminals and ordinary apps are open; hidden apps are not.
for (bundle, name) in [("com.google.Chrome", "Google Chrome"), ("com.apple.Safari", "Safari"), ("com.apple.Terminal", "Terminal"), ("com.apple.finder", "Finder"), ("com.apple.mail", "Mail"), ("com.example.Preacher", "Preacher"), ("com.apple.systempreferences", "System Settings")] {
  check(appReason(bundle, name, "/Applications/" + name + ".app", full) == nil, "full allows " + name)
}
check(appReason("com.apple.MobileSMS", "Messages", "/System/Applications/Messages.app", full) == hiddenReason, "hidden app by bundle")
check(appReason("com.other.Messenger", "Messages", "/Applications/Other.app", full) == hiddenReason, "hidden app by name")
// Apps preset: the chosen apps only, matched by bundle id or path.
check(appReason("com.google.Chrome", "Google Chrome", "/Applications/Google Chrome.app", apps) == nil, "apps allows chosen bundle")
check(appReason("", "", "/Applications/Google Chrome.app", apps) == nil, "apps allows chosen path")
check(appReason("com.apple.Safari", "Safari", "/Applications/Safari.app", apps) == notAllowedReason, "apps refuses other browsers")
check(appReason("com.apple.finder", "Finder", "", apps) == notAllowedReason, "apps refuses Finder")
check(appReason("com.google.Chrome.helper", "Google Chrome Helper", "", apps) == notAllowedReason, "a helper process with a longer bundle id is not the app")
// Titles: Reach's windows, privacy panes, developer tools and password pages.
check(titleReason("reach — node — 80x24", "com.apple.Terminal", full) == reachReason, "Reach terminal title")
check(titleReason("Reach", "com.google.Chrome", full) == reachReason, "Reach tab title")
check(titleReason("Reach", "com.google.Chrome", apps) == reachReason, "selected Chrome still hides Reach")
check(titleReason("Password Manager", "com.google.Chrome", apps) == protectedReason, "selected Chrome still hides password windows")
check(titleReason("Preacher notes", "com.apple.Notes", full) == nil, "Preacher is not Reach")
check(titleReason("Privacy & Security", "com.apple.systempreferences", full) == protectedReason, "privacy pane")
check(titleReason("Displays", "com.apple.systempreferences", full) == nil, "displays pane")
check(titleReason("Privacy & Security", "com.google.Chrome", full) == nil, "a page about privacy is a page")
check(titleReason("DevTools - amazon.com", "com.google.Chrome", full) == protectedReason, "devtools")
check(titleReason("Password Manager", "com.google.Chrome", full) == protectedReason, "password manager")
check(titleReason("Passwords", "com.apple.Safari", full) == protectedReason, "Safari passwords pane")
check(titleReason("Reset your passwords - Help Center", "com.google.Chrome", full) == nil, "an article about passwords")
check(titleReason("Force Quit Applications", "com.apple.loginwindow", full) == protectedReason, "force quit")
check(titleReason("", "com.google.Chrome", full) == nil, "no title")
// Addresses: Reach's own, and the pages that reveal passwords or run code.
for url in ["https://mac.tail1234.ts.net/", "http://localhost:8443/", "chrome://password-manager/passwords", "chrome://settings/passwords", "chrome://settings/payments", "brave://password-manager", "edge://wallet", "about:logins", "javascript:alert(1)", "data:text/html,x", "devtools://devtools/"] {
  check(urlReason(url, full) != nil, "blocked url " + url)
}
for url in ["https://www.amazon.com/", "chrome://newtab", "chrome://settings/appearance", "about:blank", "https://example.com/?next=chrome://settings/passwords", ""] {
  check(urlReason(url, full) == nil, "open url " + url)
}
check(terminalLikeApp("com.apple.Terminal", "Terminal", "/System/Applications/Utilities/Terminal.app", full), "terminal is terminal-like")
check(terminalLikeApp("com.microsoft.VSCode", "Code", "/Applications/Visual Studio Code.app", full), "an IDE is terminal-like")
check(!terminalLikeApp("com.google.Chrome", "Google Chrome", "/Applications/Google Chrome.app", full), "a browser is not")
check(mentionsReach("com.reach.app", full) && mentionsReach("Reach — node", full) && !mentionsReach("preacher", full) && !mentionsReach("outreach", full), "reach as a word")
// Secure fields allow navigation, never typing, deletion or Command shortcuts.
for key in ["tab", "escape", "esc", "return", "enter", "left", "right", "up", "down"] {
  check(secureKeyAllowed(key, false), "secure field keeps navigation " + key)
  check(!secureKeyAllowed(key, true), "secure field refuses Command shortcut " + key)
}
for key in ["v", "a", "x", "c", "z", "delete", "backspace", "forwarddelete", "space", "1"] {
  check(!secureKeyAllowed(key, false), "secure field refuses content key " + key)
  check(!secureKeyAllowed(key, true), "secure field refuses Command content key " + key)
}
print("OK")
`;
    await fs.writeFile(path.join(directory, "policy.swift"), "import Foundation\n" + policy);
    await fs.writeFile(path.join(directory, "main.swift"), checks);
    const compiled = spawnSync("xcrun", ["swiftc", "-O", "policy.swift", "main.swift", "-o", "policy"], { cwd: directory, encoding: "utf8", timeout: 180000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(path.join(directory, "policy"), [], { encoding: "utf8", timeout: 30000 });
    assert.equal(run.stdout.trim(), "OK", `${run.stdout}\n${run.stderr}`);
    assert.equal(run.status, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
