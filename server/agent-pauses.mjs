import fs from "node:fs";
import { atomicJson } from "./core.mjs";

// The owner's pause of one agent ("it can look, not touch"), kept across
// restarts: a crash, ./reach restart or an update used to bring a paused agent
// back unpaused, its credential being on disk and its pause only in memory
// (reliability audit, Oct 10). A pause ends when the owner resumes it or the
// agent's access ends, never by a restart.
//
// A file that is there but can't be read says nothing about who was paused:
// `unreadable` tells the caller to pause every agent (never "nobody paused").
export function createAgentPauses({ file = null } = {}) {
  const ids = new Set();
  let unreadable = false;
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(saved?.paused) || saved.paused.some((id) => typeof id !== "string")) throw Error("Unreadable agent pauses");
      for (const id of saved.paused) ids.add(id);
    } catch (error) {
      if (error?.code !== "ENOENT") unreadable = true;
    }
  }
  // A pause that can't be saved still holds now; the owner hears it would
  // end at a restart. A resume that can't be saved holds too (a restart would
  // pause the agent again: the safe side), so it only says so in the log.
  const save = ({ pausing = true } = {}) => {
    if (!file) return;
    try {
      atomicJson(file, { paused: [...ids] });
      unreadable = false;
    } catch (error) {
      console.warn(`Reach: couldn't save agent pauses (${error.code || error.message}); they hold until Reach restarts.`);
      if (pausing) throw Object.assign(Error("Paused now, but Reach couldn't save it to disk, so a restart would end it."), { status: 507 });
    }
  };
  return {
    get unreadable() {
      return unreadable;
    },
    has: (id) => ids.has(id),
    list: () => [...ids],
    set(id, paused) {
      const before = ids.has(id);
      if (paused) ids.add(id);
      else ids.delete(id);
      if (before !== paused) save({ pausing: paused });
      return ids.has(id);
    },
    // Several at once (every agent, after Reach ended unexpectedly).
    add(list) {
      const added = list.filter((id) => !ids.has(id));
      for (const id of added) ids.add(id);
      if (added.length || unreadable) save();
      return added;
    },
    // Agents whose access ended keep no pause.
    prune(alive) {
      const gone = [...ids].filter((id) => !alive(id));
      for (const id of gone) ids.delete(id);
      if (gone.length) save({ pausing: false });
      return gone;
    },
  };
}
