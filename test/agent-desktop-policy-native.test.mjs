import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeRules, protectedPage } from "../server/agent-guard.mjs";

// The exact same corpus runs against JavaScript and the compiled Swift policy.
const reachUrlCases = [
  ["https://example.com/help/mac.tail1234.ts.net", false],
  ["https://example.com/search?q=localhost:8443", false],
  ["https://example.com/#https://mac.tail1234.ts.net/", false],
  ["https://example.com:443/?next=localhost:8443", false],
  ["https://user:pass@example.com/mac.tail1234.ts.net", false],
  ["http://127.0.0.2:8443/?next=localhost:8443", false],
  ["http://[::2]:8443/?next=localhost:8443", false],
  ["https://example.com./?next=localhost:8443", false],
  ["https://example.com/%20?next=localhost:8443", false],
  ["https://example.com/?price=$5&next=localhost:8443", false],
  ["https://mac.tail1234.ts.net/", true], ["http://localhost:8443/", true],
  ["https://mac.tail1234.ts.net@ordinary.test/", true],
  ["https://ordinary.test@mac.tail1234.ts.net/", true],
  ["https://mac.tail1234.ts.net.evil.test/", true], ["http://localhost:84430/", true],
  ["https://mac.tail1234.ts.net./", true], ["example.com/help/mac.tail1234.ts.net", true],
  ["//example.com/?next=localhost:8443", true], ["ftp://example.com/mac.tail1234.ts.net", true],
  ["https:///example.com/?next=localhost:8443", true],
  ["https://example.com:65536/?next=localhost:8443", true],
  ["https://example.com:bad/?next=localhost:8443", true],
  ["https://example.com/%zz?next=localhost:8443", true],
  ["https://%65xample.com/?next=localhost:8443", true],
  ["https://example.com/space here?next=localhost:8443", true],
  ["https://example.com/\t?next=localhost:8443", true],
  [String.raw`https://example.com\@localhost:8443/`, true],
  ["https://例子.example/?next=localhost:8443", true],
  ["http://127.1/?next=localhost:8443", true], ["http://2130706433/?next=localhost:8443", true],
  ["http://256.1/?next=localhost:8443", true], ["http://[::::]/?next=localhost:8443", true],
  ["http://[1:2:3]/?next=localhost:8443", true],
  ['https://example.com/"localhost:8443"', true],
  ["https://example.com/'localhost:8443'", true],
  ["https://example.com/\u202e?next=localhost:8443", true],
];
test("JavaScript Reach URL policy covers the shared native authority corpus", () => {
  for (const [url, blocked] of reachUrlCases)
    assert.equal(protectedPage(url, ["mac.tail1234.ts.net", "localhost:8443"]), blocked, url);
});

test("the helper never names an app the owner hid (audit L6)", async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const front = source.split("func front(")[1].split("\nfunc ")[0];
  assert.match(front, /if blocked == hiddenReason \{\n\s+return \["ok": true, "app": "", "bundle": "", "title": ""/);
});

test("a numbered press re-finds its control; press and fill go through the same checks; vault values are hidden", async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const perform = source.split("func perform(")[1].split("\n@available")[0];
  assert.match(perform, /case "element":[\s\S]*?readScreen\(rules, text: false\)[\s\S]*?clickControl\(control, in: screen/);
  assert.match(perform, /case "press":[\s\S]*?findControl\(candidates, name: wanted, role: action\["role"\] as\? String\)/);
  assert.match(perform, /case "fill":[\s\S]*?if rules\.mode != "full", control\.secure && !secret \{ try refuse\(secureReason\) \}[\s\S]*?\["type": "type", "text": text\]/);
  assert.match(perform, /if secret \|\| target\.element\.secure \{ rememberSecret\(text\) \}/, "a vault value typed is remembered");
  assert.match(source.split("func readScreen(")[1].split("\nfunc elements(")[0], /hideSecrets\(String\(words\.prefix\(300\)\), typedSecrets\)[\s\S]*hideSecrets\(String\(value\.prefix\(120\)\), typedSecrets\)/, "text and field values");
  assert.match(source.split("func shot(")[1], /redacted\(image, rules\)/, "and screenshots");
});

test("selected-app screenshots preserve the protected-window exclusions", async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const screenshot = source.split("func shot(")[1].split("func catalog(")[0];
  assert.match(screenshot, /windowTitleReason\(window\.title/);
  assert.match(screenshot, /including: apps, exceptingWindows: excluded/);
  assert.match(screenshot, /excludingWindows: excluded/);
  assert.doesNotMatch(screenshot, /exceptingWindows: \[\]/);
});

test("all native title decisions share the verified Mail identity wrapper", async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const production = source.split("// END PURE DESKTOP POLICY")[1];
  assert.equal((production.match(/\btitleReason\(/g) || []).length, 1, "only the wrapper calls pure title policy");
  assert.match(production, /titleReason\(title, bundleId, rules, verifiedMail: trustedMailIdentity\(pid, bundleId, path\)\)/);
  for (const name of ["check", "hostsReach", "shot", "front"]) {
    const body = production.split(`func ${name}(`)[1]?.split("\nfunc ")[0];
    assert.ok(body?.includes("windowTitleReason("), `${name} must share the identity-gated title policy`);
  }
  const check = production.split("func check(")[1].split("\n}")[0];
  assert.match(check, /appReason[\s\S]*windowTitleReason[\s\S]*urlReason/);
  assert.match(production, /var s = Seen\(pid: pidOf\(element\)\)/);
  assert.match(production, /var s = Seen\(pid: pid\)/);
});

test("secure-field key checks use the tested native policy only for secure targets", async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const keyHandler = source.split('case "key":')[1].split('default:')[0];
  assert.match(keyHandler, /if rules\.mode != "full", target\.element\.secure, !secureKeyAllowed\(name, command\) \{ try refuse\(secureReason\) \}/);
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
    const identity = source.split("// BEGIN NATIVE MAIL IDENTITY")[1]?.split("\n").slice(1).join("\n").split("// END NATIVE MAIL IDENTITY")[0];
    assert.ok(identity);
    assert.doesNotMatch(identity, /AppKit|AXUIElement|NSWorkspace/);
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
${build("restricted", rules("readonly", { hidden: [{ id: "/System/Applications/Messages.app", bundleId: "com.apple.MobileSMS", name: "Messages" }] }))}
${build("apps", rules("apps", { apps: [chrome] }))}
${build("view", rules("readonly"))}
${build("full", rules("full"))}
func check(_ value: Bool, _ label: String) { if !value { print("FAILED: " + label); exit(1) } }
// Full control bypasses content restrictions; narrow presets keep them.
for title in ["nalebc/reach · GitHub", "Reach", "Password Manager", "DevTools", "Privacy & Security"] {
  check(titleReason(title, "com.google.Chrome", full) == nil, "full allows " + title)
}
for url in ["https://mac.tail1234.ts.net/", "chrome://password-manager/passwords", "devtools://devtools/"] {
  check(urlReason(url, full) == nil, "full allows " + url)
}
check(appReason("com.apple.keychainaccess", "Keychain Access", "", full) == nil, "full allows password apps")
check(appReason("io.tailscale.ipn.macos", "Tailscale", "", full) == nil, "full allows Tailscale")
check(appReason("com.reach.app", "Reach", "", full) == nil, "full allows Reach")
// Restricted presets retain protected targets.
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
  check(appReason(bundle, name, path, restricted) != nil, "restricted protects " + name + path)
  check(appReason(bundle, name, path, apps) != nil, "apps protects " + name + path)
  check(appReason(bundle, name, path, view) != nil, "view protects " + name + path)
}
check(appReason("com.apple.keychainaccess", "x", "", restricted) == protectedReason, "protected reason")
check(appReason("io.tailscale.ipn.macos", "Tailscale", "", restricted) == reachReason, "reach reason")
// Full control: browsers, terminals and ordinary apps are open; hidden apps are not.
for (bundle, name) in [("com.google.Chrome", "Google Chrome"), ("com.apple.Safari", "Safari"), ("com.apple.Terminal", "Terminal"), ("com.apple.finder", "Finder"), ("com.apple.mail", "Mail"), ("com.example.Preacher", "Preacher"), ("com.apple.systempreferences", "System Settings")] {
  check(appReason(bundle, name, "/Applications/" + name + ".app", restricted) == nil, "restricted allows " + name)
}
check(appReason("com.apple.MobileSMS", "Messages", "/System/Applications/Messages.app", restricted) == hiddenReason, "hidden app by bundle")
check(appReason("com.other.Messenger", "Messages", "/Applications/Other.app", restricted) == hiddenReason, "hidden app by name")
// Apps preset: the chosen apps only, matched by bundle id or path.
check(appReason("com.google.Chrome", "Google Chrome", "/Applications/Google Chrome.app", apps) == nil, "apps allows chosen bundle")
check(appReason("", "", "/Applications/Google Chrome.app", apps) == nil, "apps allows chosen path")
check(appReason("com.apple.Safari", "Safari", "/Applications/Safari.app", apps) == notAllowedReason, "apps refuses other browsers")
check(appReason("com.apple.finder", "Finder", "", apps) == notAllowedReason, "apps refuses Finder")
check(appReason("com.google.Chrome.helper", "Google Chrome Helper", "", apps) == notAllowedReason, "a helper process with a longer bundle id is not the app")
// Titles: Reach's windows, privacy panes, developer tools and password pages.
check(titleReason("reach — node — 80x24", "com.apple.Terminal", restricted) == reachReason, "Reach terminal title")
check(titleReason("Reach", "com.google.Chrome", restricted) == reachReason, "Reach tab title")
check(titleReason("Reach", "com.google.Chrome", apps) == reachReason, "selected Chrome still hides Reach")
check(titleReason("Password Manager", "com.google.Chrome", apps) == protectedReason, "selected Chrome still hides password windows")
check(titleReason("Preacher notes", "com.apple.Notes", restricted) == nil, "Preacher is not Reach")
check(titleReason("Privacy & Security", "com.apple.systempreferences", restricted) == protectedReason, "privacy pane")
check(titleReason("Displays", "com.apple.systempreferences", restricted) == nil, "displays pane")
check(titleReason("Privacy & Security", "com.google.Chrome", restricted) == nil, "a page about privacy is a page")
check(titleReason("DevTools - amazon.com", "com.google.Chrome", restricted) == protectedReason, "devtools")
check(titleReason("Password Manager", "com.google.Chrome", restricted) == protectedReason, "password manager")
check(titleReason("Passwords", "com.apple.Safari", restricted) == protectedReason, "Safari passwords pane")
check(titleReason("Reset your passwords - Help Center", "com.google.Chrome", restricted) == nil, "an article about passwords")
check(titleReason("Force Quit Applications", "com.apple.loginwindow", restricted) == protectedReason, "force quit")
check(titleReason("", "com.google.Chrome", restricted) == nil, "no title")
// Mail content titles need exact metadata and separately verified running code.
check(mailIdentityCandidate("com.apple.mail", "/System/Applications/Mail.app"), "exact Mail metadata")
for (bundle, path) in [("com.example.mail", "/System/Applications/Mail.app"), ("com.apple.mail", "/Applications/Mail.app"), ("com.apple.mail", "/tmp/Mail.app"), ("com.apple.mail", ""), ("", "/System/Applications/Mail.app")] {
  check(!mailIdentityCandidate(bundle, path), "Mail metadata rejects spoof or missing identity")
  check(!trustedMailIdentity(getpid(), bundle, path), "native identity fails closed for wrong metadata")
}
check(!trustedMailIdentity(0, "com.apple.mail", "/System/Applications/Mail.app"), "missing process fails closed")
check(!trustedMailIdentity(-1, "com.apple.mail", "/System/Applications/Mail.app"), "invalid process fails closed")
// The compiled fixture itself is not Apple's Mail. This executes the real
// Security API failure path, without launching or inspecting a user's app.
check(!trustedMailIdentity(getpid(), "com.apple.mail", "/System/Applications/Mail.app"), "test process cannot impersonate signed Mail")
for title in ["Reach out to Alice tomorrow", "Order confirmation: replacement keychain"] {
  check(titleReason(title, "com.apple.mail", restricted, verifiedMail: true) == nil, "verified Mail allows subject " + title)
  check(titleReason(title, "com.apple.mail", apps, verifiedMail: true) == nil, "title context is consistent across presets")
  check(titleReason(title, "com.apple.mail", view, verifiedMail: true) == nil, "view uses the same title context")
  check(titleReason(title, "com.apple.mail", restricted) != nil, "unknown signing retains refusal " + title)
  check(titleReason(title, "com.google.Chrome", restricted, verifiedMail: true) != nil, "Mail context cannot exempt another app")
}
for title in ["Keychain", "Keychain Access", "Unlock your keychain", "Enter the keychain password", "Keychain authentication", "Password Manager", "Saved passwords", "Web Inspector"] {
  check(titleReason(title, "com.apple.mail", restricted, verifiedMail: true) == protectedReason, "verified Mail preserves sensitive title " + title)
}
check(titleReason("Web Inspector tutorial - Example", "com.google.Chrome", restricted) == protectedReason, "no generic browser title relaxation")
var hiddenMail = restricted
hiddenMail.hiddenApps = [["bundleId": "com.apple.mail", "id": "/System/Applications/Mail.app"]]
check(appReason("com.apple.mail", "Mail", "/System/Applications/Mail.app", hiddenMail) == hiddenReason, "Mail title exception cannot override hidden app")
check(appReason("com.apple.mail", "Mail", "/System/Applications/Mail.app", apps) == notAllowedReason, "Mail title exception cannot override selected app")
// Addresses: Reach's own, and the pages that reveal passwords or run code.
for url in ["https://mac.tail1234.ts.net/", "http://localhost:8443/", "chrome://password-manager/passwords", "chrome://settings/passwords", "chrome://settings/payments", "brave://password-manager", "edge://wallet", "about:logins", "javascript:alert(1)", "data:text/html,x", "devtools://devtools/"] {
  check(urlReason(url, restricted) != nil, "blocked url " + url)
}
for url in ["https://www.amazon.com/", "chrome://newtab", "chrome://settings/appearance", "about:blank", "https://example.com/?next=chrome://settings/passwords", ""] {
  check(urlReason(url, restricted) == nil, "open url " + url)
}
for (url, blocked) in [${reachUrlCases.map(([url, blocked]) => `(${swift(url)}, ${blocked})`).join(",")} ] {
  check((urlReason(url, restricted) != nil) == blocked, "HTTP authority parity: " + url)
}
check(terminalLikeApp("com.apple.Terminal", "Terminal", "/System/Applications/Utilities/Terminal.app", restricted), "terminal is terminal-like")
check(terminalLikeApp("com.microsoft.VSCode", "Code", "/Applications/Visual Studio Code.app", restricted), "an IDE is terminal-like")
check(!terminalLikeApp("com.google.Chrome", "Google Chrome", "/Applications/Google Chrome.app", restricted), "a browser is not")
check(mentionsReach("com.reach.app", restricted) && mentionsReach("Reach — node", restricted) && !mentionsReach("preacher", restricted) && !mentionsReach("outreach", restricted), "reach as a word")
// Secure fields allow navigation, never typing, deletion or Command shortcuts.
for key in ["tab", "escape", "esc", "return", "enter", "left", "right", "up", "down"] {
  check(secureKeyAllowed(key, false), "secure field keeps navigation " + key)
  check(!secureKeyAllowed(key, true), "secure field refuses Command shortcut " + key)
}
for key in ["v", "a", "x", "c", "z", "delete", "backspace", "forwarddelete", "space", "1"] {
  check(!secureKeyAllowed(key, false), "secure field refuses content key " + key)
  check(!secureKeyAllowed(key, true), "secure field refuses Command content key " + key)
}
// A numbered control covered since the agent looked (1 window, 10 its
// button, 11 the button's label, 12 a card link beside it on the same page;
// 2 a dialog over it, 20 the dialog's button; 300 another app's window).
let parents: [Int: Int] = [11: 10, 10: 1, 12: 1, 20: 2, 2: 1]
let up: (Int) -> Int? = { parents[$0] }
let app: (Int) -> Int = { $0 >= 300 ? 2 : 1 }
let covered = { (hit: Int, target: Int) in
  coveredControl(hit, target, parent: up, equal: ==, sameApp: { app($0) == app($1) }, overlay: { $0 == 2 }) }
check(!covered(10, 10), "the control itself")
check(!covered(11, 10), "the control's own label")
check(!covered(1, 10), "the window that holds it, nothing over it")
check(!covered(12, 10), "a link of the same page takes the click, as a real one would")
check(covered(20, 10), "a dialog's button over it")
check(covered(2, 10), "a dialog over it")
check(covered(300, 10), "another app's window over it")
// Naming a control: the same name, then one starting with it, then one
// containing it; spacing and case don't matter.
check(nameMatch("Add to cart", "add to cart") == 3 && nameMatch("Add to cart", "Add") == 2 && nameMatch("Add to cart", "cart") == 1, "name grades")
check(nameMatch("Add to cart", "remove") == 0 && nameMatch("", "x") == 0 && nameMatch("x", "") == 0, "no match, nothing named")
check(nameMatch("  Sign   in ", "sign in") == 3, "spacing and case")
// Picking among matches: the best grade; among equals, the clearly nearest.
check(pickControl([(grade: 2, distance: Double.infinity), (grade: 3, distance: Double.infinity), (grade: 1, distance: Double.infinity)]).index == 1, "the best grade")
let twins = pickControl([(grade: 3, distance: Double.infinity), (grade: 3, distance: Double.infinity)])
check(twins.index == nil && twins.candidates == 2, "two the same, nowhere in particular: the agent says which")
check(pickControl([(grade: 3, distance: 300), (grade: 3, distance: 4)]).index == 1, "the one where it was")
check(pickControl([(grade: 3, distance: 10), (grade: 3, distance: 20)]).index == nil, "two about as near: ambiguous")
check(pickControl([(grade: 0, distance: 1), (grade: 0, distance: 2)]).index == nil && pickControl([(grade: 0, distance: 1)]).candidates == 0, "nothing matches")
// What the agent typed from its vault never comes back to it.
check(hideSecrets("Signed in as jane@example.com", ["jane@example.com"]) == "Signed in as •••", "a vault value in text")
check(hideSecrets("JANE@EXAMPLE.COM", ["jane@example.com"]) == "•••", "whatever its case")
check(hideSecrets("ab", ["ab"]) == "ab" && hideSecrets("Add to cart", ["x"]) == "Add to cart", "short values and other text left alone")
print("OK")
`;
    await fs.writeFile(path.join(directory, "policy.swift"), "import Foundation\nimport Security\n" + policy + "\n" + identity);
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
