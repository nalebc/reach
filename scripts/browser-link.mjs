import https from "node:https";
import { publicNameAddresses } from "../server/public-dns.mjs";

// Force the connection to the public DNS answer. An ordinary fetch on the
// host uses MagicDNS and can succeed even when no phone can find the page.
export function readPublicStart(url, address, { get = https.get, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = get(url, {
      agent: false,
      servername: url.hostname,
      lookup: (_host, options, done) => options?.all
        ? done(null, [{ address, family: 4 }])
        : done(null, address, 4),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 65536) return req.destroy(Error("The browser start page was too large."));
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString()) : null);
        } catch { resolve(null); }
      });
    });
    const timer = setTimeout(() => req.destroy(Error("The public browser link did not answer.")), timeoutMs);
    timer.unref?.();
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
  });
}

export async function checkBrowserLink(origin, instance, { resolve = publicNameAddresses, read = readPublicStart } = {}) {
  const url = new URL("/reach-start.json", origin);
  if (url.protocol !== "https:" || url.port || !url.hostname.endsWith(".ts.net"))
    return { ready: false, reason: "A browser connection needs Reach's public HTTPS link." };
  const dns = await resolve(url.hostname);
  if (!dns.addresses.length)
    return { ready: false, reason: dns.state === "missing"
      ? "Tailscale is still publishing this computer's public address."
      : "Reach couldn't verify this computer's public DNS yet." };
  for (const address of dns.addresses.slice(0, 2)) {
    try {
      const config = await read(url, address);
      if (config?.product !== "Reach" || config.instance !== instance) continue;
      if (!config.tailnet?.wasm || !config.tailnet?.exec)
        return { ready: false, reason: "The browser sign-in client is missing. Reinstall Reach or build its browser client." };
      return { ready: true };
    } catch { /* A transient DNS/TLS/relay failure is retried while Reach runs. */ }
  }
  return { ready: false, reason: "The public browser page is not reachable yet. Keep Reach open while Tailscale connects it." };
}
