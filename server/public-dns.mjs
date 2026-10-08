import dns from "node:dns";

// Whether the internet can find a Funnel name: "published", "missing" or
// "unknown". Tailscale publishes the public record itself and sometimes never
// does (tailscale/tailscale#21502), and the link then fails for every agent.
// The answer comes from the zone's own nameservers: this Mac's resolver is
// MagicDNS, which always knows the name, and asking a shared resolver would
// leave a cached "not found" for the agent to hit after the record appears.
export async function publicNameState(hostname, {
  resolver = () => new dns.promises.Resolver({ timeout: 2500, tries: 1 }),
  system = dns.promises,
} = {}) {
  const zone = String(hostname).split(".").slice(-2).join(".");
  if (!zone.includes(".")) return "unknown";
  let servers;
  try {
    const names = await system.resolveNs(zone);
    servers = (await Promise.all(names.slice(0, 2).map((name) =>
      system.resolve4(name).catch(() => [])))).flat();
  } catch { return "unknown"; }
  if (!servers.length) return "unknown";
  try {
    const ask = resolver();
    ask.setServers(servers);
    const answers = await ask.resolve4(hostname);
    return answers.length ? "published" : "unknown";
  } catch (error) {
    // Only the zone itself saying "no such name" counts as missing.
    return error?.code === "ENOTFOUND" ? "missing" : "unknown";
  }
}
