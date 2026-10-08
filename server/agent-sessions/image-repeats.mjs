import fs from "node:fs";
import path from "node:path";

// Which pictures each chat already has (image ids come from the bytes,
// images.mjs). A picture sent again to the same chat goes as a short note
// instead: the agent still holds it from the first time, cached, so it
// isn't paid for again. The note names the file, so an agent that has since
// compacted its history can open it. Kept across restarts.
const KEY = /^(codex|claude):[\w-]{1,100}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const MAX_CHATS = 2000;
const PER_CHAT = 200;
// The chats that skip repeats: the ones whose history keeps every picture.
export const REPEAT_AGENTS = ["codex", "claude"];

export function createImageRepeats({ file = null } = {}) {
  const chats = new Map();
  try {
    for (const [key, ids] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))))
      if (KEY.test(key) && Array.isArray(ids)) chats.set(key, new Set(ids.filter((id) => typeof id === "string" && ID.test(id))));
  } catch {
    /* none yet */
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries([...chats].map(([k, v]) => [k, [...v]]))), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* kept in memory until Reach restarts */
    }
  };
  const key = (agent, chat) => `${agent}:${chat}`;
  return {
    // The ids to attach and the ones the chat already has (each once).
    split(agent, chat, ids) {
      if (!Array.isArray(ids)) return { fresh: ids, repeated: [] };
      const unique = [...new Set(ids)];
      if (!REPEAT_AGENTS.includes(agent)) return { fresh: unique, repeated: [] };
      const had = chats.get(key(agent, chat));
      return { fresh: unique.filter((id) => !had?.has(id)), repeated: unique.filter((id) => had?.has(id)) };
    },
    // After the chat took them.
    add(agent, chat, ids) {
      const k = key(agent, chat);
      if (!KEY.test(k) || !Array.isArray(ids) || !ids.length) return;
      const had = chats.get(k) || new Set();
      chats.delete(k);
      for (const id of ids) if (typeof id === "string" && ID.test(id)) had.add(id);
      while (had.size > PER_CHAT) had.delete(had.values().next().value);
      chats.set(k, had);
      // The chats used longest ago go first.
      while (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value);
      save();
    },
  };
}

// The note that stands for pictures the chat already has, ahead of the
// person's words; the phone shows it as a "Same image" tag
// (message-text.mjs repeatedImages), never as text.
export const repeatNote = (files) =>
  `<reach-image count="${files.length}">The same ${files.length === 1 ? "image" : `${files.length} images`} I sent earlier in this chat, not attached again to save tokens: ${files.join(", ")}. If ${files.length === 1 ? "it's" : "they're"} no longer in your context, open ${files.length === 1 ? "that file" : "those files"}.</reach-image>`;
