import { parseStartConfig } from "./start-flow";

export type PrivateGatewayRoute = {
  endpoint(): Promise<string>;
  failed(endpoint: string): void;
};

// A signed invitation grant is valid on both gateway routes. Public is used
// only when its same-computer private endpoint cannot currently be reached.
// The probe contains no token/key/invitation, and never retries an action.
export function privateGatewayRoute({ origin, fetch: fetcher, now = Date.now, every = 15000 }: {
  origin: string;
  fetch: typeof fetch;
  now?: () => number;
  every?: number;
}): PrivateGatewayRoute {
  let selected = origin, checkAt = 0;
  let privateOrigin = "";
  let checking: Promise<string> | null = null;
  const read = async (url: string) => {
    const response = await fetcher(url, {
      cache: "no-store", redirect: "error", credentials: "omit",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw Object.assign(Error("The private connection refused this request."), { status: response.status });
    return response.json();
  };
  const reachable = async (endpoint: string) => {
    try { return (await read(`${endpoint}/api/health`))?.product === "Reach"; }
    catch (error) {
      const status = (error as { status?: number })?.status;
      if (status && status !== 503) throw error;
      return false;
    }
  };
  const check = async () => {
    try {
      const audience = new URL(origin);
      if (audience.protocol !== "https:" || !audience.hostname.endsWith(".ts.net")) return origin;
      // Runtime instance IDs change on a normal Reach restart. Authorization
      // remains the unchanged signed grant, checked by the private gateway.
      const previous = privateOrigin;
      if (previous && previous !== origin && await reachable(previous)) return previous;
      // Reach may select another private port after a restart. Refresh only
      // after availability loss; a healthy cached path does not depend on the
      // public bootstrap. A reachable policy/auth/rate refusal still throws.
      let metadata;
      try { metadata = await read(`${origin}/reach-start.json`); }
      catch {
        // The asset door can close while a known signing key still reaches
        // its gateway, including after a reload with no cached discovery.
        // Public metadata is optional; gateway authorization stays separate.
        // A private health refusal already threw above and is not caught here.
        return origin;
      }
      const config = parseStartConfig(metadata);
      privateOrigin = config && new URL(config.origin).hostname === audience.hostname ? config.origin : "";
      if (privateOrigin && privateOrigin !== origin && privateOrigin !== previous && await reachable(privateOrigin)) return privateOrigin;
      return origin;
    } catch (error) {
      // A reachable private policy/auth/rate refusal is authoritative. Only
      // network loss or the credential-free availability pause allows public.
      const status = (error as { status?: number })?.status;
      if (status && status !== 503) throw error;
      return origin;
    }
  };
  return {
    endpoint() {
      if (now() < checkAt) return Promise.resolve(selected);
      checking ||= check().then(endpoint => {
        selected = endpoint;
        checkAt = now() + every;
        return selected;
      }).finally(() => { checking = null; });
      return checking;
    },
    failed(endpoint) {
      if (endpoint !== origin) {
        selected = origin;
        checkAt = now() + every;
      }
    },
  };
}
