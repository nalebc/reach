import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicJson, fail } from "./core.mjs";

// The Mac's own Shortcuts (the Shortcuts app) an agent may run: the ones the
// owner switched on by name, in Agents & people → Shortcuts. The agent's shell
// can't run `shortcuts` or `osascript` (agent-shell.mjs denies them): this is
// the one door, and only an allowed name goes through it. A shortcut runs as
// the owner, one at a time, for up to 60 seconds; text in, text out.
//
// An agent asking for a shortcut that isn't allowed is refused and the owner
// hears once (a notification), so allowing it is one tap away, not a hunt.
const CLEAN = /^[^\u0000-\u001f\u007f]{1,120}$/;
const INPUT = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const ENV = { PATH: "/usr/bin:/bin", HOME: os.homedir(), LANG: "en_US.UTF-8" };
const OUTPUT_LIMIT = 20000;

export function listMacShortcuts() {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/shortcuts", ["list"], { timeout: 10000, maxBuffer: 1 << 20, env: ENV }, (error, stdout) => {
      if (error) return reject(fail(503, "Shortcuts aren't available on this Mac."));
      resolve([...new Set(String(stdout).split("\n").map((line) => line.trim()).filter((line) => CLEAN.test(line)))].slice(0, 500));
    });
  });
}
// `shortcuts run <name>`: its text input from a private file, its output to
// another, both gone afterwards. The name never meets a shell.
export async function runMacShortcut({ name, input, timeoutMs = 60000 }) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "reach-shortcut-"));
  const output = path.join(directory, "output.txt");
  try {
    const args = ["run", name, "--output-path", output];
    if (input !== undefined) {
      const file = path.join(directory, "input.txt");
      await fsp.writeFile(file, input, { mode: 0o600 });
      args.push("--input-path", file);
    }
    const result = await new Promise((resolve) => {
      const child = spawn("/usr/bin/shortcuts", args, { stdio: ["ignore", "pipe", "pipe"], env: ENV });
      let text = "", timedOut = false;
      const collect = (chunk) => { if (text.length < OUTPUT_LIMIT) text += chunk.toString(); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); }, timeoutMs);
      child.on("error", () => { clearTimeout(timer); resolve({ exitCode: 127, text: "Shortcuts couldn't start.", timedOut }); });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, text, timedOut }); });
    });
    let produced = "";
    try { produced = (await fsp.readFile(output, "utf8")).slice(0, OUTPUT_LIMIT); } catch { /* the shortcut gave nothing back */ }
    return { exitCode: result.exitCode, timedOut: result.timedOut, output: produced || result.text.trim().slice(0, OUTPUT_LIMIT) };
  } finally {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export function createMacShortcuts({ file = null, list = listMacShortcuts, run = runMacShortcut, notify = () => {}, record = () => {}, now = Date.now,
  available = () => process.platform === "darwin" } = {}) {
  const allowed = new Set();
  let unreadable = false;
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(saved?.allowed) || saved.allowed.some((name) => !CLEAN.test(name))) throw Error("Unreadable shortcut list");
      for (const name of saved.allowed) allowed.add(name);
    } catch (error) {
      // Unreadable: nothing is allowed until the owner chooses again (the safe side).
      if (error?.code !== "ENOENT") unreadable = true;
    }
  }
  const save = () => {
    if (!file) return;
    try { atomicJson(file, { allowed: [...allowed] }); unreadable = false; }
    catch (error) { throw Object.assign(fail(507, `Reach couldn't save the shortcut list (${error.code || error.message}).`), { cause: error }); }
  };
  let cache = { at: 0, names: [] };
  const names = async () => {
    if (!available()) throw fail(503, "Shortcuts aren't available on this computer.");
    if (now() - cache.at < 10000) return cache.names;
    cache = { at: now(), names: await list() };
    return cache.names;
  };
  const asked = new Map(); // `${clientId}\n${name}` -> when the owner last heard
  let running = null;
  return {
    get unreadable() { return unreadable; },
    /** For the owner: every shortcut on this Mac, allowed or not; allowed names no longer on the Mac. */
    async owner() {
      const found = await names();
      return { shortcuts: found.map((name) => ({ name, allowed: allowed.has(name) })), missing: [...allowed].filter((name) => !found.includes(name)).sort() };
    },
    async allow(name, on) {
      if (!CLEAN.test(name || "")) throw fail(400, "Name a shortcut.");
      if (on !== true && on !== false) throw fail(400, "Allow the shortcut, or stop allowing it.");
      if (on && !(await names()).includes(name)) throw fail(404, "No shortcut with that name is on this Mac.");
      const before = allowed.has(name);
      if (on) allowed.add(name); else allowed.delete(name);
      if (before !== on) {
        try { save(); } catch (error) { if (on) allowed.delete(name); else allowed.add(name); throw error; }
        record("agent", on ? `Agents may run the shortcut "${name}"` : `Agents may no longer run the shortcut "${name}"`);
      }
      return { name, allowed: allowed.has(name) };
    },
    /** For an agent: the names it may run. */
    agentList: () => ({ shortcuts: [...allowed].sort().map((name) => ({ name })) }),
    /** Run one allowed shortcut for an agent, with optional text input; the output as text. */
    async run(client, { name, input } = {}, authorize = () => {}) {
      if (!CLEAN.test(name || "")) throw fail(400, "Name the shortcut to run.");
      if (input !== undefined && (typeof input !== "string" || input.length > 20000 || INPUT.test(input))) throw fail(400, "Give text input, up to 20000 characters.");
      if (!available()) throw fail(503, "Shortcuts aren't available on this computer.");
      if (!allowed.has(name)) {
        const key = `${client.id}\n${name}`;
        if (now() - (asked.get(key) || 0) > 300000) {
          asked.set(key, now());
          Promise.resolve(notify({ title: `${String(client.name || "An agent").slice(0, 80)} · Shortcut`, body: `Wants to run your shortcut “${name}”. Allow it under Agents & people → Shortcuts.`,
            icon: "agent", url: "/?page=invite", actions: [{ action: "open", title: "Review" }], category: "access", tag: `mac-shortcut-${name}` })).catch(() => {});
          record("agent", `${client.name} asked to run the shortcut "${name}"`);
        }
        throw Object.assign(fail(403, `The owner hasn't allowed the shortcut "${name}" for agents. They've been asked; once it's on, call again. reach_mac_shortcuts lists the allowed ones.`), { kind: "blocked" });
      }
      if (running) throw Object.assign(fail(409, `${running.name} is running a shortcut. Try again in a moment.`), { kind: "busy", holder: running.name, retryInMs: 2000 });
      running = { name: String(client.name || "Another agent").slice(0, 80) };
      try {
        authorize();
        record("agent", `${client.name} ran the shortcut "${name}"`);
        const result = await run({ name, input });
        return { ok: result.exitCode === 0 && !result.timedOut, name, output: String(result.output || "").slice(0, OUTPUT_LIMIT),
          ...(result.timedOut ? { timedOut: true } : {}), ...(result.exitCode !== 0 ? { exitCode: result.exitCode } : {}) };
      } finally { running = null; }
    },
  };
}
