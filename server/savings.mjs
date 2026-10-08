import fs from "node:fs";
import path from "node:path";

// What Reach saved the agents, one line per saving: when, which agent, what
// kind (e.g. "image-repeat", agent-sessions/image-repeats.mjs) and about how
// many input tokens. Totals show in the Usage sheet. Tokens, not money: on
// a subscription nothing is billed per token, and prices change by model.
const AGENT = /^[a-z]{1,20}$/;
const KIND = /^[a-z][a-z-]{0,39}$/;
const KEEP = 500;

export function createSavings({ file = null, now = Date.now } = {}) {
  let events = [];
  // All-time totals, so dropping old lines never lowers them.
  let totals = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved?.events)) events = saved.events.filter((e) => AGENT.test(e?.agent) && KIND.test(e?.kind));
    if (saved?.totals && typeof saved.totals === "object") totals = saved.totals;
  } catch {
    /* none yet */
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ totals, events }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* kept in memory until Reach restarts */
    }
  };
  return {
    record({ agent, kind, tokens = 0, count = 1 }) {
      if (!AGENT.test(String(agent)) || !KIND.test(String(kind))) return;
      tokens = Math.max(0, Math.round(Number(tokens) || 0));
      count = Math.max(1, Math.round(Number(count) || 1));
      events.push({ at: now(), agent, kind, tokens, count });
      if (events.length > KEEP) events = events.slice(-KEEP);
      const t = (totals[agent] ||= {});
      const k = (t[kind] ||= { tokens: 0, count: 0 });
      k.tokens += tokens;
      k.count += count;
      save();
    },
    // One agent's totals: { tokens, kinds: { "image-repeat": { tokens, count } } }.
    totals(agent) {
      const kinds = totals[agent] || {};
      return { tokens: Object.values(kinds).reduce((sum, k) => sum + (k.tokens || 0), 0), kinds };
    },
    events: () => events.slice(),
  };
}
