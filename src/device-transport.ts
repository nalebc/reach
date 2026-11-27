import { nativeBrowser, nativeBrowserFetch } from "./native-browser";
import { installFunnelTransport, privatePeerWay, privateWay, type PrivateWay } from "./tailnet-transport";

export type DeviceJwk = {
  crv: "P-256";
  kty: "EC";
  x: string;
  y: string;
};

export type DeviceKeyMaterial = {
  pair: CryptoKeyPair;
  jwk: DeviceJwk;
  thumbprint: string;
};

const DB_NAME = "reach-device-keys";
const STORE_NAME = "keys";
const KEY_ID = "default";
const PAIRING_TOKEN_KEY = "reach.pairing-token";
const PAIRING_CODE_KEY = "reach.pairing-code";
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const PAIR_CODE_RE = /^\d{8}$/;

let cachedKeyPromise: Promise<DeviceKeyMaterial> | null = null;
let memoryPairingToken = "";
let memoryPairingCode: { code: string; name: string } | null = null;
const boundFunnelPeers = new Set<string>();

function base64url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeTextBase64Url(text: string): string {
  return base64url(new TextEncoder().encode(text));
}

function randomNonce(bytes = 18): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function validKeyPair(pair: unknown): pair is CryptoKeyPair {
  const candidate = pair as CryptoKeyPair | undefined;
  return (
    !!candidate &&
    candidate.privateKey?.type === "private" &&
    candidate.privateKey.extractable === false &&
    candidate.privateKey.algorithm?.name === "ECDSA" &&
    (candidate.privateKey.algorithm as EcKeyAlgorithm).namedCurve === "P-256" &&
    candidate.privateKey.usages.includes("sign") &&
    candidate.publicKey?.type === "public"
  );
}

function withStorageTimeout<T>(promise: Promise<T>, ms = 1500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("IndexedDB timed out after suspension")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function openKeyDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
  return withStorageTimeout(
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME))
          req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    }),
  );
}

async function readStoredKeyPair(): Promise<CryptoKeyPair | null> {
  const db = await openKeyDb();
  try {
    return await withStorageTimeout(
      new Promise<CryptoKeyPair | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(KEY_ID);
        tx.oncomplete = () => resolve(validKeyPair(req.result) ? req.result : null);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB read failed"));
      }),
    );
  } finally {
    db.close();
  }
}

async function writeStoredKeyPair(pair: CryptoKeyPair): Promise<void> {
  const db = await openKeyDb();
  try {
    await withStorageTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(pair, KEY_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB write failed"));
      }),
    );
  } finally {
    db.close();
  }
}

async function materializeKey(pair: CryptoKeyPair): Promise<DeviceKeyMaterial> {
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported.kty !== "EC" || exported.crv !== "P-256" || !exported.x || !exported.y)
    throw new Error("Invalid exported P-256 key.");
  const jwk: DeviceJwk = {
    crv: "P-256",
    kty: "EC",
    x: exported.x,
    y: exported.y,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(jwk)),
  );
  return { pair, jwk, thumbprint: base64url(digest) };
}

export function ensureDeviceKey(): Promise<DeviceKeyMaterial> {
  if (cachedKeyPromise) return cachedKeyPromise;
  cachedKeyPromise = (async () => {
    let pair: CryptoKeyPair | null = null;
    try {
      pair = await readStoredKeyPair();
    } catch {
      pair = null;
    }
    if (!pair) {
      pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      try {
        await writeStoredKeyPair(pair);
        const reread = await readStoredKeyPair();
        if (reread) pair = reread;
      } catch {
        /* Private browsing or blocked storage keeps the key in memory for this visit. */
      }
    }
    return materializeKey(pair);
  })();
  cachedKeyPromise.catch(() => {
    cachedKeyPromise = null;
  });
  return cachedKeyPromise;
}

export async function signDeviceText(privateKey: CryptoKey, text: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(text),
  );
  return base64url(sig);
}

export function capturePairingUrl(cleanUrl = true): {
  pairingToken: string;
  pairingCode: { code: string; name: string } | null;
} {
  if (typeof window === "undefined")
    return { pairingToken: memoryPairingToken, pairingCode: memoryPairingCode };
  try {
    const raw = window.location.hash.replace(/^#/, "");
    if (raw) {
      const params = new URLSearchParams(raw);
      let changed = false;
      const p = params.get("p") || "";
      if (SECRET_RE.test(p)) {
        memoryPairingToken = p;
        try {
          sessionStorage.setItem(PAIRING_TOKEN_KEY, p);
        } catch {}
        params.delete("p");
        changed = true;
      }
      const code = (params.get("pair") || "").replace(/\s/g, "");
      if (PAIR_CODE_RE.test(code)) {
        const entry = { code, name: params.get("name") || "" };
        memoryPairingCode = entry;
        try {
          sessionStorage.setItem(PAIRING_CODE_KEY, JSON.stringify(entry));
        } catch {}
        if (cleanUrl) {
          params.delete("pair");
          params.delete("name");
          changed = true;
        }
      }
      if (cleanUrl && changed) {
        const nextHash = params.toString();
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`,
        );
      }
    }
  } catch {}
  return {
    pairingToken: readCapturedPairingToken(),
    pairingCode: readCapturedPairingCode(),
  };
}

export function readCapturedPairingToken(): string {
  if (memoryPairingToken) return memoryPairingToken;
  try {
    const stored = sessionStorage.getItem(PAIRING_TOKEN_KEY) || "";
    if (SECRET_RE.test(stored)) {
      memoryPairingToken = stored;
      return stored;
    }
  } catch {}
  return "";
}

export function readCapturedPairingCode(): { code: string; name: string } | null {
  if (memoryPairingCode) return memoryPairingCode;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PAIRING_CODE_KEY) || "null");
    if (parsed && PAIR_CODE_RE.test(parsed.code || "")) {
      const entry = { code: parsed.code, name: typeof parsed.name === "string" ? parsed.name : "" };
      memoryPairingCode = entry;
      return entry;
    }
  } catch {}
  return null;
}

export function clearCapturedPairingCode(): void {
  memoryPairingCode = null;
  try {
    sessionStorage.removeItem(PAIRING_CODE_KEY);
  } catch {}
}

export function publicOriginForUrl(url: URL, fallbackOrigin: string): string {
  if (url.protocol === "https:" && url.hostname.endsWith(".ts.net"))
    return `https://${url.hostname.toLowerCase()}`;
  return fallbackOrigin;
}

// Fast private-first probe across candidate origins (e.g. [config.home, config.origin]).
// Resolves immediately when the preferred private origin responds, or null within timeoutMs.
export async function probePrivateOrigin(
  origins: (string | undefined)[],
  {
    timeoutMs = 850,
    expectedInstance = "",
    fetcher = nativeBrowserFetch,
  }: {
    timeoutMs?: number;
    expectedInstance?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<string | null> {
  const unique = [...new Set(origins.filter((v): v is string => !!v))];
  if (!unique.length) return null;
  const checkOne = async (origin: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher(`${origin}/api/health?probe=1`, {
        cache: "no-store",
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const health = await res.json();
      if (
        health?.product === "Reach" &&
        health.transport !== "funnel" &&
        (!expectedInstance || health.instance === expectedInstance)
      )
        return origin;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const checks = unique.map(checkOne);
  const first = await checks[0];
  if (first) return first;
  for (let i = 1; i < checks.length; i++) {
    const hit = await checks[i];
    if (hit) return hit;
  }
  return null;
}

export async function probeFunnelOrigin(
  publicOrigin: string,
  {
    timeoutMs = 1500,
    expectedInstance = "",
  }: {
    timeoutMs?: number;
    expectedInstance?: string;
  } = {},
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await funnelDeviceFetch(
      publicOrigin,
      `${publicOrigin}/api/health?probe=1`,
      { cache: "no-store", signal: controller.signal },
    );
    if (!res.ok) return false;
    const health = await res.json();
    return (
      health?.product === "Reach" &&
      (!expectedInstance || health.instance === expectedInstance)
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function signedJsonFetch(
  funnelOrigin: string,
  method: string,
  path: string,
  bodyBytes: Uint8Array,
  headersInput: Headers,
  signal?: AbortSignal | null,
  retryFresh = true,
): Promise<Response> {
  const key = await ensureDeviceKey();
  const digest = await crypto.subtle.digest("SHA-256", bodyBytes as Uint8Array<ArrayBuffer>);
  const payload = JSON.stringify({
    v: 1,
    audience: funnelOrigin,
    method,
    path,
    issuedAt: Date.now(),
    nonce: randomNonce(18),
    bodySha256: base64url(digest),
  });
  const signature = await signDeviceText(key.pair.privateKey, payload);
  const headers = new Headers(headersInput);
  headers.set("Reach-Device-Key", key.thumbprint);
  headers.set("Reach-Device-Payload", encodeTextBase64Url(payload));
  headers.set("Reach-Device-Signature", signature);
  headers.set("Reach-Device-Jwk", encodeTextBase64Url(JSON.stringify(key.jwk)));
  const pairingToken = readCapturedPairingToken();
  if (pairingToken) headers.set("Reach-Pairing-Token", pairingToken);
  if (bodyBytes.byteLength > 0 && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const res = await nativeBrowserFetch(`${funnelOrigin}${path}`, {
    method,
    headers,
    body: bodyBytes.byteLength > 0 ? (bodyBytes as Uint8Array<ArrayBuffer>) : undefined,
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
    signal: signal || undefined,
  });
  if (
    retryFresh &&
    !signal?.aborted &&
    res.status === 400 &&
    res.headers.get("Reach-Not-Run") === "1" &&
    res.headers.get("Reach-Retry") === "fresh-signature"
  ) {
    return signedJsonFetch(funnelOrigin, method, path, bodyBytes, headersInput, signal, false);
  }
  return res;
}

export async function funnelDeviceFetch(
  defaultOrigin: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const baseHref = typeof location !== "undefined" ? location.href : defaultOrigin;
  const targetUrl = new URL(
    input instanceof Request ? input.url : String(input),
    baseHref,
  );
  const funnelOrigin = publicOriginForUrl(targetUrl, defaultOrigin);
  const path = `${targetUrl.pathname}${targetUrl.search}`;

  if (targetUrl.pathname.startsWith("/download/")) {
    return nativeBrowserFetch(`${funnelOrigin}${path}`, init);
  }

  const method = (
    init?.method ||
    (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : undefined),
  );
  const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
  const rawBody = init?.body;
  const contentType = headers.get("Content-Type") || "";
  const isStream =
    rawBody instanceof FormData ||
    rawBody instanceof Blob ||
    rawBody instanceof ArrayBuffer ||
    ArrayBuffer.isView(rawBody) ||
    (typeof ReadableStream !== "undefined" && rawBody instanceof ReadableStream) ||
    headers.has("Range") ||
    /^(?:application\/octet-stream|multipart\/form-data)\b/i.test(contentType);

  if (isStream && path.startsWith("/api/")) {
    const ticketBody = new TextEncoder().encode(JSON.stringify({ method, path }));
    const ticketHeaders = new Headers();
    const auth = headers.get("Authorization");
    if (auth) ticketHeaders.set("Authorization", auth);
    ticketHeaders.set("Content-Type", "application/json");
    const ticketRes = await signedJsonFetch(
      funnelOrigin,
      "POST",
      "/api/device/stream-ticket",
      ticketBody,
      ticketHeaders,
      signal,
    );
    if (!ticketRes.ok) return ticketRes;
    const { ticket } = (await ticketRes.json()) as { ticket?: string };
    if (typeof ticket !== "string" || !ticket)
      throw new TypeError("Stream ticket was not issued.");
    headers.set("Reach-Stream-Ticket", ticket);
    return nativeBrowserFetch(`${funnelOrigin}${path}`, {
      ...init,
      method,
      headers,
      redirect: "error",
      signal,
    });
  }

  let bodyBytes: Uint8Array;
  if (["GET", "HEAD"].includes(method)) {
    bodyBytes = new Uint8Array(0);
  } else if (typeof rawBody === "string") {
    bodyBytes = new TextEncoder().encode(rawBody);
  } else if (rawBody == null && input instanceof Request) {
    bodyBytes = new Uint8Array(await input.clone().arrayBuffer());
  } else {
    bodyBytes = new Uint8Array(0);
  }
  return signedJsonFetch(funnelOrigin, method, path, bodyBytes, headers, signal);
}

const STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;
const safely = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    (globalThis.reportError ?? console.error)(e);
  }
};

export class FunnelDeviceSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState: number = STATES.CONNECTING;
  protocol = "";
  extensions = "";
  readonly url: string;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;

  private _binaryType: BinaryType = "blob";
  private inner: WebSocket | null = null;
  private connecting = false;
  private queue: Parameters<WebSocket["send"]>[0][] = [];
  private ticketAbort = new AbortController();
  private readonly funnelOrigin: string;
  private readonly wsPath: string;
  private readonly protocols?: string | string[];

  constructor(
    defaultOrigin: string,
    url: string | URL,
    protocols?: string | string[],
  ) {
    super();
    const baseHref = typeof location !== "undefined" ? location.href : defaultOrigin;
    const parsed = new URL(url, baseHref);
    this.url = parsed.href;
    const httpTarget = new URL(parsed.href);
    httpTarget.protocol = httpTarget.protocol === "wss:" ? "https:" : "http:";
    this.funnelOrigin = publicOriginForUrl(httpTarget, defaultOrigin);
    this.wsPath = parsed.pathname;
    this.protocols = protocols;

    for (const type of ["open", "message", "error", "close"] as const) {
      this.addEventListener(type, (e) => {
        const handler = this[`on${type}`] as ((ev: Event) => unknown) | null;
        safely(() => handler?.call(this, e));
      });
    }

    queueMicrotask(() => {
      if (this.readyState !== STATES.CONNECTING) return;
      this.readyState = STATES.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  get binaryType(): BinaryType {
    return this._binaryType;
  }
  set binaryType(value: BinaryType) {
    this._binaryType = value;
    if (this.inner) this.inner.binaryType = value;
  }

  get bufferedAmount(): number {
    return this.inner ? this.inner.bufferedAmount : 0;
  }

  private finishClose(code: number, reason: string, clean: boolean) {
    if (this.readyState === STATES.CLOSED) return;
    this.readyState = STATES.CLOSED;
    if (!clean) this.dispatchEvent(new Event("error"));
    const event =
      typeof CloseEvent === "function"
        ? new CloseEvent("close", { code, reason, wasClean: clean })
        : Object.assign(new Event("close"), { code, reason, wasClean: clean });
    this.dispatchEvent(event);
  }

  private async openBackingSocket(token: string) {
    this.connecting = true;
    try {
      const res = await funnelDeviceFetch(
        this.funnelOrigin,
        `${this.funnelOrigin}/api/device/ws-ticket`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: this.wsPath }),
          signal: this.ticketAbort.signal,
        },
      );
      if (this.readyState >= STATES.CLOSING) return;
      if (!res.ok) {
        const denied = res.status === 401 || res.status === 403;
        this.finishClose(
          res.status === 401 ? 4001 : res.status === 403 ? 4003 : 1006,
          denied ? "Access denied" : "Connection unavailable",
          denied,
        );
        return;
      }
      const { ticket } = (await res.json()) as { ticket?: string };
      if (this.readyState >= STATES.CLOSING) return;
      if (typeof ticket !== "string" || !ticket) {
        this.finishClose(1006, "Ticket unavailable", false);
        return;
      }
      const { Socket: NativeSocket } = nativeBrowser();
      const wsOrigin = this.funnelOrigin.replace(/^http/, "ws");
      const wsUrl = `${wsOrigin}${this.wsPath}?ticket=${encodeURIComponent(ticket)}`;
      const socket = this.protocols
        ? new NativeSocket(wsUrl, this.protocols)
        : new NativeSocket(wsUrl);
      socket.binaryType = this._binaryType;
      this.inner = socket;

      socket.onopen = () => {
        if (this.readyState >= STATES.CLOSING) {
          socket.close(1000, "");
          return;
        }
        this.protocol = socket.protocol || "";
        this.extensions = socket.extensions || "";
        const pending = this.queue.splice(0);
        for (const frame of pending) socket.send(frame);
      };
      socket.onmessage = (event) => {
        if (this.readyState !== STATES.OPEN) return;
        this.dispatchEvent(new MessageEvent("message", { data: event.data }));
      };
      socket.onerror = () => {
        /* Close event handles error + close ordering consistently. */
      };
      socket.onclose = (event) => {
        this.inner = null;
        this.finishClose(event.code || 1006, event.reason || "", !!event.wasClean);
      };
    } catch {
      if (this.readyState < STATES.CLOSING) {
        this.finishClose(1006, "Connection failed", false);
      }
    }
  }

  send(data: Parameters<WebSocket["send"]>[0]) {
    if (this.readyState === STATES.CONNECTING)
      throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
    if (this.readyState !== STATES.OPEN) return;

    if (this.inner && this.inner.readyState === STATES.OPEN) {
      this.inner.send(data);
      return;
    }
    this.queue.push(data);
    if (!this.connecting && typeof data === "string") {
      try {
        const parsed = JSON.parse(data);
        if (parsed?.type === "auth" && typeof parsed.token === "string" && parsed.token) {
          void this.openBackingSocket(parsed.token);
        }
      } catch {}
    }
  }

  close(code?: number, reason?: string) {
    if (this.readyState >= STATES.CLOSING) return;
    this.readyState = STATES.CLOSING;
    this.ticketAbort.abort();
    this.queue.length = 0;
    if (this.inner) {
      this.inner.close(code ?? 1000, reason ?? "");
    } else {
      queueMicrotask(() => this.finishClose(code ?? 1000, reason ?? "", true));
    }
  }
}

export function createFunnelSocketClass(defaultOrigin: string): typeof WebSocket {
  const Bound = function (url: string | URL, protocols?: string | string[]) {
    return new FunnelDeviceSocket(defaultOrigin, url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Bound, STATES);
  return Bound;
}

export function activateFunnelTransport(
  publicOrigin: string,
  route: PrivateWay = "funnel",
) {
  installFunnelTransport(
    {
      fetch: (input, init) => funnelDeviceFetch(publicOrigin, input, init),
      Socket: createFunnelSocketClass(publicOrigin),
    },
    route,
  );
}

// Silently register this browser's P-256 Funnel key onto an active private grant
// so that if Tailscale turns off later, Funnel fallback works immediately.
export async function ensureFunnelKeyBound(peer: {
  id: string;
  url: string;
  token: string;
  transport?: string;
}): Promise<boolean> {
  if (!peer?.id || !peer.token || peer.transport === "funnel") return false;
  let parsed: URL;
  try {
    parsed = new URL(peer.url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".ts.net"))
    return false;
  const cacheId = `${peer.id}:${peer.token}`;
  if (boundFunnelPeers.has(cacheId)) return true;
  try {
    const key = await ensureDeviceKey();
    if (privateWay() !== "native" || privatePeerWay(peer) === "browser")
      return false;
    const issuedAt = Date.now();
    const nonce = randomNonce(18);
    const payload = `reach-bind-funnel-v1\n${peer.id}\n${key.thumbprint}\n${issuedAt}\n${nonce}`;
    const signature = await signDeviceText(key.pair.privateKey, payload);
    const res = await nativeBrowserFetch(`${parsed.origin}/api/device/funnel-key`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${peer.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        publicKey: key.jwk,
        issuedAt,
        nonce,
        signature,
      }),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok || res.status === 404) {
      boundFunnelPeers.add(cacheId);
      return res.ok;
    }
  } catch {}
  return false;
}

// Bind a newly-detected private Tailscale identity onto a Funnel-enrolled grant.
export async function bindPrivateRoute(
  privateOrigin: string,
  token: string,
): Promise<boolean> {
  if (!privateOrigin || !token) return false;
  let parsed: URL;
  try {
    parsed = new URL(privateOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".ts.net"))
    return false;
  try {
    const key = await ensureDeviceKey();
    const issuedAt = Date.now();
    const nonce = randomNonce(18);
    const payload = `reach-bind-private-v1\n${parsed.hostname.toLowerCase()}\n${key.thumbprint}\n${issuedAt}\n${nonce}`;
    const signature = await signDeviceText(key.pair.privateKey, payload);
    const res = await nativeBrowserFetch(`${parsed.origin}/api/device/bind-private`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        keyThumbprint: key.thumbprint,
        issuedAt,
        nonce,
        signature,
      }),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
