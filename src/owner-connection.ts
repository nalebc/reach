import { bindPrivatePeer, privatePeerWay, privateWay, tailnetFetch, nativeTailnetFetch, type PrivateWay } from "./tailnet-transport";
import { ownerBrowserNode, browserApprovalIdentity, browserNodeIdentityCurrent, browserPeerEligible } from "./browser-node";
import { peerFetch, readPrivatePeers, upsertPeer, type Peer } from "./api";
import { parseStartConfig, type StartConfig } from "./start-flow";

type Keys = { pair: CryptoKeyPair; candidates: Record<string, string> };
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
  const register = (signal: AbortSignal) => registration ||= (async () => {
    const pair = await keys.pair(keyId);
    if (signal.aborted) throw signal.reason;
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const result = await sourceFetch(peer, "/api/device/owner-connection", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicKey, role: source }), signal,
    }).then(responseJSON);
    if (typeof result.connection !== "string" || !/^[a-f0-9-]{36}$/.test(result.connection)) throw Error("The computer did not confirm owner setup.");
    return { connection: result.connection, pair };
  })().catch(error => { registration = undefined; throw error; });
  return {
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

export function watchOwnerEnrollment(peer: Peer, report: (state: OwnerSetup) => void) {
  const lifetime = new AbortController(), source = privateWay();
  let config: StartConfig | null = null, enrollment: ReturnType<typeof ownerEnrollment> | undefined;
  let running = false, again = false, completed = false, retryAt = 0;
  let browserIdentity: ReturnType<typeof browserApprovalIdentity> = null;
  let browserCurrent = () => false;
  let baseline: string | null = null;
  const target = source === "native" ? "browser" : "native";
  const saved = () => readPrivatePeers(target).find(p => {
    try { return p.id === peer.id && p.transport !== "funnel" &&
      (!peer.computerId || p.computerId === peer.computerId) &&
      new URL(p.url).hostname === new URL(peer.url).hostname; } catch { return false; }
  });
  const check = async () => {
    if (lifetime.signal.aborted || completed || document.hidden || privateWay() !== source || Date.now() < retryAt) return;
    if (running) { again = true; return; }
    running = true;
    try {
      const previous = saved();
      if (previous && (previous.token === peer.token || privatePeerWay(previous) === source ||
          readPrivatePeers(source).some(candidate => candidate.token === previous.token)))
        throw Error("This saved approval belongs to the other connection. Review its access before continuing.");
      // Recovery verifies an existing native approval when the optional app
      // becomes reachable. It does not need new enrollment.
      if (previous && target === "native") { completed = true; report({ state: "ready" }); return; }
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]);
      config ||= parseStartConfig(await nativeTailnetFetch("/reach-start.json", { signal, cache: "no-store", redirect: "error", credentials: "omit" }).then(responseJSON));
      if (!config || new URL(config.origin).hostname !== location.hostname) throw Error("The computer's connection information is unavailable.");
      enrollment ||= ownerEnrollment(peer, source, config, {
        async save(role, incoming) {
          const name = role === "browser" ? "reach.browser.devices" : "reach.devices";
          const current = () => !lifetime.signal.aborted && privateWay() === source &&
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
  const wake = () => { retryAt = 0; void check(); };
  const timer = setInterval(() => void check(), 5000);
  for (const name of ["online", "reach-owner-browser-state"]) window.addEventListener(name, wake);
  document.addEventListener("visibilitychange", wake);
  report({ state: source === "browser" ? "ready" : "preparing" });
  void check();
  return () => {
    lifetime.abort();
    clearInterval(timer);
    for (const name of ["online", "reach-owner-browser-state"]) window.removeEventListener(name, wake);
    document.removeEventListener("visibilitychange", wake);
  };
}
