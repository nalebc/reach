import { spawn } from "node:child_process";
import path from "node:path";
import { desktopBinary } from "./desktop-native.mjs";
import { fail, isPlainRecord } from "./core.mjs";
import { protectBrowserApp, protectedBrowserAppReason, isolatedControlReason } from "./browser-protected-apps.mjs";

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_INPUT = 64 * 1024;

function appId(value) {
  if (typeof value !== "string" || value.length > 4096 || !path.isAbsolute(value) ||
      !value.endsWith(".app") || /[\x00-\x1f\x7f]/.test(value) || path.normalize(value) !== value)
    throw fail(400, "Choose a valid app on this Mac.");
  return value;
}

function target(value) {
  if (!isPlainRecord(value) || !Number.isSafeInteger(value.windowId) || value.windowId < 1 ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2147483647 ||
      typeof value.instance !== "string" || !/^[a-f0-9]{64}$/.test(value.instance) ||
      typeof value.identity !== "string" || !/^[a-f0-9]{64}$/.test(value.identity) ||
      ![value.width, value.height].every(n => typeof n === "number" && Number.isFinite(n) && n >= 16 && n <= 32768))
    throw fail(400, "Choose a current app window.");
  return { appId: appId(value.appId), windowId: value.windowId, pid: value.pid, instance: value.instance,
    identity: value.identity, width: value.width, height: value.height };
}

function action(value) {
  if (!isPlainRecord(value)) throw fail(400, "Choose a supported app action.");
  if (value.type === "click" && Object.keys(value).every(k => ["type", "x", "y"].includes(k)) &&
      [value.x, value.y].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1))
    return { type: "click", x: value.x, y: value.y };
  if (value.type === "text" && Object.keys(value).every(k => ["type", "text"].includes(k)) &&
      typeof value.text === "string" && value.text.length > 0 && value.text.length <= 8192 &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text))
    return { type: "text", text: value.text };
  if (value.type === "key" && Object.keys(value).every(k => ["type", "key"].includes(k)) &&
      ["enter", "tab", "backspace", "escape", "left", "right", "up", "down"].includes(value.key))
    return { type: "key", key: value.key };
  if (value.type === "scroll" && Object.keys(value).every(k => ["type", "direction", "amount"].includes(k)) &&
      ["up", "down"].includes(value.direction) && Number.isInteger(value.amount) && value.amount >= 1 && value.amount <= 5)
    return { type: "scroll", direction: value.direction, amount: value.amount };
  throw fail(400, "This input is not supported in a shared app window.");
}

// One isolated helper request. There is deliberately no desktop-input fallback.
function check(authorize, signal) {
  if (signal?.aborted || authorize() === false) throw fail(403, "This app session has ended or access was revoked.");
}

async function runNative(config, request, authorize, signal) {
  check(authorize, signal);
  if (process.platform !== "darwin") throw fail(501, "Protected app sharing requires macOS 14.2 or later.");
  const binary = await desktopBinary(config, "browser-app");
  check(authorize, signal);
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > MAX_INPUT) throw fail(400, "This app request is too large.");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks = [];
    let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      signal?.removeEventListener("abort", abort);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(fail(503, "The app did not respond. Refresh its window before trying again.")), 15000);
    const watch = setInterval(() => {
      try { check(authorize, signal); } catch (error) { finish(error); }
    }, 50);
    const abort = () => finish(fail(403, "This app session has ended or access was revoked."));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT) return finish(fail(503, "The app response was too large."));
      chunks.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish(fail(503, "The protected app helper disconnected.")));
    child.on("error", () => finish(fail(503, "The protected app helper could not start.")));
    child.on("close", code => {
      if (settled) return;
      try { check(authorize, signal); } catch (error) { return finish(error); }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!isPlainRecord(value)) throw new Error();
        if (value.error) return finish(fail(403, String(value.error).slice(0, 300)));
        if (code !== 0) throw new Error();
        finish(null, value);
      } catch { finish(fail(503, "The protected app helper returned an invalid response.")); }
    });
    child.stdin.end(body + "\n");
  });
}

// Only server configuration contributes owner-control hosts. Guest request fields
// cannot remove these restrictions, even when a caller passes extra keys.
function protectedHosts(config) {
  const origins = [config.publicOrigin, ...(Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [])];
  const hosts = new Set();
  for (const origin of origins) {
    if (typeof origin !== "string" || !origin) continue;
    let parsed;
    try { parsed = new URL(origin); } catch { throw fail(503, "A protected Reach origin is invalid."); }
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw fail(503, "A protected Reach origin is invalid.");
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    if (host.length > 253) throw fail(503, "A protected Reach origin is invalid.");
    hosts.add(host);
  }
  if (hosts.size > 64) throw fail(503, "Too many protected Reach origins.");
  return Object.freeze([...hosts]);
}

export class BrowserAppNative {
  #protectedHosts;
  constructor(config, { run = (request, authorize, signal) => runNative(config, request, authorize, signal) } = {}) {
    this.run = run;
    this.#protectedHosts = protectedHosts(config);
    this.catalogCache = null;
    this.catalogPending = null;
  }
  async call(request, authorize = () => {}, signal) {
    check(authorize, signal);
    if (request.op === "input") throw fail(403, isolatedControlReason);
    if (request.appId) {
      const reason = protectedBrowserAppReason({id:request.appId});
      if (reason) throw fail(403, reason);
    }
    const value = await this.run({ ...request, protectedHosts: [...this.#protectedHosts] }, authorize, signal);
    check(authorize, signal);
    return value;
  }
  async catalog(authorize = () => {}, signal) {
    check(authorize, signal);
    if (this.catalogCache?.expires > Date.now()) return structuredClone(this.catalogCache.value);
    if (!this.catalogPending) {
      this.catalogPending = this.call({ op: "list" }, authorize, signal).finally(() => { this.catalogPending = null; });
    }
    const value = await this.catalogPending;
    check(authorize, signal);
    if (!Array.isArray(value?.apps) || value.apps.length > 1024 || value.apps.some(app =>
      !isPlainRecord(app) || typeof app.id !== "string" || typeof app.name !== "string" ||
      typeof app.bundleId !== "string" || typeof app.protected !== "boolean" ||
      (!app.protected && (typeof app.identity !== "string" || !/^[a-f0-9]{64}$/.test(app.identity)))))
      throw fail(503, "The app list is unavailable.");
    // Discovery metadata only. Grants and each native operation check live
    // signed identity independently; no capture/input authorization is cached.
    const protectedValue = { ...value, apps: value.apps.map(protectBrowserApp) };
    this.catalogCache = { value: structuredClone(protectedValue), expires: Date.now() + 60000 };
    return structuredClone(protectedValue);
  }
  async windows(id, authorize = () => {}, identity, signal) {
    if (typeof identity !== "string" || !/^[a-f0-9]{64}$/.test(identity)) throw fail(400, "Choose an approved signed app.");
    const value = await this.call({ op: "windows", appId: appId(id), identity }, authorize, signal);
    if (!Array.isArray(value?.windows) || value.windows.length > 100 || value.windows.some(window =>
      !Number.isSafeInteger(window.id) || window.id < 1 || !Number.isSafeInteger(window.pid) || window.pid < 1 ||
      typeof window.instance !== "string" || !/^[a-f0-9]{64}$/.test(window.instance) ||
      window.identity !== identity ||
      typeof window.title !== "string" || !Number.isFinite(window.width) || !Number.isFinite(window.height) ||
      window.width < 1 || window.height < 1)) throw fail(503, "The app windows are unavailable.");
    return value;
  }
  async capture(value, authorize = () => {}, signal) {
    const result = await this.call({ op: "capture", ...target(value) }, authorize, signal);
    if (typeof result?.jpeg !== "string" || result.jpeg.length > MAX_OUTPUT || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.jpeg) ||
      !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1 ||
      result.width > 4096 || result.height > 4096) throw fail(503, "The protected app image is unavailable.");
    return result;
  }
  async input(value, input, authorize = () => {}, signal) {
    const result = await this.call({ op: "input", ...target(value), action: action(input) }, authorize, signal);
    if (result?.done !== true) throw fail(503, "The app could not confirm this action. Refresh its window.");
    return result;
  }
}
