import { bindPrivatePeer, privatePeerWay, privateWay, tailnetFetch, nativeTailnetFetch, tailnetNode, type PrivateWay, type TailnetNode } from "./tailnet-transport";
import { ownerBrowserNode, browserApprovalIdentity, browserNodeIdentityCurrent, browserPeerEligible } from "./browser-node";
import { compactPeers, peerFetch, readPrivatePeers, upsertPeer, type Peer } from "./api";
import { parseStartConfig, type StartConfig } from "./start-flow";
import { offlineBootstrap, prepareOfflineShell } from "./offline-shell";

type Keys = { pair: CryptoKeyPair; candidates: Record<string, string>; registrations?: Record<string, string> };
export type OwnerSetup = { state: "preparing" | "signin" | "ready" | "error"; url?: string; message?: string };
const encoded = (value: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let database: Promise<IDBDatabase> | undefined;
const db = () => database ||= new Promise((resolve, reject) => {
  const request = indexedDB.open("reach-owner-connection", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("keys");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(Error("Enable browser storage to save your owner connection."));
});
async function updateKeys<T>(key: string, update: (value?: Keys) => { value: Keys; result: T }): Promise<T> {
  const store = await db();
  return new Promise((resolve, reject) => {
    const transaction = store.transaction("keys", "readwrite"), records = transaction.objectStore("keys");
    const read = records.get(key);
    let result: T;
    read.onsuccess = () => {
      try { const next = update(read.result); result = next.result; records.put(next.value, key); }
      catch { transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => reject(Error("This browser could not save its owner connection. Enable browser storage and try again."));
  });
}
export const browserOwnerKeys = {
  async pair(key: string) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    return updateKeys(key, old => {
      const value = old || { pair, candidates: {} };
      if (value.pair.privateKey.type !== "private" || value.pair.privateKey.extractable) throw Error("Invalid owner key");
      return { value, result: value.pair };
    });
  },
  candidate(key: string, connection: string, role: PrivateWay) {
    return updateKeys(key, value => {
      if (!value) throw Error("Missing owner key");
      const id = `${connection}:${role}`;
      value.candidates[id] ||= encoded(crypto.getRandomValues(new Uint8Array(32)));
      return { value, result: value.candidates[id] };
    });
  },
  registration(key: string, binding: string, connection?: string) {
    return updateKeys(key, value => {
      if (!value) throw Error("Missing owner key");
      if (connection) (value.registrations ||= {})[binding] = connection;
      return { value, result: value.registrations?.[binding] };
    });
  },
};
type KeyStore = typeof browserOwnerKeys;
const responseJSON = async (response: Response) => {
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error(value?.error || "Owner connection setup is unavailable."), { status: response.status });
  return value;
};

// No source bearer crosses to the destination. Its node identity comes from
// the destination's private ingress; the browser signs that exact challenge.
export function ownerEnrollment(peer: Peer, source: PrivateWay, config: StartConfig, {
  keys = browserOwnerKeys, sourceFetch = peerFetch, targetFetch = nativeTailnetFetch,
  save = (role: PrivateWay, incoming: Peer) => {
    const name = role === "browser" ? "reach.browser.devices" : "reach.devices";
    localStorage.setItem(name, JSON.stringify(upsertPeer(readPrivatePeers(role), incoming)));
    bindPrivatePeer(incoming, role);
  },
}: { keys?: KeyStore; sourceFetch?: typeof peerFetch; targetFetch?: typeof fetch; save?: (role: PrivateWay, peer: Peer) => void | Promise<void> } = {}) {
  let registration: Promise<{ connection: string; pair: CryptoKeyPair }> | undefined;
  const keyId = peer.computerId || peer.id;
  const target: PrivateWay = source === "native" ? "browser" : "native";
  const register = (signal: AbortSignal, allowRegister = true) => registration ||= (async () => {
    const pair = await keys.pair(keyId);
    if (signal.aborted) throw signal.reason;
    const binding = encoded(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
      source, peer.id, peer.computerId, peer.url, peer.token, config.origin,
    ]))));
    const saved = await keys.registration(keyId, binding);
    if (saved) return { connection: saved, pair };
    if (!allowRegister) throw Object.assign(Error("This browser's connection has not been prepared yet."), { code: "not-prepared" });
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const result = await sourceFetch(peer, "/api/device/owner-connection", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicKey, role: source }), signal,
    }).then(responseJSON);
    if (typeof result.connection !== "string" || !/^[a-f0-9-]{36}$/.test(result.connection)) throw Error("The computer did not confirm owner setup.");
    await keys.registration(keyId, binding, result.connection);
    return { connection: result.connection, pair };
  })().catch(error => { registration = undefined; throw error; });
  return {
    prepare: register,
    async join(signal: AbortSignal, fetcher = targetFetch) {
      const { connection, pair } = await register(signal);
      const post = (path: string, body: unknown) => fetcher(config.origin + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        redirect: "error", credentials: "omit", cache: "no-store", signal,
      }).then(responseJSON);
      const challenge = await post("/api/auth/owner-connection/challenge", { connection, role: target });
      const payload = JSON.parse(challenge.payload);
      if (payload.purpose !== "reach-owner-connection" || payload.v !== 1 || payload.connection !== connection ||
          payload.role !== target || payload.challenge !== challenge.id || typeof payload.identity?.nodeId !== "string" ||
          !(payload.until > Date.now()) || payload.until > Date.now() + 180000) throw Error("The computer returned an invalid owner connection challenge.");
      // Persist before dispatch. A lost enrollment reply can be retried with
      // this exact credential, without issuing or rotating another one.
      const token = await keys.candidate(keyId, connection, target);
      const signature = encoded(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${challenge.payload}\n${token}`)));
      if (signal.aborted) throw signal.reason;
      const joined = await post("/api/auth/owner-connection/join", { id: challenge.id, token, signature });
      if (signal.aborted) throw signal.reason;
      if (joined.device?.id !== peer.id || (peer.computerId && joined.device?.computerId !== peer.computerId)) throw Error("This connection belongs to another computer.");
      const next = { ...peer, ...joined.device, url: config.origin, token, workspaceKey: undefined };
      // Verify the issued credential on its own transport before publishing it.
      const device = await fetcher(next.url + "/api/device", { headers: { Authorization: `Bearer ${token}` }, redirect: "error", credentials: "omit", cache: "no-store", signal }).then(responseJSON);
      if (signal.aborted) throw signal.reason;
      if (device?.id !== peer.id || device.access?.kind !== "device" || !device.access.scopes.includes("admin") ||
          (peer.computerId && device.computerId !== peer.computerId)) throw Error("The other connection did not verify owner access.");
      await save(target, next);
      window.dispatchEvent(new Event("reach-owner-connections"));
      return next;
    },
  };
}

// Cold browser startup may finish a setup that began on the native path.
// Only an already registered proof can do this; missing proof leaves the
// normal first-client approval flow in charge.
export async function resumeOwnerConnection(config: StartConfig, node: TailnetNode, signal: AbortSignal) {
  const identity = browserApprovalIdentity();
  if (!identity || !browserNodeIdentityCurrent(node)) return;
  for (const peer of compactPeers(readPrivatePeers("native"))) {
    try {
      if (peer.transport === "funnel" || new URL(peer.url).hostname !== location.hostname ||
          new URL(config.origin).hostname !== location.hostname) continue;
    } catch { continue; }
    if (readPrivatePeers("browser").some(saved => saved.id === peer.id)) return;
    const before = localStorage.getItem("reach.browser.devices");
    const enrollment = ownerEnrollment(peer, "native", config, {
      async save(role, incoming) {
        const binding = await identity.binding();
        if (signal.aborted || !identity.current() || !browserNodeIdentityCurrent(node) ||
            !readPrivatePeers("native").some(saved => saved.token === peer.token && saved.url === peer.url))
          throw Error("Your saved connection changed. Reopen Reach to continue.");
        const next = { ...incoming, browserIdentity: binding };
        if (localStorage.getItem("reach.browser.devices") !== before) {
          const same = readPrivatePeers("browser").find(saved => saved.id === next.id && saved.computerId === next.computerId &&
            saved.url === next.url && saved.token === next.token && saved.browserIdentity === next.browserIdentity);
          if (!same) throw Error("Your saved connection changed. Reopen Reach to continue.");
          // Another tab collected this exact persisted candidate first.
          bindPrivatePeer(same, role);
          return;
        }
        const value = JSON.stringify(upsertPeer(readPrivatePeers("browser"), next));
        localStorage.setItem("reach.browser.devices", value);
        if (localStorage.getItem("reach.browser.devices") !== value) throw Error("Allow browser storage to save your connection.");
        bindPrivatePeer(next, role);
      },
    });
    try { await enrollment.prepare(signal, false); }
    catch { if (signal.aborted) throw signal.reason; continue; }
    await enrollment.join(signal, ((input, init) => tailnetFetch(node, input, init)) as typeof fetch);
    return;
  }
}

export function watchOwnerEnrollment(peer: Peer, report: (state: OwnerSetup) => void, {
  resumeOnly = false, beginBrowser,
}: { resumeOnly?: boolean; beginBrowser?: (config: StartConfig, node: TailnetNode) => void } = {}) {
  const lifetime = new AbortController(), source = privateWay();
  let config: StartConfig | null = null, enrollment: ReturnType<typeof ownerEnrollment> | undefined;
  let running = false, again = false, completed = false, retryAt = 0;
  let browserIdentity: ReturnType<typeof browserApprovalIdentity> = null;
  let browserCurrent = () => false;
  let baseline: string | null = null;
  let shellPreparation: Promise<boolean> | undefined;
  const target = source === "native" ? "browser" : "native";
  const saved = () => readPrivatePeers(target).find(p => {
    try { return p.id === peer.id && p.transport !== "funnel" &&
      (!peer.computerId || p.computerId === peer.computerId) &&
      new URL(p.url).hostname === new URL(peer.url).hostname; } catch { return false; }
  });
  const check = async () => {
    if (lifetime.signal.aborted || (completed && shellPreparation) || document.hidden || privateWay() !== source || Date.now() < retryAt) return;
    if (running) { again = true; return; }
    running = true;
    try {
      const previous = saved();
      if (previous && (previous.token === peer.token || privatePeerWay(previous) === source ||
          readPrivatePeers(source).some(candidate => candidate.token === previous.token)))
        throw Error("This saved approval belongs to the other connection. Review its access before continuing.");
      // Recovery verifies an existing native approval when the optional app
      // becomes reachable. It does not need new enrollment.
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]);
      config ||= await offlineBootstrap() || parseStartConfig(await nativeTailnetFetch("/reach-start.json", { signal, cache: "no-store", redirect: "error", credentials: "omit" }).then(responseJSON));
      if (!config || new URL(config.origin).hostname !== location.hostname) throw Error("The computer's connection information is unavailable.");
      // Save only public startup code while the current owner route is healthy,
      // including before browser sign-in. App-off reopening must reach that
      // sign-in flow too; it must not depend on already finishing enrollment.
      shellPreparation ||= prepareOfflineShell(config, {
        signal: lifetime.signal, current: () => !lifetime.signal.aborted && privateWay() === source,
      }).then(ready => { if (!ready) shellPreparation = undefined; return ready; });
      // A temporary cache failure must still retry after enrollment finishes,
      // without issuing another approval or touching the current workspace.
      if (completed) return;
      if (previous && target === "native") { completed = true; report({ state: "ready" }); return; }
      enrollment ||= ownerEnrollment(peer, source, config, {
        async save(role, incoming) {
          const name = role === "browser" ? "reach.browser.devices" : "reach.devices";
          const current = () => !lifetime.signal.aborted && privateWay() === source &&
            readPrivatePeers(source).some(saved => saved.token === peer.token && saved.url === peer.url && saved.id === peer.id) &&
            (role !== "browser" || !!browserIdentity?.current() && browserCurrent());
          if (!current()) throw Error("Your connection changed. Reopen Reach to finish setup.");
          if (role === "browser") incoming = { ...incoming, browserIdentity: await browserIdentity!.binding() };
          if (!current() || localStorage.getItem(name) !== baseline)
            throw Error("Your saved connections changed. Reopen Reach to finish setup.");
          const value = JSON.stringify(upsertPeer(readPrivatePeers(role), incoming));
          localStorage.setItem(name, value);
          if (localStorage.getItem(name) !== value) throw Error("Allow browser storage to save this connection.");
          bindPrivatePeer(incoming, role);
        },
      });
      // Establish the proof while the source still works, before waiting for
      // browser sign-in. Its persisted receipt can be used after native loss;
      // no native bearer is ever sent through the browser node.
      let prepared = true;
      if (!previous) {
        try { await enrollment.prepare(signal, !resumeOnly); }
        catch (error) {
          if (!resumeOnly || target !== "browser" || !beginBrowser || (error as { code?: string }).code !== "not-prepared") throw error;
          prepared = false;
        }
      }
      if (lifetime.signal.aborted || privateWay() !== source) return;
      let fetcher = nativeTailnetFetch;
      if (target === "browser") {
        report({ state: "preparing" });
        const browser = await ownerBrowserNode(config);
        if (lifetime.signal.aborted) return;
        if (browser.node.status().self.state !== "Running") {
          let url = "";
          try { const parsed = new URL(browser.authURL); if (parsed.protocol === "https:" && parsed.hostname === "login.tailscale.com") url = parsed.href; } catch { /* The node is still preparing sign-in. */ }
          report({ state: "signin", url });
          return;
        }
        browserIdentity = browserApprovalIdentity();
        browserCurrent = () => browserNodeIdentityCurrent(browser.node);
        if (!browserIdentity || !browserCurrent()) throw Error("The browser connection could not be saved. Allow site data and try again.");
        if (!prepared) {
          // An old app-only client has no proof to resume. Its browser must
          // follow normal owner approval; no app credential is transferred.
          completed = true;
          beginBrowser!(config, browser.node);
          return;
        }
        if (previous && !await browserPeerEligible(previous)) throw Error("Your saved browser approval belongs to a different connection. Review its access before continuing.");
        fetcher = ((input, init) => tailnetFetch(browser.node, input, init)) as typeof fetch;
      }
      if (previous) {
        if (!readPrivatePeers(target).some(candidate => candidate.token === previous.token && candidate.url === previous.url &&
            candidate.browserIdentity === previous.browserIdentity)) throw Error("Your saved connection changed. Reopen Reach to continue.");
        const device = await fetcher(previous.url + "/api/device", {
          headers: { Authorization: `Bearer ${previous.token}` }, signal, redirect: "error", credentials: "omit", cache: "no-store",
        }).then(responseJSON);
        if (device.id !== peer.id || device.access?.kind !== "device" || !device.access.scopes?.includes("admin") ||
            (peer.computerId && device.computerId !== peer.computerId)) throw Error("Set up this browser again to restore owner access.");
        if (!browserIdentity?.current() || !browserCurrent()) throw Error("Your browser connection changed. Reopen Reach to continue.");
      } else {
        if (saved()) throw Error("Your saved connection changed. Checking its existing approval before continuing.");
        baseline = localStorage.getItem(target === "browser" ? "reach.browser.devices" : "reach.devices");
        await enrollment.join(signal, fetcher);
      }
      completed = true;
      report({ state: "ready" });
    } catch (error) {
      // No native path yet is normal for browser-first owners. Their browser
      // connection stays available; keep checking for the optional phone app.
      if (!lifetime.signal.aborted && target === "browser") report({ state: "error", message: error instanceof Error ? error.message : "Connection setup will retry." });
      retryAt = Date.now() + 15000;
    } finally {
      running = false;
      if (again) { again = false; void check(); }
    }
  };
  const changed = () => { retryAt = 0; void check(); };
  const wake = () => {
    if (document.hidden) return;
    // A phone can suspend the standby relay while its VPN or SSO changes.
    // Wake on network/foreground events, never on ordinary state callbacks.
    if (target === "browser" && !completed) tailnetNode()?.wake();
    changed();
  };
  const timer = setInterval(() => void check(), 5000);
  window.addEventListener("online", wake);
  window.addEventListener("reach-owner-browser-state", changed);
  document.addEventListener("visibilitychange", wake);
  report({ state: source === "browser" ? "ready" : "preparing" });
  void check();
  return () => {
    lifetime.abort();
    clearInterval(timer);
    window.removeEventListener("online", wake);
    window.removeEventListener("reach-owner-browser-state", changed);
    document.removeEventListener("visibilitychange", wake);
  };
}
