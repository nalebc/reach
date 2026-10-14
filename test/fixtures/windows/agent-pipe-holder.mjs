// An agent's runtime holding its connection to a computer and sharing it
// through its pipe, as Reach for agents does (scripts/agent-remote.mjs
// shareNode), for the real-Windows test only
// (test/windows-agent-pipe.test.mjs): run as the runner's own account
// without elevation, as a Terminal that wasn't run as administrator runs it.
//
//   node agent-pipe-holder.mjs <connection folder> <out folder>
//
// Writes holder.json ({ pid, pipe }) once its pipe listens; each request it
// gets goes into asked.json; it ends once <out>\stop exists (or in five
// minutes).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [conn, out] = process.argv.slice(2);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { shareNode, socketOf } = await import(pathToFileURL(path.join(repo, "scripts", "agent-remote.mjs")).href);
const asked = [];
const server = shareNode(conn, async (route) => {
  asked.push(route);
  fs.writeFileSync(path.join(out, "asked.json"), JSON.stringify(asked));
  return { ok: route };
});
server.once("listening", () => fs.writeFileSync(path.join(out, "holder.json"), JSON.stringify({ pid: process.pid, pipe: socketOf(conn) })));
server.on("error", (error) => fs.writeFileSync(path.join(out, "holder.json"), JSON.stringify({ error: error.message })));
const until = Date.now() + 5 * 60 * 1000;
setInterval(() => {
  if (fs.existsSync(path.join(out, "stop")) || Date.now() > until) process.exit(0);
}, 200);
