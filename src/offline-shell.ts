import { parseStartConfig, type StartConfig } from "./start-flow";
import { guestPeers, readPrivatePeers, type Device, type Peer } from "./api";
import { browserNodeIdentityCurrent, browserPeerEligible } from "./browser-node";
import { nativeTailnetFetch, privatePeerWay, privateWay, tailnetFetch, tailnetNode } from "./tailnet-transport";

type Entry = { path: string; bytes: number; sha256: string; type: string };
type Reply = { ok: boolean; version?: number; enabled?: boolean; config?: unknown; entries?: Entry[]; missing?: Entry[]; job?: string; id?: string };
const enabledKey = "reach.offline-shell.enabled";
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
const hash = async (value: ArrayBuffer) => hex(await crypto.subtle.digest("SHA-256", value));
const build = () => document.querySelector<HTMLMetaElement>('meta[name="reach-shell-build"]')?.content || "";
export const offlineShellEnabled = () => { try { return localStorage.getItem(enabledKey) === "v1"; } catch { return false; } };
const supported = () => !!location.port && location.protocol === "https:" && location.hostname.endsWith(".ts.net") &&
  (location.pathname === "/" || /^\/files(?:\/|$)/.test(location.pathname)) && !guestPeers() && !!navigator.serviceWorker;
function command(worker: ServiceWorker, value: object, signal?: AbortSignal, transfer: Transferable[] = []): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = () => { clearTimeout(timer); channel.port1.close(); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(abort, 15000);
    channel.port1.onmessage = event => { cleanup(); event.data?.ok ? resolve(event.data) : reject(Error("The interface could not be saved.")); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    try { worker.postMessage({ type: "reach-static-shell-v1", ...value }, [channel.port2, ...transfer]); }
    catch (error) { cleanup(); reject(error); }
  });
}
async function worker(register: boolean, signal?: AbortSignal) {
  if (!supported()) return null;
  const halt = new AbortController(), deadline = signal ? AbortSignal.any([signal, halt.signal]) : halt.signal;
  const timer = setTimeout(() => halt.abort(), 4000);
  const bounded = <T>(pending: PromiseLike<T>): Promise<T> => new Promise((resolve, reject) => {
    const cleanup = () => deadline.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    if (deadline.aborted) { abort(); return; }
    deadline.addEventListener("abort", abort, { once: true });
    Promise.resolve(pending).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  const activated = (candidate: ServiceWorker) => new Promise<ServiceWorker>((resolve, reject) => {
    const cleanup = () => { candidate.removeEventListener("statechange", changed); deadline.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    const changed = () => {
      if (candidate.state === "activated") { cleanup(); resolve(candidate); }
      else if (candidate.state === "redundant") abort();
    };
    if (deadline.aborted) { abort(); return; }
    candidate.addEventListener("statechange", changed); deadline.addEventListener("abort", abort, { once: true }); changed();
  });
  try {
    // Registering the same URL need not fetch a new script. Native setup must
    // explicitly upgrade the old notification-only worker before any writes.
    // A browser-only private route cannot provide the browser's native worker
    // update fetch; it reuses its already installed capable worker instead.
    const nativeSetup = register && privateWay() === "native";
    const registration = await bounded(nativeSetup ? navigator.serviceWorker.register("/sw.js", { scope: "/" }) : navigator.serviceWorker.getRegistration("/"));
    if (!registration) return null;
    if (nativeSetup) {
      try { await bounded(registration.update()); } catch { if (deadline.aborted) return null; }
    }
    const candidate = nativeSetup ? registration.installing || registration.waiting || registration.active : registration.active;
    if (!candidate) return null;
    if (register) {
      await activated(candidate);
      if ((await command(candidate, { action: "hello" }, deadline)).version !== 1) return null;
    }
    return candidate;
  } catch { return null; }
  finally { clearTimeout(timer); halt.abort(); }
}
// A cold document chooses bootstrap metadata from its own complete code
// generation. It still has to authenticate the saved browser device freshly.
export async function offlineBootstrap(): Promise<StartConfig | null> {
  if (!offlineShellEnabled() || !/^[a-f0-9]{64}$/.test(build())) return null;
  try {
    const active = await worker(false);
    if (!active) return null;
    const reply = await command(active, { action: "bootstrap", build: build() }, AbortSignal.timeout(2000));
    const config = parseStartConfig(reply.config);
    return config && new URL(config.origin).hostname === location.hostname ? config : null;
  } catch { return null; }
}
async function read(response: Response, limit: number, signal: AbortSignal) {
  if (!response.ok || response.type === "opaque" || response.redirected || !response.body) throw Error("Interface unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw Error("Cancelled");
      const result = await reader.read(); if (result.done) break;
      if ((size += result.value.byteLength) > limit) throw Error("Interface too large");
      chunks.push(result.value);
    }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
  if (signal.aborted) throw Error("Cancelled");
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
export async function prepareOfflineShell(config: StartConfig | null, {
  signal = AbortSignal.timeout(90000), current = () => true, beforeCommit = async () => true,
}: { signal?: AbortSignal; current?: () => boolean; beforeCommit?: () => Promise<boolean> } = {}): Promise<boolean> {
  if (!supported()) return false;
  const halt = new AbortController(), deadline = AbortSignal.any([signal, halt.signal, AbortSignal.timeout(90000)]);
  let active: ServiceWorker | null = null, job = "";
  const mode = privateWay(), node = mode === "browser" ? tailnetNode() : null;
  let peer: Peer | undefined, grant = "";
  const peerKey = (value: Peer) => JSON.stringify([value.id, value.computerId, value.url, value.token, value.transport, value.browserIdentity]);
  let selected: string | null = null;
  const check = () => { if (deadline.aborted || !current()) throw Error("Connection changed"); };
  const sameRoute = () => {
    check();
    if (privateWay() !== mode || guestPeers() || localStorage.getItem(mode === "browser" ? "reach.browser.active" : "reach.active") !== selected)
      throw Error("Connection changed");
    if (mode === "browser" && (!node || node !== tailnetNode() || !browserNodeIdentityCurrent(node) || !peer ||
      privatePeerWay(peer) === "native" || readPrivatePeers("native").some(saved => saved.token === peer!.token) ||
      !readPrivatePeers("browser").some(saved => peerKey(saved) === peerKey(peer!)))) throw Error("Connection changed");
  };
  const authorize = async () => {
    sameRoute();
    if (mode !== "browser") return;
    if (!await browserPeerEligible(peer!)) throw Error("Connection changed");
    sameRoute();
    // This fresh owner read is separate from the static cache protocol. Its
    // credential and response never enter the worker or a code-cache record.
    const response = await tailnetFetch(node!, new URL("/api/device", peer!.url), { cache: "no-store", redirect: "error", credentials: "omit",
      headers: { Authorization: `Bearer ${peer!.token}` }, signal: deadline });
    const device: Device = JSON.parse(new TextDecoder().decode(await read(response, 256 * 1024, deadline)));
    const signature = JSON.stringify([device.id, device.computerId, [...(device.access?.scopes || [])].sort()]);
    if (device.id !== peer!.id || (peer!.computerId && peer!.computerId !== device.computerId) || device.access?.kind !== "device" ||
      !device.access.scopes.includes("admin") || (device.access.expiresAt && device.access.expiresAt <= Date.now()) || (grant && grant !== signature))
      throw Error("Connection changed");
    if (!await browserPeerEligible(peer!)) throw Error("Connection changed");
    sameRoute(); grant = signature;
  };
  const fetchPublic = async (path: string) => {
    sameRoute();
    const input = new URL(path, location.origin);
    // Staging must read this manifest's bytes, not the older committed cohort
    // that serves ordinary module requests. This fixed query carries no state.
    if (path !== "/offline-shell.json" && path !== "/reach-start.json") input.searchParams.set("reach-static-save", "1");
    const init: RequestInit = {
      cache: path === "/offline-shell.json" || path === "/reach-start.json" ? "no-store" : "force-cache",
      credentials: path === "/reach-start.json" ? "same-origin" : "omit", redirect: "error", signal: deadline };
    // Normal module loading stays native. Preparing the next complete public
    // code cohort can explicitly read through an already approved private node.
    return node ? tailnetFetch(node, input, init) : nativeTailnetFetch(input, init);
  };
  try {
    check();
    selected = localStorage.getItem(mode === "browser" ? "reach.browser.active" : "reach.active");
    if (mode === "browser") {
      const saved = readPrivatePeers("browser");
      peer = saved.find(value => value.id === (selected || saved[0]?.id));
      if (!peer || peer.transport === "funnel" || new URL(peer.url).origin !== location.origin) return false;
    }
    await authorize();
    active = await worker(true, deadline); if (!active) return false;
    if (/^[a-f0-9]{64}$/.test(build())) await command(active, { action: "pin", build: build() }, deadline);
    const manifest = JSON.parse(new TextDecoder().decode(await read(await fetchPublic("/offline-shell.json"), 256 * 1024, deadline)));
    if (manifest?.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.build) || !Array.isArray(manifest.entries) || manifest.entries.length > 512) throw Error("Interface unavailable");
    const bootstrap = config || parseStartConfig(JSON.parse(new TextDecoder().decode(await read(await fetchPublic("/reach-start.json"), 16384, deadline))));
    if (!bootstrap?.tailnet || new URL(bootstrap.origin).hostname !== location.hostname) throw Error("Interface unavailable");
    const paths = ["/tailnet/" + bootstrap.tailnet.wasm, "/tailnet/" + bootstrap.tailnet.exec];
    const cached = await command(active, { action: "runtime", paths }, deadline);
    const runtime: Entry[] = [], downloaded = new Map<string, ArrayBuffer>();
    for (const path of paths) {
      const known = cached.entries?.find(entry => entry.path === path);
      if (known) { runtime.push(known); continue; }
      if (!/^\/tailnet\/(?:reach-tailnet\.[a-f0-9]{12,64}\.wasm|wasm_exec\.[a-f0-9]{12,64}\.js)$/.test(path)) throw Error("Interface unavailable");
      const bytes = await read(await fetchPublic(path), 64 * 1024 * 1024, deadline), digest = await hash(bytes);
      const advertised = /\.([a-f0-9]{12,64})\.(?:wasm|js)$/.exec(path)![1];
      if (!digest.startsWith(advertised)) throw Error("Interface changed");
      runtime.push({ path, bytes: bytes.byteLength, sha256: digest, type: path.endsWith(".wasm") ? "application/wasm" : "text/javascript" });
      downloaded.set(path, bytes);
    }
    check();
    const started = await command(active, { action: "begin", manifest, config: bootstrap, runtime }, deadline);
    if (!started.job || !Array.isArray(started.missing)) throw Error("Interface unavailable");
    job = started.job;
    const missing = [...started.missing];
    const put = async () => {
      for (;;) {
        const entry = missing.shift(); if (!entry) return;
        check();
        const bytes = downloaded.get(entry.path) || await read(await fetchPublic(entry.path), Math.min(entry.bytes, 64 * 1024 * 1024), deadline);
        downloaded.delete(entry.path);
        check();
        await command(active!, { action: "put", job, path: entry.path, body: bytes }, deadline, [bytes]);
      }
    };
    await Promise.all([put(), put()]);
    check();
    if (!await beforeCommit()) throw Error("Connection changed");
    await authorize();
    sameRoute();
    await command(active, { action: "commit", job }, deadline);
    check();
    localStorage.setItem(enabledKey, "v1");
    return localStorage.getItem(enabledKey) === "v1";
  } catch { return false; }
  finally { halt.abort(); if (job && active) void command(active, { action: "cancel", job }, AbortSignal.timeout(2000)).catch(() => {}); }
}
export async function prepareInterfaceReload() {
  if (!offlineShellEnabled() || !supported()) return true;
  return prepareOfflineShell(null, { current: offlineShellEnabled });
}
export function retireOfflineShell() {
  try { localStorage.removeItem(enabledKey); } catch { /* Still retire the worker's public snapshot. */ }
  void worker(false).then(active => active && command(active, { action: "retire" }, AbortSignal.timeout(3000))).catch(() => {});
}
