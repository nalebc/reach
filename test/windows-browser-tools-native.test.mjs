// Saved browser tools on real Windows (docs/parity/G-browser-tools.md): the
// native host built with csc and registered in HKCU as Reach registers it,
// real Chrome and real Edge each started with a fresh profile and Reach's
// unpacked extension, paired with the owner's approval, then a saved tool
// replayed and batched through createAgentTools against a local HTTPS page,
// and the Mac's refusals. A public-looking name maps to 127.0.0.1 in the test
// browser only (--host-resolver-rules); its certificate is made here and
// ignored by that browser. The agent desktop helper's own browser-check is in
// windows-agent-desktop-native; here a stand-in admits the browser.
// Elsewhere, or without REACH_TEST_WINDOWS_DESKTOP, it's skipped. What it saw
// goes to reports/windows-browser-tools.json.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBrowserExtensionBridge } from "../server/browser-extension.mjs";
import { registerExtensionHost, registeredManifest, HOST_KEYS } from "../server/browser-extension-host.mjs";
import { createToolBrowserDriver } from "../server/tool-browser-driver.mjs";
import { createAgentTools } from "../server/agent-tools.mjs";
import { launchWithExtension } from "./helpers/extension-browser.mjs";

const run = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const skip = run ? false : "a real Windows runner only (REACH_TEST_WINDOWS_DESKTOP=1)";
const exec = promisify(execFile);
const SYSTEM32 = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { browsers: {} };
const note = () => {
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-browser-tools.json", JSON.stringify(report, null, 2));
};
const until = async (check, what, ms = 60000) => {
  for (const end = Date.now() + ms; ; await sleep(200)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
  }
};
const HOST = "tools.reach-test.example", OTHER = "other.reach-test.example";
const programFiles = process.env.ProgramFiles || "C:\\Program Files", programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const LOCAL = process.env.LOCALAPPDATA || "";
const installed = (...candidates) => candidates.find((file) => file && fs.existsSync(file));
const BROWSERS = {
  Chrome: { exe: installed(path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"), path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"), LOCAL && path.join(LOCAL, "Google", "Chrome", "Application", "chrome.exe")), bundleId: "exe:chrome.exe", name: "Google Chrome" },
  Edge: { exe: installed(path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")), bundleId: "exe:msedge.exe", name: "Microsoft Edge" },
};

let work, dataDir, bridge, server, origin, other, registered = null;
const asks = [];
const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const pages = () => ({
  "/shop": page("Test Shop", `<main><h1>Test Shop</h1><label>Item <input aria-label="Item"></label><button id="add">Add</button>
<input type="password" aria-label="Password"><a id="away" href="${other}/elsewhere">Elsewhere</a><p id="result">Ready</p></main>
<script>document.getElementById("add").onclick=()=>{document.getElementById("result").textContent="Added "+document.querySelector("[aria-label=Item]").value;};</script>`),
  "/elsewhere": page("Elsewhere", "<p>Another site</p>"),
});

test.before(async () => {
  if (!run) return;
  work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-browser-tools-")));
  dataDir = path.join(work, "data");
  fs.mkdirSync(dataDir);
  bridge = createBrowserExtensionBridge({ dataDir, onPairingRequest: (browser) => asks.push(browser) });
  await bridge.start();
  // The previous registration (none on a runner) comes back afterwards.
  registered = Object.fromEntries(await Promise.all(Object.keys(HOST_KEYS).map(async (browser) => [browser, await registeredManifest(browser)])));
  const started = Date.now();
  const host = await registerExtensionHost({ dataDir, pipe: bridge.pipe });
  report.host = { buildMs: Date.now() - started, file: host.file, manifest: JSON.parse(fs.readFileSync(host.manifest, "utf8")) };
  for (const browser of Object.keys(HOST_KEYS)) assert.equal(await registeredManifest(browser), host.manifest, `${browser}'s HKCU key names Reach's host`);
  // A certificate for the test page, made by Windows itself, nothing kept in the store.
  const pfx = path.join(work, "page.pfx");
  await exec(path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command",
    `$c = New-SelfSignedCertificate -DnsName '${HOST}','${OTHER}' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(2); ` +
    `$p = ConvertTo-SecureString -String 'reach-test' -Force -AsPlainText; Export-PfxCertificate -Cert $c -FilePath '${pfx}' -Password $p | Out-Null; ` +
    `Remove-Item ('Cert:\\CurrentUser\\My\\' + $c.Thumbprint)`], { windowsHide: true, timeout: 120000 });
  server = https.createServer({ pfx: fs.readFileSync(pfx), passphrase: "reach-test" }, (request, response) => {
    const body = pages()[new URL(request.url, "https://localhost").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(body || "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  origin = `https://${HOST}:${port}`;
  other = `https://${OTHER}:${port}`;
  report.origin = origin;
  note();
});
test.after(async () => {
  if (!run) return;
  bridge?.close();
  server?.close();
  for (const [browser, key] of Object.entries(HOST_KEYS)) {
    if (registered?.[browser]) await exec(path.join(SYSTEM32, "reg.exe"), ["add", key, "/ve", "/t", "REG_SZ", "/d", registered[browser], "/f"], { windowsHide: true }).catch(() => {});
    else await exec(path.join(SYSTEM32, "reg.exe"), ["delete", key, "/f"], { windowsHide: true }).catch(() => {});
  }
  note();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
});

const shopTool = () => ({
  protocol: "reach.tool.v1", id: "shop_add", title: "Add to test cart", description: "Add one item to the test shop cart.", origins: [origin],
  inputs: { item: { type: "string", label: "Item", maxLength: 100 } },
  steps: [
    { op: "navigate", url: `${origin}/shop` },
    { op: "wait", target: { role: "button", name: "Add" } },
    { op: "fill", target: { role: "textbox", name: "Item" }, value: { input: "item" } },
    { op: "click", target: { role: "button", name: "Add" } },
    { op: "wait", target: { css: "#result", text: "Added" } },
    { op: "read", target: { css: "#result" }, as: "result" },
  ],
});
const leaveTool = () => ({
  protocol: "reach.tool.v1", id: "shop_leave", title: "Leave the test shop", description: "Follow the link to another website.", origins: [origin], inputs: {},
  steps: [{ op: "navigate", url: `${origin}/shop` }, { op: "click", target: { css: "#away" } }],
});
const passwordTool = () => ({
  protocol: "reach.tool.v1", id: "shop_password", title: "Type a password", description: "Fill the password box.", origins: [origin], inputs: {},
  steps: [{ op: "navigate", url: `${origin}/shop` }, { op: "fill", target: { css: "input[type=password]" }, value: "hunter2" }],
});

for (const name of ["Chrome", "Edge"])
  test(`a saved tool replays in real ${name} through Reach's extension, with the Mac's refusals`, { skip: skip || (!BROWSERS[name].exe && `${name} isn't installed on this runner`), timeout: 600000 }, async (t) => {
    const seen = (report.browsers[name] = { exe: BROWSERS[name].exe });
    note();
    const exe = fs.realpathSync.native(BROWSERS[name].exe);
    const profile = fs.mkdtempSync(path.join(work, `${name.toLowerCase()}-profile-`));
    const browser = launchWithExtension(exe, {
      profile,
      extension: path.resolve("browser-extension"),
      args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1,MAP ${OTHER} 127.0.0.1`, "--ignore-certificate-errors"],
    });
    t.after(() => browser.close());
    seen.load = await browser.loadExtension();
    note();
    // The extension starts, Chrome/Edge starts Reach's host, the host reaches
    // Reach's pipe: the browser asks to connect, and waits for the owner.
    await until(() => bridge.status()[name].asking || bridge.status()[name].connected, `${name}'s extension asks to connect`, 90000);
    seen.asked = asks.includes(name);
    const driver = createToolBrowserDriver({ platform: "win32", extension: bridge });
    if (!bridge.status()[name].connected) {
      await assert.rejects(driver.transport(name, { op: "tabs" }), (e) => e.code === "setup_required", "nothing runs before the owner allows it");
      assert.equal(bridge.approve(name), 1);
    }
    await until(() => bridge.status()[name].connected, `${name} proves its secret`, 30000);
    seen.paired = true;
    const tabs = await driver.transport(name, { op: "tabs" });
    seen.tabs = tabs.length;
    assert.ok(Array.isArray(tabs));

    const app = { id: exe, name: BROWSERS[name].name, bundleId: BROWSERS[name].bundleId, running: true };
    const client = {
      id: `agent-${name}`, name: "Test agent", kind: "agent", status: "accepted", expiresAt: Date.now() + 600000,
      policy: { browser: true, preset: "apps", apps: [app], roots: [] }, scopes: ["browser:read", "browser:open", "browser:control", "browser:screen"],
    };
    const authorize = () => client;
    const checks = [];
    const desktop = {
      catalog: async (auth) => { auth(); return [app]; },
      withBrowser: async (_client, appPath, auth, work) => { checks.push(appPath); return work(async () => { auth(); }, async () => {}); },
    };
    const toolsDir = fs.mkdtempSync(path.join(work, `${name.toLowerCase()}-tools-`));
    const tools = createAgentTools({ dataDir: toolsDir }, { desktop, platform: "win32", extension: bridge, pdf: async () => "" });
    t.after(() => tools.close());
    const catalog = await tools.catalog(authorize);
    assert.deepEqual(catalog.browsers, [name]);
    await tools.define(authorize, shopTool());
    await tools.define(authorize, leaveTool());
    await tools.define(authorize, passwordTool());

    // The replay: a new tab on the shop, the item typed, Add clicked, the result read.
    const started = Date.now();
    const result = await tools.run(authorize, { id: "shop_add", browser: name, requestId: crypto.randomUUID(), values: { item: "apples" } });
    seen.run = { status: result.status, code: result.code, error: result.error, data: result.data, ms: Date.now() - started };
    note();
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.data.result, "Added apples");
    assert.ok(checks.every((check) => check === exe));

    // A batch: two tabs opened behind, each item in its own, closed after.
    const before = (await driver.transport(name, { op: "tabs" })).length;
    const batch = await tools.batch(authorize, { id: "shop_add", browser: name, requestId: crypto.randomUUID(), items: [{ item: "pears" }, { item: "plums" }] });
    seen.batch = batch;
    note();
    assert.deepEqual(batch.items.map((item) => item.status), ["completed", "completed"], JSON.stringify(batch));
    assert.deepEqual(batch.items.map((item) => item.data.result), ["Added pears", "Added plums"]);
    assert.equal((await driver.transport(name, { op: "tabs" })).length, before, "the batch's own tabs closed");

    // The Mac's refusals, here too.
    const away = await tools.run(authorize, { id: "shop_leave", browser: name, requestId: crypto.randomUUID(), values: {} });
    seen.leave = { status: away.status, code: away.code };
    assert.notEqual(away.status, "completed");
    assert.equal(away.code, "wrong_site", JSON.stringify(away));
    const secret = await tools.run(authorize, { id: "shop_password", browser: name, requestId: crypto.randomUUID(), values: {} });
    seen.password = { status: secret.status, code: secret.code };
    assert.notEqual(secret.status, "completed");
    assert.equal(secret.code, "missing", JSON.stringify(secret));
    await assert.rejects(tools.define(authorize, { ...shopTool(), id: "bank_tool", origins: ["https://www.chase.com"], steps: [{ op: "navigate", url: "https://www.chase.com/" }] }),
      (e) => e.status === 403);
    // The owner's tab: brought forward, it stays open.
    const mine = await driver.transport(name, { op: "create", url: `${origin}/shop`, background: true });
    const shown = await until(async () => {
      const info = await driver.transport(name, { op: "info", target: mine });
      return info.url === `${origin}/shop` && info;
    }, "the owner's tab loads", 30000);
    await driver.transport(name, { op: "focus", target: shown, expectedURL: shown.url });
    await assert.rejects(driver.transport(name, { op: "close", target: shown, expectedURL: shown.url, behind: true }), (e) => e.code === "owner_tab");
    seen.ownerTab = "kept";
    note();
  });
