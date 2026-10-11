// Which runtime each command-line agent runs (scripts/agent-remote.mjs
// reports its own on /api/device and /api/browser), against the one this
// computer serves: the owner sees it in Agents & people. In memory only:
// after a restart, each agent says again on its next use.
const SHA256 = /^[a-f0-9]{64}$/;
// A runtime that named itself lately is known on the calls that don't say
// which they are (a planned call's own route: /api/browser for
// reach_access): those never read as an older copy.
const NAMED_MS = 3600_000;
const named = new Map(); // client id → { sha256, at }
const recentlyNamed = (client, at = Date.now()) => {
  const entry = named.get(client?.id);
  return entry && at - entry.at < NAMED_MS ? entry.sha256 : null;
};

// A browser page rather than a program: every browser sends a Mozilla/5.0
// user agent; Reach's agent program (https.request) sends none, Node's
// fetch "node".
export const fromBrowserPage = (req) => /\bMozilla\/5\.0\b/.test(req?.headers?.["user-agent"] || "");

// The one command an agent on an older runtime needs, on its own machine:
// exactly the runtime this computer names, by its SHA-256, checked before it
// replaces anything. Agents & people copies the same (src/PeopleHub.tsx).
export const runtimeUpdateCommand = ({ host, sha, key = "" }) =>
  `curl -fsSL${key ? ` -H 'Reach-Key: ${key}'` : ""} -o ~/.reach-agent/agent.mjs.new https://${host}/agent-runtimes/${sha}.mjs && node -e 'const [f,h]=process.argv.slice(1);if(require("crypto").createHash("sha256").update(require("fs").readFileSync(f)).digest("hex")!==h)throw Error("This is not the runtime the computer named.")' ~/.reach-agent/agent.mjs.new ${sha} && mv ~/.reach-agent/agent.mjs.new ~/.reach-agent/agent.mjs`;

// What a program too old to update itself is told on /api/device and
// /api/browser (its reach_access shows it): it misses every newer tool until
// replaced once. A runtime that names itself updates by itself; a browser
// page and a hosted agent run nothing of Reach's.
export function updateNotice({ client, req, served, host }) {
  if (client?.kind !== "agent" || client.hosted === true || fromBrowserPage(req) ||
      SHA256.test(req?.query?.runtime || "") || recentlyNamed(client) || !SHA256.test(served || "") || !host) return {};
  const key = client.browserTransport === "funnel" && /^[A-Za-z0-9_-]{20,100}$/.test(client.browserBinding || "") ? client.browserBinding : "";
  return { update: {
    reason: "This copy of the Reach agent program is older than Reach on this computer and can't update itself, so newer tools are missing. Run this once on its machine, then restart your MCP client.",
    command: runtimeUpdateCommand({ host, sha: served, key }),
  } };
}

export function createAgentRuntimes({ current = () => undefined, now = Date.now } = {}) {
  const seen = new Map(); // client id → { sha256 | null, program, at }
  return {
    // What an agent said on this request (nothing, from an older runtime),
    // and whether a program asked rather than a browser page.
    note(client, value, { program = false } = {}) {
      if (client?.kind !== "agent" || typeof client.id !== "string") return;
      if (typeof value === "string" && SHA256.test(value)) {
        named.set(client.id, { sha256: value, at: Date.now() });
        if (named.size > 1000) named.delete(named.keys().next().value);
      } else if (recentlyNamed(client) && seen.get(client.id)?.sha256) return;
      seen.set(client.id, { sha256: typeof value === "string" && SHA256.test(value) ? value : null, program: program === true, at: now() });
      if (seen.size > 1000) seen.delete(seen.keys().next().value);
    },
    // "current", "updating" (it fetches the new one by itself), or
    // "one-time" (an older runtime with no updater: the owner runs one
    // command on its machine). Only an agent known to run the command-line
    // runtime is ever "one-time": a program that names no runtime, its own
    // tailnet device, or one that has traded its credential (pages never
    // do); unknown otherwise.
    statusOf(client) {
      const entry = seen.get(client?.id);
      if (!entry) return undefined;
      if (entry.sha256) {
        const served = current();
        return !served || entry.sha256 === served ? "current" : "updating";
      }
      // A hosted agent (claude.ai, ChatGPT: /mcp) runs nothing of Reach's.
      if (client.hosted === true) return undefined;
      return entry.program || client.tailscale?.tagged === true || client.rotatedAt > 0 ? "one-time" : undefined;
    },
    forget(id) { seen.delete(id); named.delete(id); },
  };
}
