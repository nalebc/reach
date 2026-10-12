import path from "node:path";
import { loadJson } from "../server/core.mjs";
import { createFleet } from "../server/fleet.mjs";
import { accountApproval, readPreferences } from "./configure.mjs";
import { command, stateDir } from "./home.mjs";

// `reach link [name]`: link this computer with another Reach computer on your
// Tailscale account, from any terminal (also when Reach runs in the
// background). Do it on both computers. Without a name: list them.
export async function linkComputers(root, name, deps = {}) {
  const print = deps.print || console.log;
  const preferences = readPreferences(root);
  const host = loadJson(path.join(stateDir(root), "host-status.json"), null);
  const dataDir =
    host?.dataDir ||
    process.env.REACH_DATA ||
    path.join(stateDir(root), "quick");
  // Linked computers let in each other's devices by your Tailscale account;
  // a Windows Reach approves phones by pairing code (configure.mjs).
  if (!accountApproval(deps.platform))
    throw Error(
      "Linking computers isn't available on Windows yet: it needs phones approved by your Tailscale account, and on Windows they join with a pairing code.",
    );
  // With browser sign-in (REACH_WINDOWS_ACCOUNT=1) too: its own acceptance first.
  if ((deps.platform || process.platform) === "win32")
    throw Error("Linking computers isn't available on Windows yet.");
  if (!preferences || !host?.origin?.startsWith("https://"))
    throw Error(`Start Reach on this computer first (${command}), then link.`);
  const fleet = createFleet({
    dataDir,
    owner: preferences.owner,
    selfOrigin: host.origin,
    ...deps.fleet,
  });
  if (name) {
    const linked = await fleet.link(name);
    print(
      `Linked ${linked.name}. Run "${command} link ${new URL(host.origin).hostname.split(".")[0]}" on ${linked.name} too; then a phone approved on either works on both.`,
    );
    return linked;
  }
  const found = await fleet.discover({ fresh: true });
  if (!found.length)
    print(
      "No other Reach computer is online on your Tailscale account. Start Reach on it first.",
    );
  for (const c of found)
    print(
      `${c.linked ? "✓ linked" : "  not linked"} · ${c.name}${c.linked ? "" : ` · ${command} link ${c.short}`}`,
    );
  return found;
}
