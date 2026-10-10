// Per-chat state a host keeps for every chat it was ever asked about grew
// for as long as Reach ran (reliability audit, Oct 10). One at rest, all its
// fields as they started (nothing running, waiting, chosen or said), and
// untouched for idleMs, goes; asked about again, it starts afresh. A field
// this doesn't know, or one not back where it started, keeps it.
const same = (value, initial) => {
  if (initial instanceof Map || initial instanceof Set) return (value instanceof Map || value instanceof Set) && value.size === 0;
  if (initial && typeof initial === "object") return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  return Object.is(value, initial);
};

// fresh: a new entry as the host makes it. free: fields that say nothing
// about being at rest (its id, folder, version, when it was last asked about).
export function atRest(entry, fresh, free) {
  for (const key of Object.keys(entry)) {
    if (free.includes(key)) continue;
    if (!(key in fresh) || !same(entry[key], fresh[key])) return false;
  }
  return true;
}

export function sweepAtRest(map, { fresh, free, keep = () => false, now = Date.now(), idleMs = 30 * 60 * 1000 }) {
  const removed = [];
  for (const [id, entry] of map)
    if (now - (entry.touchedAt || 0) > idleMs && !keep(id) && atRest(entry, fresh(id), free)) removed.push(id);
  for (const id of removed) map.delete(id);
  return removed;
}
