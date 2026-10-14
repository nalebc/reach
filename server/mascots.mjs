// Which of the twenty mascots (src/mascots.ts) each agent or person you
// invite wears, kept on its access record. Drawn like a shuffled deck: a
// face once picked isn't picked again until all twenty have been, and never
// one that someone listed now still wears. The deck is kept beside the
// access records (mascots.json; nothing secret in it).
import crypto from "node:crypto";

export const MASCOT_COUNT = 20;

const wears = (client, now) =>
  (client.kind === "agent" || client.kind === "guest") &&
  client.expiresAt > now &&
  client.status !== "revoked";

export function createMascotDeck({ file, load, save, random = crypto.randomInt, count = MASCOT_COUNT }) {
  const valid = (n) => Number.isInteger(n) && n >= 0 && n < count;
  const bare = (clients, now) => clients.filter((c) => wears(c, now) && !valid(c.mascot));
  const all = [...Array(count).keys()];
  // Each listed agent and person without a mascot draws one (changing the
  // records given). True when one did: the records then need saving.
  function dress(clients, now = Date.now()) {
    const drawing = bare(clients, now);
    if (!drawing.length) return false;
    const stored = load(file, {});
    let drawn = Array.isArray(stored?.drawn) ? stored.drawn.filter(valid) : [];
    for (const client of drawing) {
      const worn = clients.filter((c) => c !== client && wears(c, now) && valid(c.mascot)).map((c) => c.mascot);
      let open = all.filter((n) => !drawn.includes(n) && !worn.includes(n));
      if (!open.length) {
        // All twenty drawn: a new round, still never a face worn now.
        drawn = [];
        open = all.filter((n) => !worn.includes(n));
      }
      if (!open.length) {
        // Twenty or more here at once: one of the faces worn least.
        const times = (n) => worn.filter((w) => w === n).length;
        const least = Math.min(...all.map(times));
        open = all.filter((n) => times(n) === least);
      }
      client.mascot = open[random(open.length)];
      drawn.push(client.mascot);
    }
    save(file, { drawn });
    return true;
  }
  return { dress, needs: (clients, now = Date.now()) => bare(clients, now).length > 0 };
}
