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

const RESTARTED = "Reach restarted during delivery. Check the conversation before sending again; automatic retry is paused.";

export function createOutbox({ file = null } = {}) {
  // session id -> messages, oldest first
  const queues = new Map();
  try {
    for (const [id, list] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
      // Send now was for that moment: after a restart they wait like the rest.
      const kept = Array.isArray(list) ? list.filter(valid).map(({ now, ...m }) => m) : [];
      for (const message of kept) if (message.delivery && message.delivery !== "paused" ||
        // Paused by an earlier restart, before the mark below existed.
        message.delivery === "paused" && message.error === RESTARTED) {
        message.delivery = "paused";
        // Checked against the chat on start (recheck): never in it, it goes
        // again by itself; in it, it's done.
        message.restarted = true;
        message.error = RESTARTED;
      }
      if (UUID.test(id) && kept.length) queues.set(id, kept);
    }
  } catch {
    /* nothing waiting */
  }
  let version = 0;
  const listeners = new Set();
  const changed = (id, strict = false) => {
    version++;
    if (file)
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(queues)), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (e) {
        if (strict) throw Object.assign(new Error("Could not save delivery state. Nothing was sent."), { retryable: false });
      }
    for (const listener of listeners) { try { listener(id); } catch {} }
  };
  return {
    add(id, { text = "", images = [], ...settings } = {}) {
      const message = {
        ...Object.fromEntries(Object.entries(settings).filter(([k]) => !["delivery", "error", "id", "at"].includes(k))),
        id: randomUUID(),
        text: String(text),
        images: (Array.isArray(images) ? images : []).map(String),
        at: Date.now(),
      };
      queues.set(id, [...(queues.get(id) || []), message]);
      try { changed(id, true); }
      catch (error) {
        const kept = queues.get(id).filter(m => m.id !== message.id);
        if (kept.length) queues.set(id, kept); else queues.delete(id);
        throw error;
      }
      return message;
    },
    begin(id, messageId) {
      const message = queues.get(id)?.find(m => m.id === messageId);
      if (!message || message.delivery === "paused" || message.delivery === "sending") return false;
      message.delivery = "sending";
      try { changed(id, true); } // Persist BEFORE touching the agent, or do not send.
      catch (error) { message.delivery = "paused"; message.error = error.message; throw error; }
      return true;
    },
    pause(id, messageId, error) {
      const message = queues.get(id)?.find(m => m.id === messageId);
      if (!message) return;
      message.delivery = "paused";
      message.error = error;
      changed(id);
    },
    // Paused by a restart mid-delivery, and the chat shows it never got in:
    // waiting again, as before.
    resume(id, messageId) {
      const message = queues.get(id)?.find(m => m.id === messageId);
      if (!message || message.delivery !== "paused" || !message.restarted) return false;
      delete message.delivery;
      delete message.restarted;
      delete message.error;
      changed(id);
      return true;
    },
    retryLater(id, messageId) {
      const message = queues.get(id)?.find(m => m.id === messageId);
      if (!message) return;
      delete message.delivery;
      changed(id);
    },
    list: (id) => queues.get(id) || [],
    sessions: () => [...queues.keys()],
    // Handed to Claude Code: no longer waiting.
    remove(id, messageId, { durable = false } = {}) {
      const previous = queues.get(id);
      const list = (previous || []).filter((m) => m.id !== messageId);
      if (list.length) queues.set(id, list);
      else queues.delete(id);
      try { changed(id, durable); }
      catch (error) {
        if (previous) queues.set(id, previous);
        else queues.delete(id);
        throw error;
      }
    },
    // A new order from the phone (dragged), as message ids. The one being
    // handed over stays first; ids it doesn't know change nothing.
    reorder(id, order, delivering = null) {
      const list = queues.get(id) || [];
      const rank = new Map(order.map((messageId, i) => [messageId, i]));
      if (list.length < 2 || !list.every((m) => rank.has(m.id))) return false;
      const sorted = [...list].sort((a, b) =>
        a.id === delivering ? -1 : b.id === delivering ? 1 : rank.get(a.id) - rank.get(b.id),
      );
      if (sorted.every((m, i) => m === list[i])) return true;
      queues.set(id, sorted);
      changed(id);
      return true;
    },
    // New words for one still waiting (not one on its way); pictures kept.
    edit(id, messageId, text) {
      const message = queues.get(id)?.find((m) => m.id === messageId);
      if (!message || message.delivery === "sending") return false;
      const words = String(text ?? "");
      if (!words.trim() && !message.images.length) return false;
      const previous = { text: message.text, error: message.error };
      message.text = words;
      delete message.error;
      try { changed(id, true); }
      catch (error) {
        message.text = previous.text;
        if (previous.error !== undefined) message.error = previous.error;
        throw error;
      }
      return true;
    },
    // Send now: first in line, and allowed to go at once.
    hurry(id, messageId) {
      const list = queues.get(id) || [];
      const message = list.find((m) => m.id === messageId);
      if (!message || message.delivery) return false;
      message.now = true;
      queues.set(id, [message, ...list.filter((m) => m !== message)]);
      changed(id);
      return true;
    },
    // Why the next one can't go yet (cleared once it goes). Send now is one
    // try: once it couldn't go, the message waits like the others (it never
    // retries at once, over and over, switching the Claude app each time).
    problem(id, messageId, error) {
      const message = queues.get(id)?.find((m) => m.id === messageId);
      if (!message || (message.error === error && !message.now)) return;
      delete message.now;
      if (error) message.error = error;
      else delete message.error;
      changed(id);
    },
    // The chat was deleted: its messages stop trying and wait for the phone
    // to send them to another chat or delete them (never dropped).
    strand(id) {
      const list = queues.get(id) || [];
      if (!list.length || list.every((m) => m.stranded)) return;
      for (const message of list) {
        delete message.now;
        message.stranded = true;
        message.error = "Its chat was deleted. Send it to another chat, or delete it.";
      }
      changed(id);
    },
    // Every message whose chat is gone, oldest first, as the phone lists them.
    stranded: () =>
      [...queues.entries()]
        .flatMap(([session, list]) =>
          list
            .filter((m) => m.stranded)
            .map((m) => ({ session, id: m.id, text: m.text, images: m.images.length, at: m.at, title: m.title || "" })),
        )
        .sort((a, b) => a.at - b.at),
    version: () => version,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
