import { agentRequestTimeout } from "../server/agent-transport.mjs";
import type { Peer } from "./api";
import { privateGatewayRoute, type PrivateGatewayRoute } from "./private-gateway";
import { nativeBrowserFetch } from "./native-browser";

export const funnelStorageKey = "reach.funnel-agent";
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const DAY = 24 * 60 * 60 * 1000;
const storageError = () =>
  Error(
    "This browser cannot securely save its connection. Enable browser storage, then open the link again.",
  );
const failure = (status: number, message: string) =>
  Object.assign(Error(message), { status });
// The only words that send the agent back to the owner: its access is over.
const endedError = () =>
  failure(410, "This access has ended. Ask the owner for a new invitation.");

type Device = { id: string; name: string; platform: string };
export type FunnelReceipt = {
  requestId: string;
  requestSecret: string;
  verificationCode: string;
  expiresAt: number;
  device: Device;
  // The link the owner approved before, opened in this browser (moved) or
  // reconnected from it (refreshed): nothing to approve, collected at once.
  moved?: boolean;
  refreshed?: boolean;
};
export type FunnelSession = { peer: Peer; expiresAt: number };
export type FunnelState = {
  id: string;
  origin: string;
  invitation: string;
  // Always access: kept in the browser's lasting storage so the agent can
  // close the tab and come back without a new invitation.
  standing?: boolean;
  claimAttempted?: boolean;
  // The owner approved this browser's access at least once.
  approved?: boolean;
  receipt?: FunnelReceipt;
  session?: FunnelSession;
};
export type FunnelKeys = {
  read(id: string): Promise<CryptoKeyPair | undefined>;
  write(id: string, keys: CryptoKeyPair, expiresAt: number): Promise<void>;
  remove(id: string): Promise<void>;
};

// The private key is a structured-cloned, non-extractable CryptoKey. Neither a
// token nor this tab's lookup ID alone can authorize another browser.
export function browserFunnelKeys(): FunnelKeys {
  const db = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("reach-funnel-agent", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
      opening.onsuccess = () => {
        const database = opening.result;
        const cleanup = database.transaction("keys", "readwrite");
        const cursor = cleanup.objectStore("keys").openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (
            !Number.isFinite(item.value?.expiresAt) ||
            item.value.expiresAt <= Date.now()
          )
            item.delete();
          item.continue();
        };
        cleanup.oncomplete = () => resolve(database);
        cleanup.onerror = cleanup.onabort = () => {
          database.close();
          reject(storageError());
        };
      };
      opening.onerror = () => reject(storageError());
      opening.onblocked = () => reject(storageError());
    });
  async function transact<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await db();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction("keys", mode);
        const request = action(transaction.objectStore("keys"));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () =>
          reject(storageError());
      });
    } finally {
      database.close();
    }
  }
  return {
    async read(id) {
      const value = await transact("readonly", (store) => store.get(id));
      if (!value) return;
      if (value.expiresAt <= Date.now()) {
        await this.remove(id);
        return;
      }
      return value.keys;
    },
    async write(id, keys, expiresAt) {
      await transact("readwrite", (store) =>
        store.put({ keys, expiresAt }, id),
      );
    },
    async remove(id) {
      await transact("readwrite", (store) => store.delete(id));
    },
  };
}

function base64url(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function validKeys(keys: CryptoKeyPair | undefined): keys is CryptoKeyPair {
  return (
    !!keys &&
    keys.privateKey?.type === "private" &&
    keys.privateKey.extractable === false &&
    keys.privateKey.algorithm.name === "ECDSA" &&
    (keys.privateKey.algorithm as EcKeyAlgorithm).namedCurve === "P-256" &&
    keys.privateKey.usages.includes("sign") &&
    keys.publicKey?.type === "public"
  );
}
function validDevice(value: Device | undefined): value is Device {
  return (
    !!value &&
    [value.id, value.name, value.platform].every(
      (s) => typeof s === "string" && !!s,
    )
  );
}

export function createFunnelAgent(dependencies: {
  origin: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  keep?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  keys: FunnelKeys;
  crypto: Crypto;
  fetch: typeof fetch;
  now?: () => number;
  locks?: Pick<LockManager, "request">;
  gateway?: PrivateGatewayRoute;
}) {
  const { origin, storage, keys, crypto } = dependencies;
  const keep = dependencies.keep || storage;
  const now = dependencies.now || Date.now;
  const preparations = new Map<string, Promise<FunnelState>>();
  const exchanges = new Map<string, Promise<FunnelState>>();
  const random = () => base64url(crypto.getRandomValues(new Uint8Array(24)));
  const read = (): FunnelState | null => {
    const value = JSON.parse(storage.getItem(funnelStorageKey) || keep.getItem(funnelStorageKey) || "null");
    return value?.origin === origin &&
      typeof value.id === "string" &&
      secretPattern.test(value.invitation)
      ? value
      : null;
  };
  const save = (state: FunnelState) => {
    const value = JSON.stringify(state);
    const place = state.standing ? keep : storage;
    place.setItem(funnelStorageKey, value);
    if (place.getItem(funnelStorageKey) !== value) throw storageError();
    if (place !== storage) storage.removeItem(funnelStorageKey);
  };
  async function forget(state?: FunnelState | null) {
    const current = state || read();
    if (!current || read()?.id === current.id) {
      storage.removeItem(funnelStorageKey);
      keep.removeItem(funnelStorageKey);
    }
    if (current) await keys.remove(current.id);
  }
  async function keyFor(state: FunnelState) {
    const pair = await keys.read(state.id);
    if (!validKeys(pair)) throw storageError();
    return pair;
  }
  async function prepareInner(invitation?: string) {
    if (invitation && !secretPattern.test(invitation))
      throw Error(
        "This invitation is incomplete. Open the full link the owner shared.",
      );
    let state: FunnelState | null;
    try {
      state = read();
    } catch {
      throw storageError();
    }
    if (state && (!invitation || state.invitation === invitation)) {
      // Never mint a different identity for an already-claimed invitation.
      // Whether its access goes on is the computer's to say (reconnect), not
      // a clock on this page: the owner may have extended or approved it.
      await keyFor(state);
      save(state);
      return state;
    }
    if (!invitation)
      throw Error("Open the invitation link the computer’s owner sent you.");
    // Another invitation in this tab never drops an Always access kept here.
    if (state && !state.standing) await forget(state);
    try {
      state = { id: random(), origin, invitation };
      save(state); // Check tab storage before creating or claiming anything.
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      await keys.write(state.id, pair, now() + 24 * 60 * 60 * 1000);
      const persisted = await keyFor(state);
      // Verify that storage kept a usable matching pair before consuming a link.
      const probe = new TextEncoder().encode(random());
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        persisted.privateKey,
        probe,
      );
      if (
        !(await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          persisted.publicKey,
          signature,
          probe,
        ))
      )
        throw storageError();
      return state;
    } catch {
      if (state) await forget(state).catch(() => {});
      throw storageError();
    }
  }
  function prepare(invitation?: string) {
    const key = invitation || "resume";
    const existing = preparations.get(key);
    if (existing) return existing;
    const result = prepareInner(invitation);
    preparations.set(key, result);
    void result.finally(() => preparations.delete(key)).catch(() => {});
    return result;
  }
  async function signed(
    state: FunnelState,
    operation: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (state.origin !== origin || !/^https:\/\//.test(origin))
      throw endedError();
    const pair = await keyFor(state);
    const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const publicKey = {
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x,
      y: exported.y,
    };
    const payload = JSON.stringify({
      ...operation,
      v: 1,
      audience: origin,
      issuedAt: now(),
      nonce: random(),
    });
    const signature = base64url(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(payload),
      ),
    );
    // The key's fingerprint, as the computer computes it: an agent with
    // access gets the capacity kept for it (server/funnel-agent.mjs).
    const thumbprint = base64url(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ crv: "P-256", kty: "EC", x: publicKey.x, y: publicKey.y })),
      ),
    );
    const endpoint = await dependencies.gateway?.endpoint() || origin;
    return dependencies.fetch(`${endpoint}/agent-gateway`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Reach-Key": thumbprint },
      body: JSON.stringify({ payload, publicKey, signature }),
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: signal || AbortSignal.timeout(35000),
    }).catch(error => {
      // The answer may have been lost after a click/command ran. Record the
      // route failure for future requests, never resend this operation here.
      if (!signal?.aborted && (error instanceof TypeError || error?.name === "TimeoutError"))
        dependencies.gateway?.failed(endpoint);
      throw error;
    });
  }
  // What a refusal means for this page: over (401 unknown or revoked link,
  // 403 declined, 410 ended), or in use in another browser (423). Anything
  // else is a moment's trouble, tried again.
  const refused = (status: number, current: FunnelState) => {
    if (status === 423)
      return failure(423, "This access is in use in another browser. Use it here to move it to this browser.");
    if (status === 403) return failure(403, "The owner declined this connection.");
    if (status === 401 || status === 410)
      return failure(
        410,
        current.session || current.approved
          ? "This access has ended. Ask the owner for a new invitation."
          : current.receipt
            ? "This invitation expired before it was approved. Ask the owner for a new invitation."
            : "This link no longer works: it was opened in another browser before it was approved, or its access ended. Ask the owner for a new invitation.",
      );
    return failure(status || 502, "Couldn’t reach the computer just now. Trying again…");
  };
  async function exchange(
    state: FunnelState,
    operation: "claim" | "status" | "reconnect",
    again = true,
  ): Promise<FunnelState> {
    const current = read();
    if (current?.id !== state.id) throw endedError();
    if (operation !== "reconnect" && current.session) return current;
    if (operation === "claim" && current.receipt) return current;
    if (operation === "status" && !current.receipt) return current;
    // A claim whose answer was lost is sent again: the computer gives this
    // browser its same waiting request back (or its approved access).
    if (operation === "claim") {
      current.claimAttempted = true;
      save(current);
    }
    const payload =
      operation === "status"
        ? {
            operation,
            requestId: current.receipt?.requestId,
            secret: current.receipt?.requestSecret,
          }
        : { operation, invitation: current.invitation };
    const response = await signed(current, payload);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Approved, but the answer carrying the credential was lost: get a
      // fresh one for this browser.
      if (operation === "status" && response.status === 409 && again)
        return reconnectAndCollect(current, false);
      throw refused(response.status, current);
    }
    if (result.status === "pending") {
      if (operation === "status") {
        // Still waiting for the owner.
        if (current.receipt && Number.isFinite(result.expiresAt))
          current.receipt.expiresAt = result.expiresAt;
      } else {
        const {
          requestId,
          requestSecret,
          verificationCode,
          expiresAt,
          device,
        } = result;
        if (
          typeof requestId !== "string" ||
          !secretPattern.test(requestSecret) ||
          !/^\d{6}$/.test(verificationCode) ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= now() ||
          !validDevice(device)
        )
          throw failure(502, "The connection request could not be received. Trying again…");
        // Reconnecting replaces a session the computer no longer accepts.
        if (operation === "reconnect") delete current.session;
        current.receipt = {
          requestId,
          requestSecret,
          verificationCode,
          expiresAt,
          device,
          ...(result.moved === true ? { moved: true } : {}),
          ...(result.refreshed === true ? { refreshed: true } : {}),
        };
      }
    } else if (result.status === "approved" && operation === "status") {
      if (
        typeof result.token !== "string" ||
        !result.token ||
        !validDevice(result.device) ||
        !Number.isFinite(result.expiresAt) ||
        result.expiresAt <= now()
      )
        throw failure(502, "The approved connection could not be received. Trying again…");
      current.session = {
        peer: {
          ...result.device,
          url: origin,
          token: result.token,
          transport: "funnel",
          sessionId: current.id,
        },
        expiresAt: result.expiresAt,
      };
      current.approved = true;
      if (result.standing === true) current.standing = true;
      delete current.receipt;
      // Token delivery is one-time: persist before a view can unmount.
      save(current);
      await keys.write(current.id, await keyFor(current), result.expiresAt + DAY);
      return current;
    } else if (result.status === "denied") {
      throw refused(403, current);
    } else if (result.status === "expired") {
      // The computer says whether this browser goes on (approved meanwhile)
      // or not (ended, or never approved in time): ask it.
      if (operation === "status" && again) return reconnectAndCollect(current, false);
      throw refused(410, current);
    } else throw failure(502, "This invitation returned an unknown connection state. Trying again…");
    save(current);
    if (current.receipt)
      await keys.write(
        current.id,
        await keyFor(current),
        // Kept while the access may come back, never only as long as a receipt.
        Math.max(current.receipt.expiresAt, now() + DAY),
      );
    return current;
  }
  // Reconnect this browser, then collect at once when it was approved before.
  async function reconnectAndCollect(current: FunnelState, again = true) {
    let next = await exchange(current, "reconnect", again);
    if (!next.session && (next.receipt?.moved || next.receipt?.refreshed))
      next = await exchange(next, "status", again);
    return next;
  }
  function once(state: FunnelState, operation: "claim" | "status") {
    const key = `${state.id}:${operation}`;
    const existing = exchanges.get(key);
    if (existing) return existing;
    const result = exchange(state, operation);
    exchanges.set(key, result);
    void result.finally(() => exchanges.delete(key)).catch(() => {});
    return result;
  }
  // After a refused request: one reconnect at a time for this tab. Another tab
  // that already reconnected the same access left its session in storage.
  let reconnecting: Promise<FunnelState> | null = null;
  function reconnect(state: FunnelState, failedToken?: string) {
    const recover = async () => {
      const stored = read();
      if (stored?.id !== state.id) throw endedError();
      if (stored.session && failedToken && stored.session.peer.token !== failedToken)
        return stored;
      // A renewal may have reached Reach before its credential answer was
      // interrupted. Collect that receipt before replacing it with another.
      if (!stored.session && stored.approved && stored.receipt)
        return exchange(stored, "status");
      return reconnectAndCollect(stored);
    };
    // Always access shares its key and storage across tabs. Serialize renewal
    // across tabs too, then reread what the previous tab saved.
    reconnecting ||= (dependencies.locks
      ? dependencies.locks.request(`reach-agent:${state.id}`, recover)
      : recover()).finally(() => {
      reconnecting = null;
    });
    return reconnecting;
  }
  // The agent chose to use its access here, after it moved to another browser.
  async function takeBack(state: FunnelState) {
    const current = read();
    if (current?.id !== state.id) throw endedError();
    delete current.session;
    delete current.receipt;
    save(current);
    let next = await exchange(current, "claim");
    if (!next.session && (next.receipt?.moved || next.receipt?.refreshed))
      next = await exchange(next, "status");
    return next;
  }
  const notRunResponse = (error: unknown) => {
    const status = (error as { status?: number })?.status;
    return new Response(JSON.stringify({ error: (error as Error)?.message || "Couldn’t reconnect to the computer. Trying again…" }), {
      status: status && status >= 400 && status <= 599 ? status : 503,
      headers: { "Content-Type": "application/json", "Reach-Not-Run": "1" },
    });
  };
  async function request(peer: Peer, path: string, init: RequestInit = {}) {
    // Mid-reconnect the session is being replaced: wait for the new one.
    if (reconnecting) await reconnecting.catch(() => {});
    if (dependencies.locks)
      await dependencies.locks.request(`reach-agent:${peer.sessionId}`, () => {});
    let state = read();
    if (state && state.id === peer.sessionId && peer.url === origin &&
        !state.session && state.approved && state.receipt) {
      try {
        state = await reconnect(state, peer.token);
      } catch (error) {
        return notRunResponse(error);
      }
      if (!state.session)
        return notRunResponse(failure(503, "This page is reconnecting to the computer. Trying again in a moment."));
    }
    // The session in storage is the one to use: a refresh may have replaced
    // the token a view still holds. Never "ended" from here: only the
    // computer says that (reconnect).
    if (!state?.session || state.id !== peer.sessionId || peer.url !== origin)
      throw failure(
        503,
        "This page is reconnecting to the computer. Trying again in a moment.",
      );
    if (!/^\/api\//.test(path) || /[\\#]/.test(path))
      throw Error("This request is outside the shared workspace.");
    const method = (init.method || "GET").toUpperCase();
    if (!["GET", "POST", "DELETE"].includes(method))
      throw Error("This action is unavailable in the shared workspace.");
    const body =
      init.body == null
        ? null
        : typeof init.body === "string"
          ? JSON.parse(init.body)
          : undefined;
    if (body === undefined)
      throw Error(
        "This request format is unavailable in the shared workspace.",
      );
    const send = (current: FunnelState) =>
      signed(
        current,
        { operation: "request", token: current.session!.peer.token, method, path, body },
        init.signal || AbortSignal.timeout(agentRequestTimeout(path, method)),
      );
    let current = state;
    let response = await send(current);
    // Refused before it ran (its token replaced, Reach restarted, the owner
    // changed something): reconnect this browser and send it once more.
    if (response.status === 401 && response.headers.get("Reach-Not-Run") === "1" && !init.signal?.aborted) {
      let next: FunnelState;
      try {
        next = await reconnect(current, current.session!.peer.token);
      } catch (error) {
        // Only the original, refused action is known not to have run. Keep a
        // renewal outage retryable, and preserve an actual refusal's status.
        return notRunResponse(error);
      }
      if (next.session) {
        current = next;
        // A resent action may have run. A lost answer must propagate without
        // inheriting the original request's Not-Run guarantee.
        response = await send(current);
      }
    }
    if (response.ok && method === "GET" && path === "/api/device") {
      const device = await response.clone().json();
      const expiresAt = device.access?.expiresAt;
      const latest = read();
      if (Number.isFinite(expiresAt) && expiresAt > now() && latest?.id === current.id && latest.session) {
        await keys.write(latest.id, await keyFor(latest), expiresAt + DAY);
        latest.session.expiresAt = expiresAt;
        save(latest);
      }
    }
    return response;
  }
  return {
    prepare,
    claim: (state: FunnelState) => once(state, "claim"),
    status: (state: FunnelState) => once(state, "status"),
    reconnect,
    takeBack,
    request,
    forget,
  };
}

export type FunnelAgentClient = ReturnType<typeof createFunnelAgent>;
let client: FunnelAgentClient | undefined;
export function browserFunnelAgent() {
  return (client ||= createFunnelAgent({
    origin: location.origin,
    storage: sessionStorage,
    keep: (() => { try { return localStorage; } catch { return undefined; } })(),
    keys: browserFunnelKeys(),
    crypto,
    fetch: (...args) => fetch(...args),
    gateway: privateGatewayRoute({ origin: location.origin, fetch: nativeBrowserFetch }),
    locks: navigator.locks,
  }));
}
// Granted access never gives up on a blip. A read that failed on the network
// (the connection dropped, the route blinked) or that Reach couldn't take just
// then (restarting, paused, reconnecting: 502/503/504, or busy: 429) is sent
// again with growing waits for about a minute. A write is sent again only when
// Reach says it never ran (Reach-Not-Run): a click or a shell command must
// land exactly once.
const RETRY_WAITS = [1, 2, 4, 6, 8, 10, 10, 10, 10];
const transient = (status: number) => [429, 502, 503, 504].includes(status);
export async function funnelFetch(
  peer: Peer,
  path: string,
  init: RequestInit = {},
  agent: Pick<FunnelAgentClient, "request"> = browserFunnelAgent(),
  retryAfterMs = 800,
) {
  const read = ["GET", "HEAD"].includes((init.method || "GET").toUpperCase());
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= RETRY_WAITS.length;
    let response: Response;
    try {
      response = await agent.request(peer, path, init);
    } catch (error) {
      // Dropped (TypeError) or stalled past its deadline (TimeoutError):
      // a read is safe to send again; the caller's own cancel is final.
      const lostOrStalled = error instanceof TypeError || (error as Error)?.name === "TimeoutError";
      if (!read || last || init.signal?.aborted || !lostOrStalled) throw error;
      await wait(retryAfterMs * RETRY_WAITS[attempt], init.signal);
      if (init.signal?.aborted) throw error;
      continue;
    }
    const again = transient(response.status) &&
      (read || response.headers.get("Reach-Not-Run") === "1");
    if (!again || last || init.signal?.aborted) return response;
    await wait(retryAfterMs * RETRY_WAITS[attempt], init.signal);
    if (init.signal?.aborted) return response;
  }
}
const wait = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
