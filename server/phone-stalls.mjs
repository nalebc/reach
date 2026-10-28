import fs from "node:fs";
import { fail } from "./core.mjs";

// What a phone's page says when it stopped answering (src/stall-watch.ts):
// the kind, how long, which Reach page and connection, and the tag, role and
// Reach class names of what was tapped. Kept beside agent-timings.jsonl for
// the owner (and whoever helps them) to read; never shown to anyone else.
// Only these fields, each bounded: a page can't store anything else here.
const KINDS = new Set(["stall", "slow-input", "no-click", "repeat-taps", "unclean-end"]);
const MAX = 2000;
const PER_MINUTE = 30;
const word = (value, max, pattern = /^[\w.\-[\]= ]*$/) =>
  typeof value === "string" && value.length <= max && pattern.test(value) ? value : "";
const count = (value) => (Number.isInteger(value) && value >= 0 && value <= 100 ? value : 0);

export function cleanStall(value, receivedAt) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !KINDS.has(value.kind)) return null;
  if (!Number.isFinite(value.ms) || value.ms < 0 || value.ms > 24 * 3600_000) return null;
  // The page's own clock, within a day of the computer's.
  const at = Number.isFinite(value.at) && Math.abs(value.at - receivedAt) < 24 * 3600_000 ? Math.round(value.at) : receivedAt;
  const entry = {
    at, receivedAt, kind: value.kind, ms: Math.round(value.ms),
    page: word(value.page, 40), route: word(value.route, 20),
    visible: value.visible === true, dialogs: count(value.dialogs), inert: count(value.inert),
    pinned: value.pinned === true, focused: word(value.focused, 120), build: word(value.build, 64),
  };
  for (const key of ["target", "under"]) if (word(value[key], 120)) entry[key] = value[key];
  if (typeof value.interactive === "boolean") entry.interactive = value.interactive;
  return entry;
}

export function createPhoneStalls({ file = null, now = Date.now, max = MAX } = {}) {
  let lines = 0;
  if (file) {
    try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length; }
    catch (error) { if (error?.code !== "ENOENT") console.warn(`Reach: couldn't read the phone freeze record (${error.code || error.message}).`); }
  }
  const recent = new Map();
  let writing = Promise.resolve(), warned = false;
  const persist = (entries) => {
    if (!file) return;
    writing = writing.then(async () => {
      try {
        await fs.promises.appendFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
        lines += entries.length;
        if (lines > max) {
          const kept = (await fs.promises.readFile(file, "utf8")).split("\n").filter(Boolean).slice(-Math.ceil(max / 2));
          const temporary = `${file}.${process.pid}.tmp`;
          await fs.promises.writeFile(temporary, kept.join("\n") + "\n", { mode: 0o600 });
          await fs.promises.rename(temporary, file);
          lines = kept.length;
        }
      } catch (error) {
        if (!warned) { warned = true; console.warn(`Reach: couldn't save the phone freeze record (${error.code || error.message}).`); }
      }
    });
  };
  const add = (client, body) => {
    if (client?.kind !== "device") throw fail(403, "Only your own devices report how their page ran.");
    const reports = body?.reports;
    if (!Array.isArray(reports) || !reports.length || reports.length > 10) throw fail(400, "Send between 1 and 10 reports.");
    const at = now();
    const sent = (recent.get(client.id) || []).filter((time) => at - time < 60_000);
    if (sent.length + reports.length > PER_MINUTE) throw fail(429, "Too many reports from this device. Try again in a minute.");
    const entries = reports.map((report) => cleanStall(report, at)).filter(Boolean).map((entry) => ({ ...entry, clientId: client.id }));
    recent.set(client.id, [...sent, ...reports.map(() => at)]);
    if (entries.length) persist(entries);
    return { kept: entries.length };
  };
  return { add, flushed: () => writing };
}
