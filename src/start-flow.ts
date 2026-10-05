import type { TailnetStatus } from "./tailnet-transport";

// Decisions behind the public start page, kept free of the DOM for tests.

export type StartConfig = {
  product: "Reach";
  origin: string;
  name: string;
  instance: string;
  tailnet: { wasm: string; exec: string } | null;
};

const FILE = /^[\w.-]+$/;
export function parseStartConfig(value: unknown): StartConfig | null {
  const v = value as Partial<StartConfig> | null;
  try {
    if (
      v?.product !== "Reach" ||
      typeof v.name !== "string" ||
      typeof v.instance !== "string" ||
      typeof v.origin !== "string"
    )
      return null;
    const origin = new URL(v.origin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== v.origin ||
      !origin.hostname.endsWith(".ts.net")
    )
      return null;
    const tailnet =
      v.tailnet &&
      FILE.test(v.tailnet.wasm || "") &&
      FILE.test(v.tailnet.exec || "")
        ? { wasm: v.tailnet.wasm, exec: v.tailnet.exec }
        : null;
    return {
      product: "Reach",
      origin: v.origin,
      name: v.name.slice(0, 80),
      instance: v.instance,
      tailnet,
    };
  } catch {
    return null;
  }
}

// "mac.tail1234.ts.net" -> "tail1234.ts.net"
export const tailnetSuffix = (origin: string) =>
  new URL(origin).hostname.split(".").slice(1).join(".");

// How this browser shows up in Tailscale and in Reach's approval prompt.
export function browserHostname(ua: string) {
  if (/iPhone/.test(ua)) return "iphone-browser";
  if (/iPad/.test(ua)) return "ipad-browser";
  if (/Android/.test(ua)) return "android-browser";
  if (/Macintosh/.test(ua)) return "mac-browser";
  if (/Windows/.test(ua)) return "windows-browser";
  return "reach-browser";
}

export function appLink(ua: string) {
  if (/iPhone|iPad|Macintosh.*Mobile/.test(ua))
    return "https://apps.apple.com/app/tailscale/id1470499037";
  if (/Android/.test(ua))
    return "https://play.google.com/store/apps/details?id=com.tailscale.ipn";
  return "https://tailscale.com/download";
}

// Is this phone already on the tailnet (Tailscale app on)? Then the private
// address answers directly, and that path is always preferred.
export async function probeDirect(
  config: StartConfig,
  fetcher: typeof fetch = fetch,
  timeoutMs = 1800,
) {
  try {
    const response = await fetcher(`${config.origin}/api/health`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const health = await response.json();
    // Another computer (an invitation's) has its own instance: any Reach.
    return (
      health?.product === "Reach" &&
      (!config.instance || health.instance === config.instance)
    );
  } catch {
    return false;
  }
}

// Same page on the private address; the fragment (pairing, invitation) stays.
export function directUrl(
  config: StartConfig,
  where: { pathname: string; hash: string },
) {
  const path = where.pathname === "/guest" ? "/guest" : "/";
  return `${config.origin}${path}${where.hash}`;
}

// Once signed in: can this Tailscale account see the computer?
export function homeReachable(
  status: TailnetStatus,
  origin: string,
): "ok" | "offline" | "missing" {
  const host = new URL(origin).hostname.toLowerCase();
  const peer = status.peers.find(
    (p) => p.dnsName.toLowerCase().replace(/\.$/, "") === host,
  );
  return !peer ? "missing" : peer.online === false ? "offline" : "ok";
}

// An invitation link: /guest#k=<one-time Tailscale key>&h=<device name>
// &i=<computer address>~<invitation> (one i per invited computer). Older
// links carry just invite=<invitation> for the computer serving the page.
export type GuestLink = {
  key: string;
  hostname: string;
  invites: { origin: string; secret: string }[];
};
const SECRET = /^[A-Za-z0-9_-]{43}$/;
export function parseGuestLink(hash: string, fallbackOrigin = ""): GuestLink {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const key = params.get("k") || "";
  const hostname = params.get("h") || "";
  const invites: GuestLink["invites"] = [];
  for (const entry of params.getAll("i")) {
    const [origin, secret] = entry.split("~");
    try {
      const u = new URL(origin);
      if (
        u.protocol === "https:" &&
        u.origin === origin &&
        u.hostname.endsWith(".ts.net") &&
        SECRET.test(secret || "") &&
        !invites.some((x) => x.origin === origin)
      )
        invites.push({ origin, secret });
    } catch {}
  }
  const legacy = params.get("invite") || "";
  if (!invites.length && fallbackOrigin && SECRET.test(legacy))
    invites.push({ origin: fallbackOrigin, secret: legacy });
  return {
    key: /^tskey-auth-[A-Za-z0-9-]{10,200}$/.test(key) ? key : "",
    hostname: /^rg-[a-z0-9]{4}-[a-z0-9]{10}$/.test(hostname) ? hostname : "",
    invites: invites.slice(0, 10),
  };
}

// The same link without the key (it's single use and never kept in history).
export const guestHash = (invites: GuestLink["invites"]) =>
  invites.length
    ? `#${new URLSearchParams(invites.map((x) => ["i", `${x.origin}~${x.secret}`])).toString()}`
    : "";

// An agent's link is the same on /agent: its start page never redeems it.
export function guestLinkUrl(
  start: string,
  link: GuestLink,
  path: "/guest" | "/agent" = "/guest",
) {
  const params = new URLSearchParams();
  if (link.key) params.set("k", link.key);
  if (link.hostname) params.set("h", link.hostname);
  for (const x of link.invites) params.append("i", `${x.origin}~${x.secret}`);
  return `${start}${path}#${params.toString()}`;
}
