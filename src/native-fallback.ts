import { guestPeers, peerFromDevice, readPrivatePeers, sameComputer, upsertPeer, type Device, type Peer } from "./api";
import { browserApprovalIdentity, browserNodeIdentityCurrent, observeBrowserNode, savedBrowserProfile, setupBrowserNode } from "./browser-node";
import { parseStartConfig } from "./start-flow";
import { nativeTailnetFetch, privatePeerWay, privateWay, tailnetFetch, type TailnetNode } from "./tailnet-transport";
import { storageBlocked } from "./storage-fallback";

type Current = { peer: Peer; device: Device };
type Pending = { id: string; secret: string; expiresAt: number; verification: string };
type Phase = "idle" | "connecting" | "sign-in" | "network-approval" | "approval" | "checking" | "ready" | "request-unknown" | "error";
export type FallbackSetupState = { phase: Phase; signIn?: string; code?: string; message?: string };
type Receipt = { node?: TailnetNode; pending?: Pending; creating?: Promise<void>; uncertain?: boolean; baseline: string | null;
  identity: ReturnType<typeof browserApprovalIdentity> };
// Kept only in this page. Closing/reopening the sheet keeps the same pending
// request, including a late create response; nothing is persisted to disk.
const receipts = new Map<string, Receipt>();
const key = (peer: Peer) => JSON.stringify([peer.id, peer.computerId, peer.url, peer.token, peer.transport, peer.sessionId]);
const scopes = (device: Device) => [...(device.access?.scopes || [])].sort().join("\n");
const owner = (device: Device) => device.access?.kind === "device" && device.access.scopes.includes("admin") &&
  (!device.access.expiresAt || device.access.expiresAt > Date.now());
const matching = (device: Device, expected: Device) => owner(device) && device.id === expected.id &&
  device.computerId === expected.computerId && scopes(device) === scopes(expected);
const privateOrigin = (peer: Peer) => {
  try {
    const url = new URL(peer.url);
    return peer.transport !== "funnel" && url.protocol === "https:" && url.hostname === location.hostname &&
      url.hostname.endsWith(".ts.net") && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
};
export const canSetUpFallback = (peer: Peer, device: Device) =>
  privateWay() === "native" && !guestPeers() && privateOrigin(peer) && owner(device);
const nativeCredential = (token: string, current: string) => token === current ||
  readPrivatePeers("native").some(peer => peer.token === token) || privatePeerWay({ url: location.origin, token }) === "native";
export const fallbackSetupNeeded = (peer: Peer) => !savedBrowserProfile() ||
  !readPrivatePeers("browser").some(saved => privateOrigin(saved) && saved.id === peer.id && !nativeCredential(saved.token, peer.token) &&
    (!peer.computerId || saved.computerId === peer.computerId));
const savedNative = (peer: Peer) => readPrivatePeers("native").some(saved => key(saved) === key(peer));
const probeStorage = () => {
  if (storageBlocked()) throw Error("Allow this site to save data before setting up fallback.");
  const name = "reach.fallback-storage-check";
  try {
    localStorage.setItem(name, "1");
    if (localStorage.getItem(name) !== "1") throw Error();
    localStorage.removeItem(name);
  } catch { throw Error("Allow this site to save data before setting up fallback."); }
};
const parsePending = (value: Partial<Pending>): Pending => {
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.id) ||
    typeof value.secret !== "string" || !value.secret || value.secret.length > 1024 ||
    typeof value.verification !== "string" || !/^[a-zA-Z0-9 -]{1,32}$/.test(value.verification) ||
    typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) throw Error("Reach did not return a connection request. Check it on your computer before trying again.");
  return value as Pending;
};

export function createFallbackSetup(options: { current(): Current | null; changed(state: FallbackSetupState): void }) {
  let lifetime: AbortController | undefined, detach = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
  let current: Current, receipt: Receipt, polling: Promise<void> | undefined, starting: Promise<void> | undefined;
  let invalidated = false, halted = false, loginAsked = false;
  let hiddenAt: number | undefined, networkPending = false;
  const live = () => !!lifetime && !lifetime.signal.aborted && !invalidated && options.current() !== null &&
    canSetUpFallback(options.current()!.peer, options.current()!.device) &&
    key(options.current()!.peer) === key(current.peer) && matching(options.current()!.device, current.device) && savedNative(current.peer);
  const emit = (state: FallbackSetupState) => { if (live()) options.changed(state); };
  const requireLive = () => { if (!live()) throw Error("This connection changed. Close setup and open it again from the computer you want."); };
  const call = async (fetcher: typeof fetch, origin: string, path: string, body?: unknown, token?: string, signal = lifetime!.signal) => {
    const response = await fetcher(origin + path, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", redirect: "error", credentials: "omit",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value || typeof value !== "object") throw Object.assign(Error("Could not reach this computer. Keep Tailscale on while you finish setup."), { status: response.status });
    return value;
  };
  const nativeGrant = async () => {
    requireLive();
    const device: Device = await call(nativeTailnetFetch, current.peer.url, "/api/device", undefined, current.peer.token);
    requireLive();
    if (!matching(device, current.device)) throw Object.assign(Error("Your access changed. Reopen this computer before setting up fallback."), { terminal: true });
    return device;
  };
  const browserFetch = ((input: RequestInfo | URL, init?: RequestInit) => tailnetFetch(receipt.node!, input, init)) as typeof fetch;
  const checkedBrowser = async (token: string) => {
    requireLive();
    if (!token || nativeCredential(token, current.peer.token)) throw Object.assign(Error("This approval belongs to the Tailscale app connection. Approve this browser separately."), { terminal: true });
    if (!browserNodeIdentityCurrent(receipt.node!)) throw Object.assign(Error("The browser connection could not be saved. Allow site data, then try again."), { terminal: true });
    const device: Device = await call(browserFetch, current.peer.url, "/api/device", undefined, token);
    requireLive();
    if (!matching(device, current.device)) throw Object.assign(Error("Fallback needs the same access as your current connection. Review its approval on your computer."), { terminal: true });
    if (!browserNodeIdentityCurrent(receipt.node!)) throw Object.assign(Error("The browser connection could not be saved. Allow site data, then try again."), { terminal: true });
    return device;
  };
  const target = (raw: string | null) => {
    const peers: Peer[] = JSON.parse(raw || "[]");
    if (!Array.isArray(peers) || peers.some(peer => !peer || ["id", "name", "platform", "url", "token"].some(field =>
      typeof (peer as unknown as Record<string, unknown>)[field] !== "string"))) throw Error("Your saved connections changed. Close setup and try again.");
    return JSON.stringify(peers.filter(peer => sameComputer(peer, current.peer)));
  };
  const stillSaved = (saved: Peer) => readPrivatePeers("browser").some(candidate =>
    key(candidate) === key(saved) && candidate.browserIdentity === saved.browserIdentity);
  const save = (token: string, device: Device, identity: NonNullable<Receipt["identity"]>, browserIdentity: string) => {
    requireLive(); probeStorage();
    if (nativeCredential(token, current.peer.token)) throw Error("This browser needs its own approval.");
    if (!identity.current() || !browserNodeIdentityCurrent(receipt.node!)) throw Error("The saved browser connection changed. Close setup and check it before continuing.");
    const name = "reach.browser.devices", before = localStorage.getItem(name);
    if (target(before) !== target(receipt.baseline)) throw Error("Your saved fallback changed. Close setup and check it before trying again.");
    const peer = { ...peerFromDevice({ id: current.peer.id, name: current.peer.name, platform: current.peer.platform,
      url: current.peer.url, token }, device), pairedAt: Date.now(), browserIdentity };
    const value = JSON.stringify(upsertPeer(readPrivatePeers("browser"), peer).map(({ workspaceKey: _workspaceKey, ...saved }) => saved));
    requireLive();
    if (localStorage.getItem(name) !== before) throw Error("Your saved connections changed. Close setup and try again.");
    localStorage.setItem(name, value);
    if (localStorage.getItem(name) !== value) throw Error("The browser connection could not be saved. Allow site data, then try again.");
    receipt.baseline = value;
    receipt.identity = identity;
    halted = true;
    options.changed({ phase: "ready" });
  };
  const finish = async (token: string) => {
    emit({ phase: "checking" });
    const device = await checkedBrowser(token);
    const identity = browserApprovalIdentity();
    if (!identity) throw Object.assign(Error("The browser connection could not be saved. Allow site data, then try again."), { terminal: true });
    const binding = await identity.binding();
    await nativeGrant();
    try { save(token, device, identity, binding); }
    catch (error) { throw Object.assign(error as Error, { terminal: true }); }
  };
  const poll = () => {
    if (polling || halted || !live() || !receipt.pending) return polling;
    const pending = receipt.pending;
    if (pending.expiresAt <= Date.now()) {
      receipt.pending = undefined;
      halted = true;
      emit({ phase: "error", message: "The approval request expired. Close setup and start again." });
      return;
    }
    polling = (async () => {
      try {
        requireLive();
        const result = await call(browserFetch, current.peer.url, `/api/auth/requests/${encodeURIComponent(pending.id)}`, { secret: pending.secret });
        requireLive();
        if (result.status === "approved" && typeof result.token === "string" && result.token) {
          await finish(result.token);
          receipt.pending = undefined;
          return;
        }
        if (result.status === "denied") {
          receipt.pending = undefined;
          halted = true;
          emit({ phase: "error", message: "This computer declined the fallback connection. Close setup before requesting again." });
          return;
        }
        if (result.status !== "pending") throw Object.assign(Error("This approval request is no longer available. Check Reach on your computer."), { terminal: true });
        emit({ phase: "approval", code: pending.verification });
      } catch (error) {
        if (!live()) return;
        const status = (error as { status?: number }).status;
        emit({ phase: "error", message: (error as Error).message });
        if ([401, 403, 404].includes(status || 0)) { receipt.pending = undefined; halted = true; return; }
        if ((error as { terminal?: boolean }).terminal) { halted = true; return; }
      }
      if (live()) timer = setTimeout(() => { void poll(); }, 1500);
    })().finally(() => { polling = undefined; });
    return polling;
  };
  const connected = async () => {
    if (polling || halted || !live()) return;
    if (receipt.pending) { emit({ phase: "approval", code: receipt.pending.verification }); void poll(); return; }
    if (receipt.creating) {
      await receipt.creating;
      if (live()) void connected();
      return;
    }
    if (receipt.uncertain) { emit({ phase: "request-unknown" }); return; }
    // Guard concurrent Running notifications before the first network await.
    receipt.creating = (async () => {
      try {
        await nativeGrant();
        for (const saved of readPrivatePeers("browser").filter(peer => privateOrigin(peer) && peer.id === current.device.id && !nativeCredential(peer.token, current.peer.token))) {
          try {
            // Capture precedes any new node/profile. A complete profile later
            // written by Go cannot retroactively authorize an older token.
            const identity = receipt.identity;
            if (!identity || !await identity.accepts(saved)) continue;
            requireLive();
            if (!stillSaved(saved) || !browserNodeIdentityCurrent(receipt.node!))
              throw Object.assign(Error("Your saved fallback changed. Close setup and check it before continuing."), { terminal: true });
            await checkedBrowser(saved.token);
            await nativeGrant();
            const sameIdentity = await identity.accepts(saved);
            if (!sameIdentity || !browserNodeIdentityCurrent(receipt.node!) || nativeCredential(saved.token, current.peer.token) ||
              !stillSaved(saved))
              throw Object.assign(Error("Your saved fallback changed. Close setup and check it before continuing."), { terminal: true });
            halted = true;
            emit({ phase: "ready" });
            return;
          } catch (error) { requireLive(); if ((error as { terminal?: boolean }).terminal) throw error; }
        }
        const method = await call(browserFetch, current.peer.url, "/api/auth/method");
        requireLive();
        if (method.method !== "tailscale" || method.eligible !== true) throw Error("Sign in with the same Tailscale account as this computer, then open setup again.");
        emit({ phase: "checking" });
        // The create action gets its own bounded lifetime. A late response is
        // retained after the sheet closes, rather than losing its secret and
        // automatically replaying a possibly delivered request.
        receipt.uncertain = true;
        const result = await call(browserFetch, current.peer.url, "/api/auth/requests", { name: "Fallback browser" }, undefined, AbortSignal.timeout(10000));
        receipt.pending = parsePending(result);
        receipt.uncertain = false;
        if (live()) { emit({ phase: "approval", code: receipt.pending.verification }); void poll(); }
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500) receipt.uncertain = false;
        if (!receipt.uncertain) halted = true;
        if (live()) emit(receipt.uncertain ? { phase: "request-unknown" } : { phase: "error", message: (error as Error).message });
      }
    })().finally(() => { receipt.creating = undefined; });
    await receipt.creating;
  };
  const wake = () => {
    if (!live() || halted || !receipt.node) return;
    try {
      receipt.node.wake();
      if (receipt.node.status().self.state === "Running") void connected();
    } catch {
      halted = true;
      emit({ phase: "error", message: "The browser connection was interrupted. Close setup and try again." });
    }
  };
  const hidden = () => { hiddenAt ??= Date.now(); };
  const resume = () => {
    if (document.hidden) { hidden(); return; }
    // As on the start page, a brief focus change does not reset the relay.
    // Visibility/pageshow/focus consume the same background transition.
    const repair = networkPending || (hiddenAt !== undefined && Date.now() - hiddenAt > 3000);
    hiddenAt = undefined; networkPending = false;
    if (repair) wake();
  };
  const online = () => {
    if (document.hidden) { hidden(); networkPending = true; return; }
    hiddenAt = undefined; networkPending = false;
    wake();
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null || event.key === "reach.devices" || event.key === "reach.browser.devices" || event.key?.startsWith("reach.tailnet:")) {
      invalidated = true;
      options.changed({ phase: "error", message: "Your saved connections changed. Close setup and check them before continuing." });
      stop();
    }
  };
  const stop = () => {
    lifetime?.abort(); detach(); clearTimeout(timer);
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener("pagehide", hidden);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("focus", resume);
    window.removeEventListener("online", online);
    document.removeEventListener("visibilitychange", resume);
  };
  return {
    start() {
      if (lifetime) return starting || Promise.resolve();
      stop(); invalidated = false;
      const selected = options.current();
      if (!selected || !canSetUpFallback(selected.peer, selected.device) || !savedNative(selected.peer)) {
        options.changed({ phase: "error", message: "Open your approved connection with Tailscale on to set up fallback." });
        return Promise.resolve();
      }
      current = { peer: { ...selected.peer }, device: { ...selected.device, access: selected.device.access ? { ...selected.device.access, scopes: [...selected.device.access.scopes] } : undefined } };
      lifetime = new AbortController();
      const id = key(current.peer) + scopes(current.device);
      try { receipt = receipts.get(id) || { baseline: localStorage.getItem("reach.browser.devices"), identity: browserApprovalIdentity() }; }
      catch {
        options.changed({ phase: "error", message: "Allow this site to save data before setting up fallback." });
        lifetime.abort();
        return Promise.resolve();
      }
      if (receipts.size > 32) receipts.delete(receipts.keys().next().value!);
      receipts.set(id, receipt);
      window.addEventListener("storage", storageChanged);
      if (document.hidden) hidden();
      window.addEventListener("pagehide", hidden);
      window.addEventListener("pageshow", resume);
      window.addEventListener("focus", resume);
      window.addEventListener("online", online);
      document.addEventListener("visibilitychange", resume);
      emit({ phase: "connecting" });
      starting = (async () => {
        try {
          probeStorage(); await nativeGrant();
          const response = await nativeTailnetFetch("/reach-start.json", { cache: "no-store", redirect: "error", credentials: "same-origin", signal: AbortSignal.any([lifetime!.signal, AbortSignal.timeout(5000)]) });
          const config = response.ok ? parseStartConfig(await response.json()) : null;
          requireLive();
          if (!config || new URL(config.origin).hostname !== location.hostname) throw Error("This computer could not prepare fallback. Try again in a moment.");
          receipt.node = await setupBrowserNode(config, lifetime!.signal);
          requireLive();
          detach = observeBrowserNode(receipt.node, {
            state(state) {
              if (!live() || halted) return;
              if (state === "Running") void connected();
              else if (state === "NeedsMachineAuth") emit({ phase: "network-approval" });
              else if (state === "NeedsLogin") {
                emit({ phase: "sign-in" });
                if (!loginAsked) { loginAsked = true; receipt.node!.login(); }
              }
            },
            authURL(url) {
              if (!live() || halted) return;
              try {
                const parsed = new URL(url);
                if (parsed.protocol !== "https:" || parsed.hostname !== "login.tailscale.com" || parsed.username || parsed.password) throw Error();
                emit({ phase: "sign-in", signIn: parsed.href });
              } catch { emit({ phase: "error", message: "Tailscale did not return a valid sign-in link. Close setup and try again." }); }
            },
            error() { if (!halted) emit({ phase: "error", message: "The browser connection was interrupted. Close setup and try again." }); },
          });
        } catch (error) { if (live()) emit({ phase: "error", message: (error as Error).message }); }
      })().finally(() => { starting = undefined; });
      return starting;
    },
    requestAgain() { if (!live() || receipt.creating) return; receipt.uncertain = false; void connected(); },
    stop,
  };
}
