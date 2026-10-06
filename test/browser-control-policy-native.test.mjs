import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("compiled native control policy blocks owner apps and browser URL parser bypasses without touching the desktop", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-control-policy-"));
  try {
    const source = await fs.readFile(new URL("../scripts/native/browser-app.swift", import.meta.url), "utf8");
    const policy = source.split("// BEGIN PURE CONTROL POLICY")[1]?.split("\n").slice(1).join("\n").split("// END PURE CONTROL POLICY")[0];
    assert.ok(policy);
    const blocked = [
      "https://tailscale.com", "https://login.tailscale.com/", "https://controlplane.tailscale.com/",
      "https://TAILSCALE.COM./", "https://tailscale%2ecom/", "https://%74ailscale.com/",
      "https://tailscale。com/", "https://tailscale．com/", "https://tailscale｡com/",
      "https://tailscale.io/", "https://login.tailscale.io/", "https://laptop.tail123.ts.net:8443/",
      "https://owner.reach.example/", "https://OWNER.REACH.EXAMPLE.:8443/", "https://child.owner.reach.example/",
      "https://localhost/", "http://localhost.localdomain/", "http://printer.local/", "http://mac/",
      "http://100.64.0.1/", "http://100.127.255.254/", "http://192.168.1.1/", "http://10.0.0.2/", "http://172.16.0.1/",
      "http://127.1/", "http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/", "http://0x7f.1/",
      "http://[::1]/", "https://[fd7a:115c:a1e0::1]/", "http://[::ffff:100.64.0.1]/", "http://[fe80::1%25en0]/",
      "tailscale://login", "tailscale:login", "javascript:location='https://tailscale.com'",
      "chrome://settings", "chrome://extensions", "chrome-extension://abc/", "devtools://devtools/", "safari://settings",
      "about:preferences", "file:///Applications/Tailscale.app", "view-source:https://tailscale.com/",
      "https://safe.example@tailscale.com/", "https://tailscale.com@safe.example/", "https://safe.example\\@tailscale.com/",
      "https://tailscale.com\n.safe.example/", "https://tailscale%252ecom/", "https://ＴＡＩＬＳＣＡＬＥ.com/",
      "", "unknown", "about:blank", "chrome://newtab", "https://8.8.8.8/",
    ];
    const permitted = [
      "https://example.com/", "https://www.wikipedia.org/", "https://mail.google.com/mail/u/0/#inbox",
      "https://tailscale.com.evil.example/", "https://not-tailscale.com/", "https://example.com/path?next=https://tailscale.com/",
      "https://other-reach.example/", "https://safe.example/path#tailscale.com", "https://example.com:8443/",
    ];
    const swiftString = value => JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, "\\u{$1}");
    const list = values => `[${values.map(swiftString).join(",")}]`;
    const checks = `
let hosts = ["owner.reach.example"]
func check(_ value: Bool, _ label: String) { if !value { print("FAILED: " + label); exit(1) } }
for value in ${list(blocked)} { check(protectedURL(value, hosts), "blocked URL " + value) }
for value in ${list(permitted)} { check(!protectedURL(value, hosts), "public URL " + value) }
for value in ${list(["tailscale.com", "TAILSCALE.COM.", "//login.tailscale.com", "owner.reach.example:8443/", "100.64.0.1", "127.1", "[::1]", "javascript:alert(1)", "chrome://settings", "localhost"])} {
  check(protectedURL(value, hosts, requireAddress:false), "pending address " + value)
}
check(!protectedURL("search for weather", hosts, requireAddress:false), "ordinary search")
check(!protectedURL("example.com", hosts, requireAddress:false), "public address without scheme")
check(!browserPageAllowed([], hosts), "unknown page address fails closed")
check(!browserPageAllowed(["https://example.com", "https://login.tailscale.com"], hosts), "protected embedded page")
check(browserPageAllowed(["https://example.com"], hosts), "public page")
check(!webAreaAllowed(hidden:false, intersects:true, address:nil, hosts:hosts), "visible web area with unknown URL despite allowed document")
check(!webAreaAllowed(hidden:false, intersects:nil, address:"https://example.com", hosts:hosts), "web area with unknown geometry despite allowed document")
check(!webAreaAllowed(hidden:false, intersects:nil, address:nil, hosts:hosts), "opaque web area")
check(!webAreaAllowed(hidden:false, intersects:true, address:"https://tailscale.com", hosts:hosts), "visible protected embedded page")
check(webAreaAllowed(hidden:true, intersects:nil, address:nil, hosts:hosts), "definitely hidden web area")
check(webAreaAllowed(hidden:false, intersects:false, address:nil, hosts:hosts), "definitely offscreen web area")
check(webAreaAllowed(hidden:false, intersects:true, address:"https://example.com", hosts:hosts), "known visible public web area")
for value in ["com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary", "org.mozilla.firefox", "com.brave.Browser"] {
  check(browserApp(value), "known browser " + value)
  check(!browserPageAllowed([], hosts), "unknown/private-window address " + value)
}
for value in ["io.tailscale.ipn.macsys", "io.tailscale.ipn.macos", "com.tailscale.ipn", "io.tailscale", "com.tailscale"] {
  check(appReason(value, "Renamed", "/Applications/Renamed.app") == ownerControlsReason, "signed protected app " + value)
}
for name in ["Reach", "Tailscale", "Tailnet client"] {
  check(appReason("org.example.renamed", name, "/Applications/Example.app") == ownerControlsReason, "protected app name " + name)
  check(protectedWindow(name), "protected window " + name)
}
check(appReason("com.apple.Safari", "Safari", "/Applications/Safari.app") == nil, "ordinary signed browser")
let assembled = insertedValue("https://tailscale.co", 20, 0, "m")!
check(assembled == "https://tailscale.com" && protectedURL(assembled, hosts, requireAddress:false), "partial address insertion")
let replaced = insertedValue("https://example.com", 8, 7, "tailscale")!
check(replaced == "https://tailscale.com" && protectedURL(replaced, hosts, requireAddress:false), "selected address replacement")
check(insertedValue("short", 6, 0, "x") == nil, "invalid cursor")
check(insertedValue("short", 0, Int.max, "x") == nil, "overflow length")
print("Native control policy checks passed")
`;
    const main = path.join(directory, "main.swift"), binary = path.join(directory, "control-policy");
    await fs.writeFile(main, "import Foundation\nimport Darwin\n" + policy + checks);
    const build = spawnSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(os.tmpdir(), "reach-browser-app-swift-cache"), main, "-o", binary], {
      encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
    });
    assert.equal(build.status, 0, build.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Native control policy checks passed/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
