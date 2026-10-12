// Team chats (docs/ACROSS_AGENTS.md): a lead (Codex or Claude Code) with
// helpers. The lead gets Reach's team tools (team-tools.mjs) through a small
// MCP bridge (scripts/team-mcp.mjs) that reaches Reach on a private socket
// (team-bridge.mjs) with the team's own key. Delegating starts a helper chat
// in the team's folder and returns at once; when the helper's turn ends, a
// relay (relays.mjs, "report") sends its result to the lead, which wakes up
// and carries on. Nothing here gives more permission than the person picked:
// helpers start like a relay's steps (builders in each app's middle setting,
// reviewers reading), they never get the tools, and every hand-off checks
// that the phone that started the team still may.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentName } from "./move.mjs";
import { startMode } from "./relays.mjs";
import { followUpMessage, helperMessage, teamBrief } from "./chat-context.mjs";
import { TEAM_HELPERS, TEAM_LIMITS } from "./team-tools.mjs";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = (token) => crypto.createHash("sha256").update(token).digest();
const words = (value, max) => String(value ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, " ").trim().slice(0, max);

export function createTeams({
  // The chats (agent-sessions/index.mjs): start, send, stop.
  sessions,
  relays,
  file = null,
  // Where each team's key file goes (mode 0600; its path is all the agent's
  // config holds).
  keysDir = null,
  socketPath = "",
  // The bridge the lead's agent runs, with Reach's own Node.
  script = "",
  node = process.execPath,
  // (owner) → why a team can't act now ("" when it can).
  authorized = () => "",
  // A team's folder, checked as a new chat's.
  folder = (cwd) => cwd,
  // The modes Codex offers now (whether "Approve for me" is on).
  modes = async () => [],
  // Whether the private socket the tools reach Reach on is open.
  ready = () => true,
  now = Date.now,
} = {}) {
  let teams = [];
  if (file)
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) teams = saved.filter((t) => t && typeof t.id === "string" && Array.isArray(t.tasks));
    } catch {
      /* none yet */
    }
  let revision = 0;
  const listeners = new Set();
  const save = () => {
    revision++;
    // Stopped teams are kept a week, 50 at most.
    const week = now() - 7 * 24 * 60 * 60 * 1000;
    teams = teams.filter((t) => t.state === "active" || t.updatedAt > week).slice(-50);
    if (file) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(teams), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    for (const listener of listeners) listener(revision);
  };
  const keyFile = (id) => (keysDir ? path.join(keysDir, `${id}.json`) : "");
  // What the lead's agent is started (and resumed) with: the bridge, and the
  // standing instructions. Claude Code takes them as flags, Codex as the
  // thread's config and developer instructions.
  const bridge = (t) => ({ command: node, args: [script], env: { REACH_TEAM_FILE: keyFile(t.id) } });
  const extras = (t) =>
    t.lead.agent === "claude"
      ? {
          extra: [
            "--mcp-config",
            JSON.stringify({ mcpServers: { reach_team: bridge(t) } }),
            "--append-system-prompt",
            teamBrief({ lead: t.lead.agent, helpers: t.helpers }),
            "--allowedTools",
            "mcp__reach_team",
          ],
        }
      : {
          developerInstructions: teamBrief({ lead: t.lead.agent, helpers: t.helpers }),
          config: { "mcp_servers.reach_team": { ...bridge(t), tool_timeout_sec: 60 } },
        };
  const active = (t) => t.state === "active";
  const view = (t) => ({
    id: t.id,
    state: t.state,
    lead: t.lead,
    helpers: t.helpers,
    cwd: t.cwd,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    left: Math.max(0, TEAM_LIMITS.steps - t.used),
    tasks: t.tasks.map(({ id, helper, kind, title, chat, state, problem, startedAt, updatedAt }) => ({
      id,
      helper,
      kind,
      title,
      chat,
      state,
      ...(problem ? { problem } : {}),
      startedAt,
      updatedAt,
    })),
  });
  // A task stands where its relay does: waiting (working), done (reported
  // to the lead), stopped (with why).
  const sync = () => {
    let changed = false;
    const all = relays.list();
    for (const t of teams)
      for (const task of t.tasks) {
        if (task.state !== "working" || !task.relay) continue;
        const r = all.find((x) => x.id === task.relay);
        if (!r || r.state === "waiting" || r.state === "sending") continue;
        // Reported, but what was reported was a stop or an error.
        const failed = r.state === "done" && r.outcome && r.outcome !== "reply";
        task.state = r.state === "done" && !failed ? "done" : "stopped";
        if (task.state === "stopped") task.problem = failed ? (r.outcome === "stopped" ? "It was stopped." : "It ended on an error.") : r.problem || "It stopped.";
        task.updatedAt = now();
        t.updatedAt = now();
        changed = true;
      }
    if (changed) save();
  };
  relays.onChange?.(() => sync());
  const teamFor = (token) => {
    if (typeof token !== "string" || token.length < 32) return null;
    const given = hash(token);
    return (
      teams.find((t) => {
        if (typeof t.key !== "string") return false;
        const stored = Buffer.from(t.key, "hex");
        return stored.length === given.length && crypto.timingSafeEqual(stored, given);
      }) || null
    );
  };
  // A helper chat for one task: started like a relay's step, its result
  // followed back to the lead.
  const startHelper = async (t, { helper, kind, title, task }) => {
    const text = helperMessage({ lead: t.lead.agent, task, kind });
    const name = words(`Team · ${title || task.split("\n")[0]}`, 120);
    const started = await sessions.start(helper, {
      cwd: t.cwd,
      text,
      images: [],
      keepOut: true,
      ...(await startMode({ kind, agent: helper }, modes)),
      ...(helper === "codex" ? { name } : {}),
    });
    return { chat: { agent: helper, id: started.threadId, title: name }, text };
  };
  const follow = (t, task, text) =>
    relays.follow({
      owner: t.owner,
      from: { agent: task.chat.agent, id: task.chat.id, title: task.chat.title, cwd: t.cwd },
      to: { agent: t.lead.agent, id: t.lead.id, title: t.title },
      expect: text,
      title: task.title,
      task: task.id,
      team: t.id,
    }).id;
  const reserved = new WeakMap();
  const tools = {
    async team_roster(t) {
      return {
        lead: agentName(t.lead.agent),
        helpers: t.helpers.map(agentName),
        steps_left: Math.max(0, TEAM_LIMITS.steps - t.used),
        tasks: t.tasks.map((task) => ({ task_id: task.id, helper: task.helper, kind: task.kind, title: task.title, state: task.state, ...(task.problem ? { problem: task.problem } : {}) })),
      };
    },
    async team_delegate(t, args) {
      const helper = args?.helper;
      const kind = args?.kind;
      if (!TEAM_HELPERS.includes(helper) || !t.helpers.includes(helper)) throw bad(`Pick one of your helpers: ${t.helpers.join(", ")}.`);
      if (kind !== "build" && kind !== "review") throw bad('kind is "build" or "review".');
      const task = words(args?.task, TEAM_LIMITS.task);
      if (!task) throw bad("Say what the task is.");
      const inFlight = reserved.get(t) || { count: 0, seq: 0 };
      if (t.used + inFlight.count >= TEAM_LIMITS.steps) throw bad(`This team has used its ${TEAM_LIMITS.steps} hand-offs. Finish the work yourself or tell the person.`);
      if (t.tasks.filter((x) => x.state === "working").length + inFlight.count >= TEAM_LIMITS.working)
        throw bad(`${TEAM_LIMITS.working} helpers are already working. Wait for a result before handing off more.`);
      const title = words(args?.title, TEAM_LIMITS.title) || words(task.split("\n")[0], TEAM_LIMITS.title);
      // Reserve the id and the slot before awaiting, so concurrent calls
      // get distinct ids and count against the limits.
      const taken = Math.max(0, ...t.tasks.map((x) => Number(String(x.id).slice(1)) || 0));
      inFlight.seq = Math.max(inFlight.seq, taken) + 1;
      inFlight.count++;
      reserved.set(t, inFlight);
      const id = `t${inFlight.seq}`;
      let started;
      try {
        started = await startHelper(t, { helper, kind, title, task });
      } finally {
        inFlight.count--;
      }
      const { chat, text } = started;
      t.used++;
      const entry = { id, helper, kind, title, chat, state: "working", startedAt: now(), updatedAt: now() };
      t.tasks.push(entry);
      entry.relay = follow(t, entry, text);
      t.updatedAt = now();
      save();
      return {
        task_id: id,
        helper: agentName(helper),
        state: "working",
        note: "Started in its own chat. End your turn now: Reach sends you the result as a new message when it finishes.",
      };
    },
    async team_message(t, args) {
      const task = t.tasks.find((x) => x.id === args?.task_id);
      if (!task) throw bad("No such task on this team.");
      const message = words(args?.message, TEAM_LIMITS.message);
      if (!message) throw bad("Say what to send.");
      if (t.used >= TEAM_LIMITS.steps) throw bad(`This team has used its ${TEAM_LIMITS.steps} hand-offs.`);
      const text = followUpMessage({ lead: t.lead.agent, message });
      await sessions.send(task.chat.agent, task.chat.id, { text, images: [], owner: t.owner });
      t.used++;
      if (task.relay && task.state === "working") {
        try {
          relays.cancel(task.relay);
        } catch {
          /* already on its way */
        }
      }
      // Its new relay first: a look at the old one mustn't count for it.
      task.relay = follow(t, task, text);
      task.state = "working";
      delete task.problem;
      task.updatedAt = now();
      t.updatedAt = now();
      save();
      return { task_id: task.id, state: "working", note: "Sent. End your turn now: Reach sends you the reply when it finishes." };
    },
    async team_stop(t, args) {
      const task = t.tasks.find((x) => x.id === args?.task_id);
      if (!task) throw bad("No such task on this team.");
      if (task.state !== "working") return { task_id: task.id, state: task.state };
      try {
        relays.cancel(task.relay);
      } catch {
        /* already on its way */
      }
      await sessions.stop(task.chat.agent, task.chat.id).catch(() => {});
      task.state = "stopped";
      task.problem = "Stopped by the lead.";
      task.updatedAt = now();
      save();
      return { task_id: task.id, state: "stopped" };
    },
  };
  return {
    list: () => teams.filter((t) => active(t) || now() - t.updatedAt < 24 * 60 * 60 * 1000).map(view),
    revision: () => revision,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // A new team: its key, then its lead's chat with the tools attached.
    // start: the lead's settings as a new chat's (model, effort, mode…).
    async create({ owner, lead, helpers, cwd, text, start = {} }) {
      if (!TEAM_HELPERS.includes(lead)) throw bad("The lead is Codex or Claude Code.");
      const crew = [...new Set(Array.isArray(helpers) ? helpers : [])].filter((h) => TEAM_HELPERS.includes(h));
      if (!crew.length) throw bad("Pick at least one helper.");
      if (!words(text, 50000)) throw bad("Say what the team should do.");
      const reason = authorized(owner);
      if (reason) throw bad(reason, 403);
      if (!keysDir || !socketPath || !script) throw bad("Teams aren't available on this computer.", 501);
      // Windows has no team bridge yet (team-bridge.mjs): a restart can't help.
      if (!ready() && process.platform === "win32") throw bad("Teams aren't available on Windows yet.", 501);
      if (!ready()) throw bad("Reach couldn't open the team's private socket on this computer, so a team's lead couldn't hand off work. Restart Reach and try again.", 503);
      const dir = folder(cwd);
      const token = crypto.randomBytes(32).toString("base64url");
      const t = {
        id: crypto.randomUUID(),
        owner,
        state: "active",
        lead: { agent: lead, id: "" },
        helpers: crew,
        cwd: dir,
        title: words(text.split("\n")[0], 80),
        key: hash(token).toString("hex"),
        used: 0,
        tasks: [],
        createdAt: now(),
        updatedAt: now(),
      };
      fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyFile(t.id), JSON.stringify({ socket: socketPath, token }), { mode: 0o600 });
      try {
        const started = await sessions.start(lead, { ...start, cwd: dir, text, keepOut: true, ...extras({ ...t, lead: { agent: lead } }) });
        t.lead.id = started.threadId;
      } catch (e) {
        fs.rmSync(keyFile(t.id), { force: true });
        throw e;
      }
      teams.push(t);
      save();
      return { team: view(t), threadId: t.lead.id };
    },
    // A tool call from a lead's bridge, by its team's key.
    async call(token, tool, args) {
      const t = teamFor(token);
      if (!t) throw bad("This team's key isn't valid any more.", 401);
      if (!active(t)) throw bad("This team was stopped. Carry on without helpers.", 409);
      const reason = authorized(t.owner);
      if (reason) throw bad(reason, 403);
      const run = tools[tool];
      if (!run) throw bad("Unknown team tool.", 404);
      return run(t, args && typeof args === "object" ? args : {});
    },
    // Stopped from the phone: no more hand-offs or wake-ups, its key gone,
    // and helpers at work stopped (their chats stay).
    async stop(id) {
      const t = teams.find((x) => x.id === id);
      if (!t) throw bad("That team is gone.", 404);
      if (!active(t)) return { stopped: false };
      t.state = "stopped";
      t.updatedAt = now();
      if (keyFile(t.id)) fs.rmSync(keyFile(t.id), { force: true });
      for (const task of t.tasks.filter((x) => x.state === "working")) {
        try {
          relays.cancel(task.relay);
        } catch {
          /* already on its way */
        }
        await sessions.stop(task.chat.agent, task.chat.id).catch(() => {});
        task.state = "stopped";
        task.problem = "The team was stopped.";
        task.updatedAt = now();
      }
      save();
      return { stopped: true };
    },
    // A lead's chat (kept out of the Claude app, whose process wouldn't have
    // the tools), and what it's resumed with.
    isLead: (agent, id) => teams.some((t) => active(t) && t.lead.agent === agent && t.lead.id === id),
    // A chat of a team at work, lead or helper: kept out of the Claude app,
    // so a lead's follow-up never types into the desktop app.
    inTeam: (agent, id) =>
      teams.some((t) => active(t) && ((t.lead.agent === agent && t.lead.id === id) || t.tasks.some((x) => x.chat.agent === agent && x.chat.id === id))),
    leadExtras(agent, id) {
      const t = teams.find((x) => x.lead.agent === agent && x.lead.id === id);
      return t ? (active(t) ? extras(t) : false) : null;
    },
    // The team a helper's chat works for.
    helperOf(agent, id) {
      for (const t of teams) {
        const task = t.tasks.find((x) => x.chat.agent === agent && x.chat.id === id);
        if (task) return { team: t.id, lead: t.lead, task: task.id, title: task.title };
      }
      return null;
    },
  };
}
