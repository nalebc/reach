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
  const check = async () => {
    try {
      const audience = new URL(origin);
      if (audience.protocol !== "https:" || !audience.hostname.endsWith(".ts.net")) return origin;
      if (!privateOrigin) {
        const config = parseStartConfig(await read(`${origin}/reach-start.json`));
        if (!config || new URL(config.origin).hostname !== audience.hostname) return origin;
        privateOrigin = config.origin;
      }
      if (privateOrigin === origin) return origin;
      const health = await read(`${privateOrigin}/api/health`);
      // Runtime instance IDs change on a normal Reach restart. Authorization
      // remains the unchanged signed grant, checked by the private gateway.
      return health?.product === "Reach" ? privateOrigin : origin;
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
