import fs from "node:fs";
import path from "node:path";

// What Reach saved the agents, one line per saving: when, which agent, what
// kind (e.g. "image-repeat", agent-sessions/image-repeats.mjs) and about how
// many input tokens. Totals show in the Usage sheet. Tokens, not money: on
// a subscription nothing is billed per token, and prices change by model.
const AGENT = /^[a-z]{1,20}$/;
const KIND = /^[a-z][a-z-]{0,39}$/;
const KEEP = 500;

const whole = (value) => Math.max(0, Math.round(Number(value) || 0));

export function createSavings({ file = null, now = Date.now } = {}) {
  let events = [];
  // All-time totals, so dropping old lines never lowers them: agent → kind →
  // { tokens, count }. Maps, so a name is only ever a key: "constructor" or
  // "prototype" (both pass the patterns) never reach Object or its prototype.
  const totals = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved?.events)) events = saved.events.filter((e) => AGENT.test(e?.agent) && KIND.test(e?.kind));
    if (saved?.totals && typeof saved.totals === "object")
      for (const [agent, kinds] of Object.entries(saved.totals)) {
        if (!AGENT.test(agent) || !kinds || typeof kinds !== "object") continue;
        const into = new Map();
        for (const [kind, k] of Object.entries(kinds))
          if (KIND.test(kind) && k && typeof k === "object") into.set(kind, { tokens: whole(k.tokens), count: whole(k.count) });
        if (into.size) totals.set(agent, into);
      }
  } catch {
    /* none yet */
  }
  const kindsOf = (agent) =>
    Object.fromEntries([...(totals.get(agent) || [])].map(([kind, k]) => [kind, { tokens: k.tokens, count: k.count }]));
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      const saved = Object.fromEntries([...totals.keys()].map((agent) => [agent, kindsOf(agent)]));
      fs.writeFileSync(tmp, JSON.stringify({ totals: saved, events }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* kept in memory until Reach restarts */
    }
  };
  return {
    record({ agent, kind, tokens = 0, count = 1 }) {
      if (!AGENT.test(String(agent)) || !KIND.test(String(kind))) return;
      agent = String(agent);
      kind = String(kind);
      tokens = whole(tokens);
      count = Math.max(1, whole(count));
      events.push({ at: now(), agent, kind, tokens, count });
      if (events.length > KEEP) events = events.slice(-KEEP);
      if (!totals.has(agent)) totals.set(agent, new Map());
      const kinds = totals.get(agent);
      if (!kinds.has(kind)) kinds.set(kind, { tokens: 0, count: 0 });
      const k = kinds.get(kind);
      k.tokens += tokens;
      k.count += count;
      save();
    },
    // One agent's totals: { tokens, kinds: { "image-repeat": { tokens, count } } }.
    totals(agent) {
      const kinds = kindsOf(String(agent));
      return { tokens: Object.values(kinds).reduce((sum, k) => sum + k.tokens, 0), kinds };
    },
    events: () => events.slice(),
  };
}
