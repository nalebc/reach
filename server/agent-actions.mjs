import fs from "node:fs";
import path from "node:path";
import { fail } from "./core.mjs";

// What each agent did on this Mac, one line per action, for the owner: "Typed
// “diapers”", "Chose File › Print…", "Opened Numbers", "Ran: npm test", and
// what it tried and was refused. Kept on disk (one JSON line per entry) so a
// restart forgets nothing; the owner reads it per agent under Agents & people.
//
// Never a value from an agent's vault (shown as "a value from its vault"),
// never more than a glimpse of typed text, never a screenshot: this is the
// owner's record of what happened, not a copy of what was on screen.
const MAX = 20000;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const HIDDEN = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g");
const clean = (value, size) => String(value ?? "").replace(HIDDEN, "").slice(0, size);
const quote = (text, size = 60) => { const value = clean(text, size + 1).replace(/\s+/g, " ").trim(); return `“${value.length > size ? value.slice(0, size - 1) + "…" : value}”`; };
const percent = (value) => `${Math.round(Number(value) * 100)}%`;
const KEY_NAMES = { return: "Enter", enter: "Enter", esc: "Escape", backspace: "Delete", forwarddelete: "Forward Delete", pageup: "Page Up", pagedown: "Page Down", space: "Space" };
const MODIFIER_SYMBOLS = { cmd: "⌘", command: "⌘", meta: "⌘", shift: "⇧", option: "⌥", alt: "⌥", control: "⌃", ctrl: "⌃" };
const keyWords = (key, modifiers = []) => {
  const name = KEY_NAMES[key] || (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  return [...new Set(modifiers.map((m) => MODIFIER_SYMBOLS[m] || ""))].join("") + name;
};
const tail = (value) => String(value || "").split("/").filter(Boolean).pop() || String(value || "");

/** One plain sentence for an action, from its shape and what the Mac answered. */
export function actionWords(kind, action = {}, result = {}) {
  const a = plain(action) ? action : {}, r = plain(result) ? result : {};
  switch (kind) {
    case "click": {
      const times = a.count === 2 ? " twice" : a.count === 3 ? " three times" : "";
      return `Clicked${a.button === "right" ? " the right button" : ""}${times} at ${percent(a.x)}, ${percent(a.y)}${a.holdMs ? ` and held ${(a.holdMs / 1000).toFixed(1)} s` : ""}`;
    }
    case "move": return "Moved the pointer";
    case "drag": return `Dragged from ${percent(a.x)}, ${percent(a.y)} to ${percent(a.toX)}, ${percent(a.toY)}`;
    case "scroll": {
      const dy = Number(a.dy) || 0, dx = Number(a.dx) || 0;
      if (!dy && !dx) return "Scrolled";
      return `Scrolled ${Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? "down" : "up") : (dx > 0 ? "right" : "left")} ${Math.round(Math.max(Math.abs(dy), Math.abs(dx)))} px`;
    }
    case "type":
      if (a.secret) return "Typed a value from its vault";
      if (a.paste) return `Pasted ${String(a.text || "").length} characters`;
      return `Typed ${quote(a.text)}`;
    case "key": return `Pressed ${keyWords(String(a.key || ""), a.modifiers)}`;
    case "element": case "press": return `Pressed ${quote(r.pressed || a.name || "a control", 60)}`;
    case "fill": {
      const fields = (Array.isArray(a.fields) ? a.fields : []).map((field) => `${clean(field.label, 40)}${field.secret ? " (from its vault)" : ""}`);
      return `Filled ${fields.join(", ") || "a form"}${a.submit ? " and pressed Enter" : ""}`;
    }
    case "menu": return `Chose ${(Array.isArray(a.path) ? a.path : []).map((title) => clean(title, 40)).join(" › ")}`;
    case "open": return `Opened ${clean(r.app || tail(a.app), 80)}`;
    case "open-url": {
      let shown = clean(a.url, 2048);
      try { const url = new URL(a.url); shown = url.host + (url.pathname === "/" ? "" : url.pathname); } catch { /* as given */ }
      return `Opened ${shown.length > 80 ? shown.slice(0, 79) + "…" : shown}${r.app ? ` in ${clean(r.app, 80)}` : ""}`;
    }
    case "focus": return `Switched to ${quote(r.title || a.title || "a window", 60)}${r.tab ? `, tab ${quote(r.tab, 40)}` : ""}${r.app ? ` in ${clean(r.app, 80)}` : ""}`;
    case "open-file": return a.reveal ? `Showed ${quote(tail(a.path), 60)} in the Finder` : `Opened ${quote(tail(a.path), 60)}${r.app ? ` in ${clean(r.app, 80)}` : ""}`;
    case "find": return `Looked for ${quote(a.text ?? a.name, 60)}${r.found === false ? ": not there" : r.scrolled ? " and scrolled to it" : ""}`;
    case "command": return `Ran: ${clean(a.command, 100).replace(/\s+/g, " ").trim()}`;
    case "file": return `${a.op === "write" ? "Wrote" : a.op === "rm" ? "Deleted" : a.op === "cp" ? "Copied" : a.op === "mkdir" ? "Made the folder" : "Changed"} ${quote(a.path, 80)}${a.to ? ` to ${quote(a.to, 60)}` : ""}`;
    case "tool": return `Ran the tool ${quote(a.title, 60)}`;
    case "shortcut": return `Ran the shortcut ${quote(a.name, 60)}`;
    case "mac-shortcut": return `Ran the Mac shortcut ${quote(a.name, 60)}`;
    case "app-open": return `Opened ${clean(a.app, 80)} on its own display`;
    default: return clean(kind, 40) || "Acted";
  }
}

export function createAgentActions({ file = null, now = Date.now, max = MAX } = {}) {
  let entries = []; // newest first
  let appended = 0, warned = false;
  if (file) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try { const entry = JSON.parse(line); if (plain(entry) && typeof entry.id === "string" && typeof entry.clientId === "string") entries.push(entry); } catch { /* a torn line */ }
      }
      entries = entries.slice(-max).reverse();
    } catch (error) { if (error?.code !== "ENOENT") console.warn(`Reach: couldn't read the agent action log (${error.code || error.message}).`); }
  }
  const persist = (entry) => {
    if (!file) return;
    try {
      if (appended > max) {
        // Keep the file as long as the memory it mirrors.
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, [...entries].reverse().map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
        fs.renameSync(temporary, file);
        appended = 0;
      } else {
        fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
        appended += 1;
      }
    } catch (error) {
      if (!warned) { warned = true; console.warn(`Reach: couldn't save the agent action log (${error.code || error.message}); it holds until Reach restarts.`); }
    }
  };
  let counter = 0;
  return {
    /** One action by one agent: what it did (text), where (app), and whether the Mac did it. */
    add(client, { kind, text, app = "", ok = true, reason = "" } = {}) {
      if (!plain(client) || typeof client.id !== "string") return null;
      const entry = { id: `${now().toString(36)}-${(counter = (counter + 1) % 1e6).toString(36)}`, at: now(), clientId: client.id, name: clean(client.name || "Agent", 80),
        kind: clean(kind, 40), text: clean(text, 300), ...(app ? { app: clean(app, 100) } : {}), ok: ok !== false, ...(ok === false && reason ? { reason: clean(reason, 300) } : {}) };
      entries.unshift(entry);
      if (entries.length > max) entries.length = max;
      persist(entry);
      return entry;
    },
    /** For the owner: one agent's actions, newest first, before a time, up to limit. */
    list({ clientId, before, limit = 100 } = {}) {
      if (clientId !== undefined && (typeof clientId !== "string" || !clientId)) throw fail(400, "Choose an agent.");
      if (before !== undefined && !(Number.isFinite(before) && before > 0)) throw fail(400, "Give the time to read back from.");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fail(400, "Read 1 to 500 actions.");
      const found = entries.filter((entry) => (clientId === undefined || entry.clientId === clientId) && (before === undefined || entry.at < before));
      return { actions: found.slice(0, limit), more: found.length > limit };
    },
    count: (clientId) => entries.filter((entry) => entry.clientId === clientId).length,
  };
}
