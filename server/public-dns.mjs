import dns from "node:dns";

// Whether the internet can find a Funnel name: "published", "missing" or
// "unknown". Tailscale publishes the public record itself and sometimes never
// does (tailscale/tailscale#21502), and the link then fails for every agent.
// The answer comes from the zone's own nameservers: this Mac's resolver is
// MagicDNS, which always knows the name, and asking a shared resolver would
// leave a cached "not found" for the agent to hit after the record appears.
export async function publicNameAddresses(hostname, {
  resolver = () => new dns.promises.Resolver({ timeout: 2500, tries: 1 }),
  system = dns.promises,
} = {}) {
  const zone = String(hostname).split(".").slice(-2).join(".");
  if (!zone.includes(".")) return { state: "unknown", addresses: [] };
  let servers;
  try {
    const names = await system.resolveNs(zone);
    servers = (await Promise.all(names.slice(0, 2).map((name) =>
      system.resolve4(name).catch(() => [])))).flat();
  } catch { return { state: "unknown", addresses: [] }; }
  if (!servers.length) return { state: "unknown", addresses: [] };
  try {
    const ask = resolver();
    ask.setServers(servers);
    const answers = await ask.resolve4(hostname);
    return { state: answers.length ? "published" : "unknown", addresses: answers };
  } catch (error) {
    // Only the zone itself saying "no such name" counts as missing.
    return { state: error?.code === "ENOTFOUND" ? "missing" : "unknown", addresses: [] };
  }
}
export async function publicNameState(hostname, deps) {
  return (await publicNameAddresses(hostname, deps)).state;
}
