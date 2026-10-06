import fs from "node:fs";
import path from "node:path";

// The permission mode picked for each Codex chat from Reach (when it started,
// or later from its settings), kept across restarts. Without it, the chat's
// next message took the Codex app's current mode: a chat started in "Ask for
// approval" went on in "Approve for me" and Codex approved network access on
// its own. Chats Reach never set follow the Codex app, as before.
const ID = /^[\w-]{8,100}$/;
const MODE = /^[\w:.-]{1,80}$/;
const MAX = 2000;

export function createChatModes({ file = null } = {}) {
  const modes = new Map();
  try {
    for (const [id, mode] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))))
      if (ID.test(id) && typeof mode === "string" && MODE.test(mode)) modes.set(id, mode);
  } catch {
    /* none yet */
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(modes)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* kept in memory until Reach restarts */
    }
  };
  return {
    get: (id) => modes.get(id) || null,
    set(id, mode) {
      if (!ID.test(String(id)) || typeof mode !== "string" || !MODE.test(mode) || modes.get(id) === mode) return;
      modes.delete(id);
      modes.set(id, mode);
      // The oldest chats' choices go first.
      while (modes.size > MAX) modes.delete(modes.keys().next().value);
      save();
    },
  };
}
