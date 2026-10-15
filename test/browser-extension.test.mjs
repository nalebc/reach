// Reach's Chrome and Edge extension (browser-extension/, docs/parity/G-browser-tools.md):
// what it is allowed, what it runs in pages, and its store package.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pageRuntimeSource, storeManifest, storePackage, PACKAGE_FILES, extensionDir } from "../scripts/build-browser-extension.mjs";
import { REPO_EXTENSION_ID, NATIVE_HOST } from "../server/browser-extension-ids.mjs";
import { hostManifest } from "../server/browser-extension-host.mjs";

const read = (name) => fs.readFileSync(path.join(extensionDir, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("the page interpreter it ships is the server's own, generated, never edited by hand", () => {
  // A Windows checkout may turn its line ends into CRLF; the code is the same.
  assert.equal(read("page-runtime.js").replace(/\r\n/g, "\n"), pageRuntimeSource(), "run: node scripts/build-browser-extension.mjs");
});

test("the manifest asks for the minimum: native messaging, scripting, storage, alarms, https sites", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["nativeMessaging", "scripting", "storage", "alarms"]);
  assert.deepEqual(manifest.host_permissions, ["https://*/*"]);
  for (const key of ["content_scripts", "optional_permissions", "optional_host_permissions", "externally_connectable", "web_accessible_resources", "content_security_policy", "update_url"])
    assert.equal(manifest[key], undefined, key);
  assert.equal(manifest.incognito, "not_allowed");
  assert.deepEqual(manifest.background, { service_worker: "service-worker.js" });
  // The repo build's id comes from its key.
  const der = Buffer.from(manifest.key, "base64");
  const id = [...crypto.createHash("sha256").update(der).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  assert.equal(id, REPO_EXTENSION_ID);
  for (const size of ["16", "32", "48", "128"]) assert.ok(fs.statSync(path.join(extensionDir, manifest.icons[size])).size > 0);
});

test("no code from anywhere but the package: no eval, no Function, no remote scripts, one host", () => {
  for (const name of ["service-worker.js", "reach-extension.js", "page-runtime.js"]) {
    const text = read(name);
    assert.doesNotMatch(text, /\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(|setTimeout\(\s*["'`]|importScripts\(\s*["'`]https?:/, name);
    assert.doesNotMatch(text, /https?:\/\/(?!\*)/, `${name} names no remote address`);
  }
  const worker = read("service-worker.js");
  assert.match(worker, /importScripts\("page-runtime\.js", "reach-extension\.js"\)/);
  const bridge = read("reach-extension.js");
  assert.match(bridge, new RegExp(`const HOST = "${NATIVE_HOST.replace(/\./g, "\\.")}"`));
  // Every script injection: the top frame, the isolated world, a function from the package.
  const injections = bridge.match(/chrome\.scripting\.executeScript\([^)]*\)/g);
  assert.equal(injections.length, 1);
  assert.match(injections[0], /frameIds: \[0\] \}, world: "ISOLATED", func, args/);
  assert.match(bridge, /inPage\(tab, runtime, \[request\.request\]\)/);
  assert.match(bridge, /inPage\(tab, boundDocument, \[\]\)/);
  assert.equal((bridge.match(/inPage\(/g) || []).length, 4, "the definition and three fixed calls");
  // Nothing runs before Reach proved the secret.
  assert.match(bridge, /if \(!trusted\)\s*\n\s*return send\(\{ type: "response", id: message\.id, raw: JSON\.stringify\(\{ error: "Reach has not proven itself to this browser\.", code: "setup_required"/);
});

test("the store package holds only the extension's files, without the repo build's key", () => {
  const zip = storePackage();
  const entries = [];
  let at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(at + 10);
  at = zip.readUInt32LE(at + 16);
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28), offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString();
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    entries.push([name, zlib.inflateRawSync(zip.subarray(start, start + size))]);
    at += 46 + nameLength;
  }
  assert.deepEqual(entries.map(([name]) => name), PACKAGE_FILES);
  const packed = JSON.parse(entries.find(([name]) => name === "manifest.json")[1].toString());
  assert.equal(packed.key, undefined);
  assert.deepEqual(packed, JSON.parse(storeManifest()));
  assert.equal(entries.find(([name]) => name === "page-runtime.js")[1].toString(), pageRuntimeSource());
  assert.deepEqual(storePackage(), zip, "the same input gives the same bytes");
});

test("the native host's manifest lets only Reach's extension ids start it", () => {
  const host = hostManifest("C:\\Users\\o\\AppData\\reach\\browser-host\\reach-browser-host-abc.exe", [REPO_EXTENSION_ID]);
  assert.deepEqual(hostManifest("C:\\x.exe").allowed_origins, [], "production: none until the stores' ids are filled in");
  assert.deepEqual(host, {
    name: NATIVE_HOST,
    description: "Reach: saved browser tools for this computer's Reach",
    path: "C:\\Users\\o\\AppData\\reach\\browser-host\\reach-browser-host-abc.exe",
    type: "stdio",
    allowed_origins: [`chrome-extension://${REPO_EXTENSION_ID}/`],
  });
});
