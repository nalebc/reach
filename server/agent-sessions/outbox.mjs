// Messages sent from the phone that wait for their session (the Claude app is
// in the middle of a turn): kept in Reach's data folder until each is handed
// to Claude Code, so neither a page reload nor a Reach restart loses one. They
// go in order and are never dropped; one that can't go yet says why.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valid = (m) =>
  m &&
  typeof m.id === "string" &&
  typeof m.text === "string" &&
  Array.isArray(m.images) &&
  m.images.every((i) => typeof i === "string") &&
  Number.isFinite(m.at);

export function createOutbox({ file = null } = {}) {
  // session id -> messages, oldest first
  const queues = new Map();
  try {
    for (const [id, list] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
      const kept = Array.isArray(list) ? list.filter(valid) : [];
      if (UUID.test(id) && kept.length) queues.set(id, kept);
    }
  } catch {
    /* nothing waiting */
  }
  let version = 0;
  const listeners = new Set();
  const changed = (id) => {
    version++;
    if (file)
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(queues)), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch {
        /* kept in memory until Reach restarts */
      }
    for (const listener of listeners) listener(id);
  };
  return {
    add(id, { text = "", images = [], ...settings } = {}) {
      const message = {
        ...settings,
        id: randomUUID(),
        text: String(text),
        images: (Array.isArray(images) ? images : []).map(String),
        at: Date.now(),
      };
      queues.set(id, [...(queues.get(id) || []), message]);
      changed(id);
      return message;
    },
    list: (id) => queues.get(id) || [],
    sessions: () => [...queues.keys()],
    // Handed to Claude Code: no longer waiting.
    remove(id, messageId) {
      const list = (queues.get(id) || []).filter((m) => m.id !== messageId);
      if (list.length) queues.set(id, list);
      else queues.delete(id);
      changed(id);
    },
    // Why the next one can't go yet (cleared once it goes).
    problem(id, messageId, error) {
      const message = queues.get(id)?.find((m) => m.id === messageId);
      if (!message || message.error === error) return;
      if (error) message.error = error;
      else delete message.error;
      changed(id);
    },
    version: () => version,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
