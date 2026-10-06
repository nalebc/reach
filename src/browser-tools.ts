import { peerFetch, request, type Peer } from "./api";
import { browserToolsFor, browserToolRequest, type BrowserAccess, type BrowserTool } from "../server/browser-tools.mjs";
export type { BrowserAccess, BrowserTool } from "../server/browser-tools.mjs";

export type BrowserToolBridge = {
  listTools: () => Promise<BrowserTool[]>;
  callTool: (name: string, args?: unknown) => Promise<unknown>;
};
declare global { interface Window { reach?: BrowserToolBridge } }
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function screenResult(response: Response) {
  const mimeType = response.headers.get("content-type")?.split(";")[0].trim();
  if (!["image/jpeg", "image/png"].includes(mimeType || "")) throw Error("Reach returned an unsupported screen image.");
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw Error("The screen image is too large.");
  const reader = response.body?.getReader();
  if (!reader) throw Error("Reach did not return a screen image.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw Error("The screen image is too large.");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return { image: btoa(binary), mimeType };
}

// The public object never contains a token, key, peer or generic request method.
// Captured references stop working too when the workspace ends or changes peer.
export function createBrowserToolBridge(peer: Peer, onError: (error: unknown) => void = () => {}) {
  let disposed = false;
  let expiresAt = Infinity;
  const pending = new Set<AbortController>();
  const active = () => {
    if (disposed || expiresAt <= Date.now()) throw Error("This Reach session has ended. Open a new invitation.");
  };
  const run = async <T,>(operation: (signal: AbortSignal) => Promise<T>) => {
    active();
    const controller = new AbortController();
    pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const result = await operation(controller.signal);
      active();
      if (controller.signal.aborted) throw Error("This Reach tool call was cancelled.");
      return result;
    } catch (error) {
      if ((error as { status?: number })?.status === 401) {
        dispose();
        onError(error);
      }
      throw error;
    } finally { clearTimeout(timeout); pending.delete(controller); }
  };
  const readAccess = async (signal: AbortSignal) => {
    const access = await request<BrowserAccess>(peer, "/api/browser", { signal });
    expiresAt = access.expiresAt;
    active();
    return access;
  };
  const bridge: BrowserToolBridge = Object.freeze({
    listTools: () => run(async (signal) => browserToolsFor(await readAccess(signal))),
    callTool: (name: string, args: unknown = {}) => run(async (signal) => {
      const access = await readAccess(signal);
      const plan = browserToolRequest(name, args, access);
      if (name === "reach_access") return access;
      const options = { method: plan.method, ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }), signal };
      if (plan.response === "json") return request(peer, plan.route, options);
      const response = await peerFetch(peer, plan.route, { ...options, cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw Object.assign(Error(body.error || "The shared screen could not be read."), { status: response.status });
      }
      return screenResult(response);
    }),
  });
  function dispose() {
    disposed = true;
    for (const operation of pending) operation.abort();
    pending.clear();
  }
  return { bridge, dispose };
}

let installed: { dispose: () => void } | undefined;
export function installBrowserTools(peer: Peer, onError?: (error: unknown) => void) {
  installed?.dispose();
  const session = createBrowserToolBridge(peer, onError);
  // Never leave another session's bridge callable after replacing it.
  Object.defineProperty(window, "reach", { value: session.bridge, writable: false, configurable: true });
  const installation = {
    bridge: session.bridge,
    dispose() {
      session.dispose();
      if (window.reach === session.bridge) delete window.reach;
      if (installed === installation) installed = undefined;
    },
  };
  installed = installation;
  return installation;
}
