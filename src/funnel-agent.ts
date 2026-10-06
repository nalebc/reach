import type { Peer } from "./api";

export const funnelStorageKey = "reach.funnel-agent";
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const storageError = () =>
  Error(
    "This browser cannot securely save its connection. Enable browser storage before opening a new invitation.",
  );
const endedError = () =>
  Object.assign(
    Error("This connection has ended. Ask the owner for a new invitation."),
    { status: 401 },
  );

type Device = { id: string; name: string; platform: string };
export type FunnelReceipt = {
  requestId: string;
  requestSecret: string;
  verificationCode: string;
  expiresAt: number;
  device: Device;
};
export type FunnelSession = { peer: Peer; expiresAt: number };
export type FunnelState = {
  id: string;
  origin: string;
  invitation: string;
  claimAttempted?: boolean;
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
  keys: FunnelKeys;
  crypto: Crypto;
  fetch: typeof fetch;
  now?: () => number;
}) {
  const { origin, storage, keys, crypto } = dependencies;
  const now = dependencies.now || Date.now;
  const preparations = new Map<string, Promise<FunnelState>>();
  const exchanges = new Map<string, Promise<FunnelState>>();
  const random = () => base64url(crypto.getRandomValues(new Uint8Array(24)));
  const read = (): FunnelState | null => {
    const value = JSON.parse(storage.getItem(funnelStorageKey) || "null");
    return value?.origin === origin &&
      typeof value.id === "string" &&
      secretPattern.test(value.invitation)
      ? value
      : null;
  };
  const save = (state: FunnelState) => {
    const value = JSON.stringify(state);
    storage.setItem(funnelStorageKey, value);
    if (storage.getItem(funnelStorageKey) !== value) throw storageError();
  };
  async function forget(state?: FunnelState | null) {
    const current = state || read();
    if (!current || read()?.id === current.id)
      storage.removeItem(funnelStorageKey);
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
      if (
        (state.session?.expiresAt || state.receipt?.expiresAt || Infinity) <=
        now()
      ) {
        await forget(state);
        throw endedError();
      }
      // Never mint a different identity for an already-claimed invitation.
      await keyFor(state);
      save(state);
      return state;
    }
    if (!invitation)
      throw Error("Open the invitation link the computer’s owner sent you.");
    if (state) await forget(state);
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
    return dependencies.fetch(`${origin}/agent-gateway`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, publicKey, signature }),
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: signal || AbortSignal.timeout(35000),
    });
  }
  async function exchange(state: FunnelState, operation: "claim" | "status") {
    const current = read();
    if (current?.id !== state.id) throw endedError();
    if (current.session) return current;
    if (operation === "claim" && current.receipt) return current;
    if (operation === "claim") {
      if (current.claimAttempted)
        throw Error(
          "The invitation was already sent from this tab, but its connection receipt was not received. Ask the owner for a new invitation.",
        );
      current.claimAttempted = true;
      save(current);
    }
    const payload =
      operation === "claim"
        ? { operation, invitation: current.invitation }
        : {
            operation,
            requestId: current.receipt?.requestId,
            secret: current.receipt?.requestSecret,
          };
    const response = await signed(current, payload);
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(
        Error(result.error || "This invitation could not connect."),
        { status: response.status },
      );
    if (result.status === "pending") {
      if (operation === "claim") {
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
          throw Error(
            "The connection request could not be received. Ask the owner for a new invitation.",
          );
        current.receipt = {
          requestId,
          requestSecret,
          verificationCode,
          expiresAt,
          device,
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
        throw Error(
          "The approved connection could not be received. Ask the owner for a new invitation.",
        );
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
      delete current.receipt;
      // Token delivery is one-time: persist before a view can unmount.
      save(current);
      await keys.write(current.id, await keyFor(current), result.expiresAt);
      return current;
    } else if (result.status === "denied" || result.status === "expired") {
      await forget(current);
      throw Object.assign(
        Error(
          result.status === "denied"
            ? "The owner denied this connection. Ask for a new invitation."
            : "This connection request expired. Ask the owner for a new invitation.",
        ),
        { status: 410 },
      );
    } else throw Error("This invitation returned an unknown connection state.");
    save(current);
    if (current.receipt)
      await keys.write(
        current.id,
        await keyFor(current),
        current.receipt.expiresAt,
      );
    return current;
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
  async function request(peer: Peer, path: string, init: RequestInit = {}) {
    const state = read();
    if (
      !state?.session ||
      state.id !== peer.sessionId ||
      peer.url !== origin ||
      peer.token !== state.session.peer.token ||
      state.session.expiresAt <= now()
    )
      throw endedError();
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
    return signed(
      state,
      { operation: "request", token: peer.token, method, path, body },
      init.signal || undefined,
    );
  }
  return {
    prepare,
    claim: (state: FunnelState) => once(state, "claim"),
    status: (state: FunnelState) => once(state, "status"),
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
    keys: browserFunnelKeys(),
    crypto,
    fetch: (...args) => fetch(...args),
  }));
}
export function funnelFetch(peer: Peer, path: string, init: RequestInit = {}) {
  return browserFunnelAgent().request(peer, path, init);
}
