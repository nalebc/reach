// When a phone has no Tailscale app, Reach's page carries its own Tailscale
// node (tailnet/main.go, compiled to WebAssembly). This routes the app's
// requests and WebSockets for tailnet addresses through it, so the rest of
// the app keeps using plain fetch and WebSocket unchanged.

import { nativeBrowser, nativeBrowserFetch } from "./native-browser";

type GoHead = {
  status: number;
  statusText: string;
  headers: string[];
  read(): Promise<Uint8Array | null>;
  cancel(): void;
};
type GoSocket = {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  buffered(): number;
};
export type TailnetStatus = {
  self: { state: string; dnsName?: string; login?: string };
  peers: { dnsName: string; online: boolean }[];
};
export type TailnetNode = {
  start(cb: {
    state(s: string): void;
    authURL(url: string): void;
    error?(kind: string): void;
  }): void;
  login(): void;
  logout(): void;
  status(): TailnetStatus;
  wake(): void;
  fetch(request: {
    url: string;
    method: string;
    headers: string[];
    body: Uint8Array | null;
    redirect: RequestRedirect;
  }): { response: Promise<GoHead>; abort(): void };
  websocket(
    url: string,
    cb: {
      protocols: string[];
      open(protocol: string): void;
      message(data: string | Uint8Array): void;
      close(code: number, reason: string, clean: boolean): void;
    },
  ): GoSocket;
};

export type PrivateWay = "native" | "browser";
type PrivatePeer = { url: string; token: string; transport?: string };
let active: { node: TailnetNode; routed: (url: URL) => boolean } | null = null;
let way: PrivateWay = "native";
const credentials = new Map<string, { origin: string; way: PrivateWay }>();
let installed = false;
export const tailnetBrowser = () => !!active && way === "browser";
export const tailnetNode = () => active?.node;
export const privateWay = () => way;

// A request already in progress may retain its old Peer after a handoff. Its
// device-bound credential must stay on that device's original transport.
export function bindPrivatePeer(peer: PrivatePeer, route: PrivateWay) {
  if (peer.transport === "funnel" || !peer.token) return;
  const origin = new URL(peer.url).origin;
  const old = credentials.get(peer.token);
  if (old && (old.origin !== origin || old.way !== route))
    throw Error("This credential belongs to another private connection.");
  credentials.set(peer.token, { origin, way: route });
}
export const privatePeerWay = (peer: PrivatePeer) => credentials.get(peer.token)?.way;
export function peerUsesBrowserTailnet(peer: PrivatePeer) {
  return peer.transport !== "funnel" && (privatePeerWay(peer) || way) === "browser";
}
export const nativeTailnetFetch = nativeBrowserFetch;
export function usePrivateWay(next: PrivateWay) {
  if (next === "browser" && !active) throw Error("The browser's private connection is not ready.");
  way = next;
}

// Tailnet names (*.ts.net under this tailnet) and Tailscale's 100.64.0.0/10.
export function tailnetRouter(suffix: string) {
  const tail = `.${suffix.toLowerCase().replace(/^\.+|\.+$/g, "")}`;
  return (url: URL) => {
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host.endsWith(tail)) return true;
    const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
    return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
  };
}

const abortError = (signal: AbortSignal) =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
// Errors thrown by app handlers must not unwind into Go and kill a
// connection: report them like an uncaught error instead.
const safely = (f: () => void) => {
  try {
    f();
  } catch (e) {
    (globalThis.reportError ?? console.error)(e);
  }
};

export async function tailnetFetch(
  node: TailnetNode,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const signal = request.signal;
  if (signal.aborted) throw abortError(signal);
  const body = ["GET", "HEAD"].includes(request.method)
    ? null
    : new Uint8Array(await request.arrayBuffer());
  const headers: string[] = [];
  request.headers.forEach((value, key) => headers.push(key, value));
  const call = node.fetch({
    url: request.url,
    method: request.method,
    headers,
    body: body?.byteLength ? body : null,
    redirect: request.redirect,
  });
  let head: GoHead | null = null;
  let stopWaiting: (e: unknown) => void = () => {};
  const onAbort = () => {
    call.abort();
    head?.cancel();
    stopWaiting(abortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const done = () => signal.removeEventListener("abort", onAbort);
  // A late answer to an aborted request is let go of right away.
  void call.response.then(
    (h) => signal.aborted && h.cancel(),
    () => {},
  );
  try {
    head = await new Promise<GoHead>((resolve, reject) => {
      stopWaiting = reject;
      call.response.then(resolve, reject);
    });
  } catch {
    done();
    if (signal.aborted) throw abortError(signal);
    throw new TypeError("Failed to fetch");
  }
  const got = head;
  const empty =
    request.method === "HEAD" || [101, 204, 205, 304].includes(got.status);
  if (got.status < 200 || got.status > 599) {
    got.cancel();
    done();
    throw new TypeError("Failed to fetch");
  }
  const responseHeaders = new Headers();
  for (let i = 0; i + 1 < got.headers.length; i += 2)
    responseHeaders.append(got.headers[i], got.headers[i + 1]);
  let stream: ReadableStream<Uint8Array> | null = null;
  if (empty) {
    got.cancel();
    done();
  } else
    stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await got.read();
          if (chunk) controller.enqueue(chunk);
          else {
            done();
            controller.close();
          }
        } catch {
          done();
          controller.error(
            signal.aborted
              ? abortError(signal)
              : new TypeError("network error"),
          );
        }
      },
      cancel() {
        got.cancel();
        done();
      },
    });
  const response = new Response(stream, {
    status: got.status,
    statusText: got.statusText,
    headers: responseHeaders,
  });
  Object.defineProperty(response, "url", { value: request.url });
  return response;
}

const STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

// Behaves like the browser's WebSocket for the parts Reach uses: readyState,
// binaryType, on* handlers and listeners, bufferedAmount, close codes.
export class TailnetSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState: number = STATES.CONNECTING;
  binaryType: BinaryType = "blob";
  protocol = "";
  extensions = "";
  readonly url: string;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  private socket: GoSocket;
  private ordered: Promise<void> | null = null;
  constructor(
    node: TailnetNode,
    url: string | URL,
    protocols?: string | string[],
  ) {
    super();
    this.url = new URL(url).href;
    for (const type of ["open", "message", "error", "close"] as const)
      this.addEventListener(type, (e) => {
        const handler = this[`on${type}`] as ((ev: Event) => unknown) | null;
        safely(() => handler?.call(this, e));
      });
    this.socket = node.websocket(this.url, {
      protocols: protocols ? [protocols].flat() : [],
      open: (protocol) => {
        if (this.readyState !== STATES.CONNECTING) return;
        this.readyState = STATES.OPEN;
        this.protocol = protocol;
        this.emit(new Event("open"));
      },
      message: (data) => {
        if (this.readyState !== STATES.OPEN) return;
        const payload =
          typeof data === "string"
            ? data
            : this.binaryType === "arraybuffer"
              ? (data.buffer as ArrayBuffer)
              : new Blob([data as Uint8Array<ArrayBuffer>]);
        this.emit(new MessageEvent("message", { data: payload }));
      },
      close: (code, reason, clean) => {
        if (this.readyState === STATES.CLOSED) return;
        this.readyState = STATES.CLOSED;
        if (!clean) this.emit(new Event("error"));
        // Node 22 exposes WebSocket but not CloseEvent. The CLI shares this
        // transport; preserve the browser event shape there as well.
        const event =
          typeof CloseEvent === "function"
            ? new CloseEvent("close", { code, reason, wasClean: clean })
            : Object.assign(new Event("close"), {
                code,
                reason,
                wasClean: clean,
              });
        this.emit(event);
      },
    });
  }
  get bufferedAmount() {
    return this.socket.buffered();
  }
  // dispatchEvent never throws: listener errors are reported by the browser.
  private emit(event: Event) {
    this.dispatchEvent(event);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState === STATES.CONNECTING)
      throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
    if (this.readyState !== STATES.OPEN) return;
    const deliver = (value: string | Uint8Array) => this.socket.send(value);
    // A Blob is read asynchronously; anything sent after it waits its turn.
    if (data instanceof Blob || this.ordered) {
      const previous = this.ordered || Promise.resolve();
      const next = previous.then(async () =>
        deliver(
          data instanceof Blob
            ? new Uint8Array(await data.arrayBuffer())
            : typeof data === "string"
              ? data
              : bytesOf(data),
        ),
      );
      this.ordered = next;
      void next.finally(() => {
        if (this.ordered === next) this.ordered = null;
      });
      return;
    }
    deliver(typeof data === "string" ? data : bytesOf(data));
  }
  close(code?: number, reason?: string) {
    if (this.readyState >= STATES.CLOSING) return;
    this.readyState = STATES.CLOSING;
    this.socket.close(code ?? 1000, reason ?? "");
  }
}
const bytesOf = (data: ArrayBufferLike | ArrayBufferView) =>
  ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

// Reach's own requests, as opposed to the page's files.
const PRIVATE_PATH = /^\/(?:api|ws|download)\//;
// From here on, fetch and WebSocket to tailnet addresses use the page's node.
// The page's own files stay native: they loaded without the tailnet and are
// faster without the relay. Reach itself answers at this same address too
// (one address: Reach for your devices, this page for the internet), so its
// API and WebSockets here go through the node.
export function installTailnet(node: TailnetNode, tailnetSuffix: string, route: PrivateWay = "browser") {
  const viaTailnet = tailnetRouter(tailnetSuffix);
  const routed = (url: URL) =>
    viaTailnet(url) &&
    (url.origin !== new URL(location.href).origin ||
      PRIVATE_PATH.test(url.pathname));
  active = { node, routed };
  way = route;
  installPrivateRouting();
}

export function installPrivateRouting() {
  if (installed) return;
  installed = true;
  const { fetch: nativeFetch, Socket: NativeSocket } = nativeBrowser();
  const routed = (url: URL) => active?.routed(url) ||
    (url.hostname.endsWith(".ts.net") && PRIVATE_PATH.test(url.pathname));
  const credentialRoute = (token: string, url: URL, fallback: PrivateWay) => {
    const old = credentials.get(token);
    if (old && old.origin !== url.origin) throw Error("This credential belongs to another computer address.");
    if (!old) bindPrivatePeer({ url: url.origin, token }, fallback);
    return old?.way || fallback;
  };
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (!routed(url)) return nativeFetch(input, init);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const token = /^Bearer (.+)$/.exec(headers.get("Authorization") || "")?.[1];
    const route = token ? credentialRoute(token, url, way) : way;
    if (route === "native") return nativeFetch(input, init);
    if (!active) return Promise.reject(new TypeError("The browser's private connection is unavailable."));
    return tailnetFetch(active.node, input instanceof Request ? input : url.href, init);
  };
  const Socket = function (url: string | URL, protocols?: string | string[]) {
    const target = new URL(url, location.href);
    if (!routed(target)) return new NativeSocket(url, protocols);
    const route = way;
    const socket = route === "browser" && active
      ? new TailnetSocket(active.node, target, protocols)
      : new NativeSocket(url, protocols);
    const send = socket.send?.bind(socket);
    if (send) socket.send = (data: Parameters<WebSocket["send"]>[0]) => {
      if (typeof data === "string") {
        let auth;
        try { auth = JSON.parse(data); } catch { /* Stream payload, not authentication. */ }
        if (auth?.type === "auth" && typeof auth.token === "string") {
          // WebSockets open before their first auth frame. A stale callback
          // may have created this socket just as the active route changed.
          // Close it without ever sending the other device's credential.
          const http = new URL(target);
          http.protocol = http.protocol === "wss:" ? "https:" : "http:";
          try {
            if (credentialRoute(auth.token, http, route) !== route) {
              socket.close(4000, "Private connection changed");
              return;
            }
          } catch {
            socket.close(4000, "Private connection changed");
            return;
          }
        }
      }
      send(data);
    };
    return socket;
  } as unknown as typeof WebSocket;
  Object.assign(Socket, STATES);
  window.WebSocket = Socket;
}
