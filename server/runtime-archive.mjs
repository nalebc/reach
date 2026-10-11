import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Every agent runtime this computer served lately, by its SHA-256, beside it
// in agent-runtimes/: a line from `agent.mjs keep`, or the owner's update
// command, fetches exactly the runtime it names and checks it, however Reach
// changed since (connections audit, Oct 10). The newest 50 from the last 90
// days; the current one always.
export function keepRuntime(file, { now = Date.now() } = {}) {
  const dir = path.join(path.dirname(file), "agent-runtimes");
  const data = fs.readFileSync(file);
  const current = `${crypto.createHash("sha256").update(data).digest("hex")}.mjs`;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, current);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(data)) fs.writeFileSync(target, data);
  else fs.utimesSync(target, new Date(now), new Date(now));
  fs.readdirSync(dir)
    .filter((name) => /^[0-9a-f]{64}\.mjs$/.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .forEach((entry, i) => {
      if (entry.name !== current && (i >= 50 || now - entry.at > 90 * 86400000))
        fs.rmSync(path.join(dir, entry.name), { force: true });
    });
  return current;
}
