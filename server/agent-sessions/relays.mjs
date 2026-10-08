// Relays (docs/ACROSS_AGENTS.md): what one agent did goes on to another,
// a step at a time, as set up from the phone. A new chat that builds it, one
// that reviews it (reading only), a chat you picked, or a review back to the
// chat that was reviewed. Most wait for the chat's agent to finish its turn;
// a second opinion starts at once, from a reply already there.
// A turn counts as finished only when the chat, read again, ends with a reply
// (turn-watch.mjs turnOutcome) and still does a few seconds later. Each step
// sends once: one interrupted by a restart is marked uncertain, never sent
// again. When it sends, the phone that set it up must still be one of the
// owner's approved devices, and Reach not paused.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { agentName, resumeText } from "./move.mjs";
import { canContinue, checkContinuePriority, continueUnavailable } from "./auto-continue.mjs";
import { turnOutcome, usageLimited } from "./turn-watch.mjs";
import { CODEX_MODES } from "./codex.mjs";
import { visibleUserText } from "./message-text.mjs";
import { backMessage, relayMessage, reportMessage, reviewMessage, turnMaterial } from "./chat-context.mjs";
import { clipMiddle } from "./move.mjs";

// Who can receive (new chats, messages); whose chats can be read to send on.
// OpenClaw joins both when Reach has its Gateway (agentChats below).
export const RELAY_AGENTS = ["codex", "claude"];
const SOURCES = ["codex", "claude", "gemini"];
const KINDS = ["build", "review", "send", "back", "report", "record"];
export const MAX_STEPS = 3;
// A relay left waiting this long stops (set it up again if still wanted).
export const WAIT_MS = 24 * 60 * 60 * 1000;
const BUSY = new Set(["running", "waiting"]);
const ID = /^[\w-]{1,80}$/;

// OpenClaw (../openclaw.mjs): cheap, always on, reached from WhatsApp or
// Telegram, but not in the folder and with no mode Reach can set. Its
// client writes only in chats Reach made (agent:<id>:reach-…, webchat,
// nothing behind them) and never asks OpenClaw to post to a channel; so a
// relay or a workflow task gets a new Reach chat, and a chat picked to send
// to must be one of Reach's. Any OpenClaw chat can be read to send on.
export const CLAW_KEY = /^agent:[\w-]{1,80}:reach-[\w-]{1,80}$/;
const CLAW_ANY = /^agent:[^\x00-\x1f\s]{1,300}$/;
const chatId = (agent, id) => typeof id === "string" && (agent === "openclaw" ? CLAW_ANY.test(id) : ID.test(id));
// The message's last words to OpenClaw: where it stands, and that what it
// finishes with stays here (no channel, nobody else).
export const CLAW_NOTE =
  "(From Reach. You're in OpenClaw, not in that folder: if you can't open its files, work from the material above and your own tools. Reply here; Reach passes your reply on. Don't send anything to WhatsApp, Telegram or any other channel or person because of this message.)";
// OpenClaw takes at most 100,000 characters a message.
const CLAW_ROOM = 99_000;
// OpenClaw puts the time before a message it's sent ("[Thu 2026-10-08
// 14:02 GMT+2] …", gateway injectTimestamp); the message is what follows.
const stamped = /^\[[A-Za-z]{2,4},? \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]{0,40}\]\s*/;

// The chats (agent-sessions/index.mjs), with OpenClaw's through its client:
// read as the others' items, started and sent to with a request id (once
// each) and live authorization (body.authorize). A run that ended on an
// error, or that OpenClaw never confirmed, ends on an error item.
export function agentChats(sessions, openClaw) {
  if (!openClaw) return sessions;
  const claw = (agent) => agent === "openclaw";
  const read = async (key, options = {}) => {
    const h = await openClaw.history(key, Math.min(Math.max(Number(options?.limit) || 200, 1), 1000));
    const items = (h.items || []).map((m) => ({
      id: String(m.id),
      role: m.tool ? "tool" : ["user", "assistant"].includes(m.role) ? m.role : "system",
      kind: m.tool ? "tool" : ["user", "assistant"].includes(m.role) ? "text" : "notice",
      text: m.role === "user" ? String(m.text || "").replace(stamped, "") : String(m.text || ""),
      ...(m.at ? { at: m.at } : {}),
    }));
    const status = h.session?.status;
    if (status === "error" || status === "unknown")
      items.push({
        id: `openclaw-${status}:${items.at(-1)?.id || "start"}`,
        role: "system",
        kind: "error",
        text:
          status === "unknown"
            ? "OpenClaw hasn't confirmed how this run ended."
            : String((h.error && openClaw.redact?.(h.error)) || "OpenClaw ended on an error."),
      });
    return {
      session: {
        title: h.session?.title || "",
        cwd: "",
        model: h.session?.model || "",
        status: BUSY.has(status) ? status : "idle",
        writable: h.session?.writable === true,
      },
      items,
      memory: null,
    };
  };
  return Object.assign(Object.create(sessions), {
    read: (agent, id, options) => (claw(agent) ? read(id, options) : sessions.read(agent, id, options)),
    async start(agent, body) {
      if (!claw(agent)) return sessions.start(agent, body);
      const { key } = await openClaw.start({ text: clipMiddle(body.text, CLAW_ROOM), requestId: body.requestId }, body.authorize);
      return { threadId: key };
    },
    send(agent, id, body) {
      if (!claw(agent)) return sessions.send(agent, id, body);
      return openClaw.send({ key: id, text: clipMiddle(body.text, CLAW_ROOM), requestId: body.requestId }, body.authorize);
    },
    stop: (agent, id) => (claw(agent) ? openClaw.stop(id) : sessions.stop?.(agent, id)),
  });
}

// The permissions a step's new chat starts with, never more. A reviewer
// reads only: Codex's read-only sandbox, Claude Code in Manual (it asks you
// before any edit or command). A builder works at each app's middle setting:
// Codex's Approve for me when it's on (else Ask for approval), Claude Code's
// Accept edits. Never Full access or Bypass.
export const REVIEW_MODES = {
  codex: { approvalPolicy: "on-request", sandbox: "read-only", approvalsReviewer: "user", modeName: "read-only" },
  claude: { mode: "manual" },
};
export async function startMode(step, offered = async () => []) {
  // OpenClaw has no mode Reach sets: its own tool rules and approvals apply.
  if (step.agent === "openclaw") return {};
  if (step.kind === "review") return REVIEW_MODES[step.agent];
  if (step.agent === "claude") return { mode: "acceptEdits" };
  const ids = await Promise.resolve()
    .then(() => offered("codex"))
    .catch(() => []);
  const name = ids.includes("guardian-approvals") ? "guardian-approvals" : "auto";
  return { ...CODEX_MODES[name], modeName: name };
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (text, max) => String(text ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, " ").trim().slice(0, max);

// The steps as asked for, checked: one to three, each a known kind; "back"
// needs a chat before the one it follows. "report" (a helper's result to its
// team's lead, teams.mjs) and "record" (how a workflow's task ended,
// workflows.mjs) are Reach's own: never ones the phone sets up.
// OpenClaw may be a step's agent when Reach has its Gateway (`agents`); a
// chat picked to send to, or sent back to, must then be one Reach made.
export function checkSteps(steps, from, agents = RELAY_AGENTS) {
  const named = agents.includes("openclaw") ? "Choose Codex, Claude Code or OpenClaw." : "Choose Codex or Claude Code.";
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) throw bad(`Choose one to ${MAX_STEPS} steps.`);
  return steps.map((step, n) => {
    const kind = step?.kind;
    if (!KINDS.includes(kind)) throw bad("Unknown step.");
    const instructions = clean(step.instructions, 4000);
    if (kind === "build" || kind === "review") {
      if (!agents.includes(step.agent)) throw bad(named);
      return { kind, agent: step.agent, ...(instructions ? { instructions } : {}) };
    }
    if (kind === "report" || kind === "record") throw bad("Unknown step.");
    if (kind === "send") {
      const to = { agent: step.to?.agent, id: step.to?.id };
      if (!agents.includes(to.agent) || !chatId(to.agent, to.id)) throw bad(agents.includes("openclaw") ? "Pick a Codex, Claude Code or OpenClaw chat." : "Pick a Codex or Claude Code chat.");
      if (to.agent === "openclaw" && !CLAW_KEY.test(to.id)) throw bad("Reach writes only in OpenClaw chats it made. Pick one of those.");
      if (n === 0 && to.agent === from.agent && to.id === from.id) throw bad("Pick another chat.");
      return { kind, to, ...(instructions ? { instructions } : {}) };
    }
    if (n === 0) throw bad("There's no chat to send back to yet.");
    if (n === 1 && from.agent === "openclaw" && !CLAW_KEY.test(from.id)) throw bad("Reach writes only in OpenClaw chats it made, so the review can't go back to this one.");
    return { kind };
  });
}

// Our message's opening words: its turn is the one to wait for.
const marker = (text) => String(text || "").split("\n")[0].slice(0, 80);
const startsWith = (item, expect) => !expect || visibleUserText(item?.text || "").trim().startsWith(expect);
// A workflow's own watch on one of its chats (workflows.mjs, watch below):
// not one of your relays, so never listed or announced.
const internal = (r) => r.steps.some((s) => s.kind === "record");

export function createRelays({
  // The chats (agent-sessions/index.mjs): list, read, send, start.
  sessions: chats,
  // OpenClaw's client (../openclaw.mjs), when Reach has its Gateway: its
  // chats join as sources and destinations (agentChats above).
  openClaw = null,
  file = null,
  // (owner) → why it can't send now ("" when it can).
  authorized = () => "",
  // A step's folder, checked as a new chat's (an existing folder in the home folder).
  folder = (cwd) => cwd,
  // The modes Codex offers now (whether "Approve for me" is on).
  modes = async () => [],
  notify = () => {},
  now = Date.now,
  settleMs = 4000,
  everyMs = 15000,
  setTimer = setTimeout,
  setEvery = setInterval,
  clearEvery = clearInterval,
} = {}) {
  const sessions = agentChats(chats, openClaw);
  const agents = openClaw ? [...RELAY_AGENTS, "openclaw"] : RELAY_AGENTS;
  const sources = openClaw ? [...SOURCES, "openclaw"] : SOURCES;
  // OpenClaw's client asks again before each Gateway call: the phone that
  // set this up must still be allowed.
  const allowed = (owner) => () => {
    const reason = authorized(owner);
    if (reason) throw bad(reason, 403);
  };
  let relays = [];
  if (file)
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) relays = saved.filter((r) => r && typeof r.id === "string" && Array.isArray(r.steps) && Array.isArray(r.chain));
    } catch {
      /* none yet */
    }
  // Sending when Reach stopped: it may have gone. Never sent again.
  for (const r of relays)
    if (r.state === "sending") {
      r.state = "uncertain";
      // Shown for a day from now, so it's seen.
      r.updatedAt = now();
      r.problem = `Reach restarted while this was being sent. Check ${agentName(r.steps[r.next]?.agent || r.steps[r.next]?.to?.agent || "the other chat")} before setting it up again.`;
    }
  let revision = 0;
  const listeners = new Set();
  // A reply seen once, waiting to be seen again settleMs later: relay id → { item, at }.
  const candidates = new Map();
  const save = () => {
    revision++;
    // Finished ones are kept a week (a workflow's own a day: it reads them
    // at once), at most 100 in all.
    const week = now() - 7 * 24 * 60 * 60 * 1000;
    const day = now() - 24 * 60 * 60 * 1000;
    relays = relays.filter((r) => ["waiting", "sending"].includes(r.state) || r.updatedAt > (internal(r) ? day : week)).slice(-100);
    if (file) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(relays), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    for (const listener of listeners) listener(revision);
  };
  const view = (r) => ({
    id: r.id,
    state: r.state,
    ...(r.trigger ? { trigger: r.trigger } : {}),
    ...(r.priority ? { priority: [...r.priority] } : {}),
    problem: r.problem || "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    next: r.next,
    steps: r.steps.map(({ kind, agent, to, instructions }) => ({ kind, ...(agent ? { agent } : {}), ...(to ? { to } : {}), ...(instructions ? { instructions } : {}) })),
    chain: r.chain.map(({ agent, id, title }) => ({ agent, id, title: title || "" })),
    sent: r.sent,
    // A helper's report: whether its turn ended on a reply, an error or a stop.
    ...(r.outcome ? { outcome: r.outcome } : {}),
  });
  const say = (r, title, body) =>
    Promise.resolve()
      .then(() => notify({ relay: view(r), title, body }))
      .catch(() => {});
  const stop = (r, problem) => {
    r.state = "stopped";
    r.problem = problem;
    r.updatedAt = now();
    candidates.delete(r.id);
    save();
    // A workflow says it its own way (workflows.mjs).
    if (!internal(r)) void say(r, "Relay stopped", problem);
  };

  // One step: the turn's material to its next chat, once.
  // quiet: set off from the phone just now (it opens the new chat itself).
  const fire = async (r, page, outcome, quiet = false) => {
    const reason = authorized(r.owner);
    if (reason) return void stop(r, reason);
    let step = r.steps[r.next];
    const src = r.chain.at(-1);
    if (r.trigger === "usage") {
      if (r.priority) {
        let health;
        try {
          health = await chats.health({ fresh: true });
        } catch {
          if (r.state === "waiting") stop(r, "Couldn't check provider availability. Set up auto-continue again to retry.");
          return;
        }
        // Cancellation or revocation may arrive while health is loading.
        if (r.state !== "waiting") return;
        const used = new Set(r.chain.map((c) => c.agent));
        const target = r.priority.find((a) => !used.has(a) && !continueUnavailable(a, health));
        if (!target) return void stop(r, "No unused provider in your priority order is available. Check sign-in and usage, then enable auto-continue again.");
        r.next = r.steps.findIndex((s) => s.agent === target);
        step = r.steps[r.next];
      }
      const denied = authorized(r.owner);
      if (denied) return void stop(r, denied);
      r.state = "sending";
      r.updatedAt = now();
      candidates.delete(r.id);
      save();
      try {
        const moved = await sessions.move(src.agent, src.id, {
          to: step.agent, resume: step.agent !== "openclaw", owner: r.owner, authorize: allowed(r.owner),
          ...(src.agent === "openclaw" && src.cwd ? { cwd: folder(src.cwd) } : {}),
        });
        if (step.agent === "openclaw") {
          try {
            await sessions.send("openclaw", moved.id, {
              text: `${resumeText(agentName(src.agent))}\n\n${CLAW_NOTE}`,
              requestId: `continue-${r.id}-${r.next}`, authorize: allowed(r.owner),
            });
            moved.resumed = true;
          } catch (e) {
            moved.resumed = false;
            moved.resumeError = e?.message || "The chat moved, but couldn't continue.";
          }
        }
        r.chain.push({ agent: moved.agent, id: moved.id, title: src.title, cwd: src.cwd });
        r.sent.push({ kind: "build", to: { agent: moved.agent, id: moved.id }, at: now() });
        r.next++;
        const more = r.priority?.some((a) => canContinue(a) && !r.chain.some((c) => c.agent === a));
        r.state = moved.resumed ? more ? "waiting" : "done" : "stopped";
        r.since = null;
        r.expect = "";
        r.problem = moved.resumed ? "" : moved.resumeError || "The chat moved, but couldn't continue. Open it to retry.";
        r.updatedAt = now();
        save();
        void say(r, moved.resumed ? "Auto-continued" : "Auto-continue stopped",
          moved.resumed ? `${agentName(src.agent)} ran out of usage. Continued in ${agentName(moved.agent)}.` : r.problem);
      } catch (e) {
        stop(r, e?.message || "Couldn't continue in the other agent.");
      }
      return;
    }
    // A helper's turn that ended on an error or a Stop is still reported to
    // its lead (what went wrong); every other step needs a reply.
    const material =
      outcome.kind === "reply"
        ? turnMaterial(page.items || [], { item: outcome.item.id })
        : step.kind === "report" || step.kind === "record"
          ? { request: "", answer: String(outcome.item?.text || ""), changes: [] }
          : null;
    if (!material) return void stop(r, "There was nothing to send.");
    // A workflow's task (workflows.mjs): how its turn ended is kept, with
    // the item it ended on, and nothing is sent.
    if (step.kind === "record") {
      r.outcome = outcome.kind;
      r.item = outcome.kind === "reply" ? outcome.item.id : (page.items || []).at(-1)?.id || null;
      r.next++;
      r.state = "done";
      r.problem = "";
      r.updatedAt = now();
      candidates.delete(r.id);
      save();
      return src;
    }
    const from = agentName(src.agent);
    const title = page.session?.title || src.title || "";
    const cwd = page.session?.cwd || src.cwd || "";
    r.state = "sending";
    r.updatedAt = now();
    candidates.delete(r.id);
    save();
    try {
      let to;
      let text;
      let queued = false;
      if (step.kind === "build" || step.kind === "review") {
        if (!cwd && step.agent !== "openclaw") throw bad("There's no folder to work in. Set it up again from a chat in one.");
        const dir = cwd ? folder(cwd) : "";
        text =
          step.kind === "review"
            ? reviewMessage({ from, title, cwd: dir, material })
            : relayMessage({ from, title, cwd: dir, material, instructions: step.instructions, build: true });
        if (step.agent === "openclaw") text = `${text}\n\n${CLAW_NOTE}`;
        const name = step.kind === "review" ? `Review: ${title || from}` : title;
        const started = await sessions.start(step.agent, {
          cwd: dir,
          text,
          images: [],
          ...(await startMode(step, modes)),
          ...(step.agent === "codex" && name ? { name: name.slice(0, 120) } : {}),
          ...(step.agent === "openclaw" ? { requestId: `relay-${r.id}-${r.next}`, authorize: allowed(r.owner) } : {}),
        });
        to = { agent: step.agent, id: started.threadId, title: name, cwd: dir };
      } else {
        const target = step.kind === "back" ? r.chain.at(-2) : step.to;
        text =
          step.kind === "report"
            ? reportMessage({ helper: src.agent, title: step.title || title, task: step.task, outcome: outcome.kind, material })
            : step.kind === "back"
              ? backMessage({ from, title, material })
              : relayMessage({ from, title, cwd, material, instructions: step.instructions });
        if (target.agent === "openclaw") text = `${text}\n\n${CLAW_NOTE}`;
        const result = await sessions.send(target.agent, target.id, {
          text,
          images: [],
          owner: r.owner,
          ...(target.agent === "openclaw" ? { requestId: `relay-${r.id}-${r.next}`, authorize: allowed(r.owner) } : {}),
        });
        // Taken in line, not yet in the chat (a Claude app chat at work, or
        // you at the Mac): it goes in when that chat is free.
        queued = result?.queued === true && result?.delivered === false;
        // An OpenClaw chat isn't in a folder: the work's stays with it.
        to = { agent: target.agent, id: target.id, title: target.title || "", cwd: target.cwd || (target.agent === "openclaw" ? cwd : "") };
      }
      r.sent.push({ kind: step.kind, to: { agent: to.agent, id: to.id }, at: now(), ...(queued ? { queued: true } : {}) });
      if (step.kind === "report") r.outcome = outcome.kind;
      r.chain.push(to);
      r.next++;
      // Next: the reply to what was just sent.
      r.since = null;
      r.expect = marker(text);
      r.state = r.next < r.steps.length ? "waiting" : "done";
      r.problem = "";
      r.waitingSince = now();
      r.updatedAt = now();
      save();
      const verb = { build: "is building on it", review: "is reviewing it", send: "has it", back: "has the review" }[step.kind];
      // A helper's report wakes its lead; the lead's own "finished" says the rest.
      if (!quiet && step.kind !== "report") void say(r, `${title || from} · Relayed`, `${agentName(to.agent)} ${verb}.`);
      return to;
    } catch (e) {
      stop(r, e?.message || "It couldn't be sent.");
      throw e;
    }
  };

  // Every waiting relay: has its chat's agent finished the turn it waits for?
  let checking = null;
  let again = false;
  const check = async () => {
    if (checking) {
      again = true;
      return checking;
    }
    checking = (async () => {
      do {
        again = false;
        const waiting = relays.filter((r) => r.state === "waiting");
        if (!waiting.length) break;
        let listed = [];
        try {
          listed = (await sessions.list())?.sessions || [];
        } catch {
          /* read each chat instead */
        }
        for (const r of waiting) {
          if (r.state !== "waiting") continue;
          if (now() - (r.waitingSince || r.createdAt) > WAIT_MS) {
            stop(r, `Waited a day for ${agentName(r.chain.at(-1).agent)} to finish.${internal(r) ? "" : " Set it up again if you still want it."}`);
            continue;
          }
          const src = r.chain.at(-1);
          const row = listed.find((s) => s.agent === src.agent && s.id === src.id);
          if (row && BUSY.has(row.status)) {
            candidates.delete(r.id);
            continue;
          }
          let page;
          try {
            page = await sessions.read(src.agent, src.id, { limit: 200 });
          } catch {
            continue;
          }
          if (r.state !== "waiting") continue;
          if (BUSY.has(page?.session?.status)) {
            candidates.delete(r.id);
            continue;
          }
          const items = page.items || [];
          const outcome = turnOutcome(items);
          const ours = startsWith(outcome.request, r.expect);
          const eligible = r.trigger === "usage"
            ? outcome.kind === "error" && usageLimited(src.agent, outcome.item)
            : outcome.kind === "reply";
          if (eligible && ours && outcome.item.id !== r.since) {
            const seen = candidates.get(r.id);
            if (seen?.item === outcome.item.id && now() - seen.at >= settleMs) {
              await fire(r, page, outcome).catch(() => {});
            } else if (seen?.item !== outcome.item.id) {
              candidates.set(r.id, { item: outcome.item.id, at: now() });
              // Looked at again when the reply has held for settleMs.
              setTimer(() => void check(), settleMs + 50)?.unref?.();
            }
          } else if (ours && ["report", "record"].includes(r.steps[r.next]?.kind) && (outcome.kind === "error" || outcome.kind === "stopped") && items.at(-1)?.id !== r.since) {
            // A helper that stopped: its lead hears of it (seen twice, as a
            // reply is); a workflow's task that stopped: its workflow does.
            const end = items.at(-1)?.id;
            const seen = candidates.get(r.id);
            if (seen?.item === end && now() - seen.at >= settleMs) await fire(r, page, outcome).catch(() => {});
            else if (seen?.item !== end) {
              candidates.set(r.id, { item: end, at: now() });
              setTimer(() => void check(), settleMs + 50)?.unref?.();
            }
          } else {
            candidates.delete(r.id);
            const end = items.at(-1)?.id;
            if (ours && (outcome.kind === "error" || outcome.kind === "stopped") && end !== r.since && end !== r.noted) {
              r.noted = end;
              r.problem = r.trigger === "usage" ? "Auto-continue waits for a usage limit; other errors and stops do not switch providers." : `${agentName(src.agent)} ${outcome.kind === "stopped" ? "was stopped" : "ended on an error"}. This waits for its next reply.`;
              r.updatedAt = now();
              save();
            }
          }
        }
      } while (again);
    })().finally(() => {
      checking = null;
    });
    return checking;
  };
  const timer = setEvery(() => void check(), everyMs);
  timer?.unref?.();

  return {
    list: () => relays.filter((r) => !internal(r) && (["waiting", "sending"].includes(r.state) || now() - r.updatedAt < 24 * 60 * 60 * 1000)).map(view),
    // One relay as it stands (a workflow's own included), with the item its
    // watched turn ended on.
    get(id) {
      const r = relays.find((x) => x.id === id);
      return r ? { ...view(r), ...(r.item ? { item: r.item } : {}) } : null;
    },
    revision: () => revision,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Set up from the phone: what to send on, to whom, and when (at once,
    // from a reply already there; or when the chat's agent next finishes).
    // A relay that starts at once answers with the chat it went to.
    // An OpenClaw chat isn't in a folder: a build or review from it needs
    // one picked (`cwd`, checked as a new chat's).
    async start({ owner, from, steps, now: atOnce = false, item = null, cwd = "", postBack = false, trigger = "reply", priority = null }) {
      if (!sources.includes(from?.agent) || !chatId(from.agent, from?.id)) throw bad("Unknown chat.", 404);
      const ordered = priority === null ? null : checkContinuePriority(priority);
      if (ordered && (trigger !== "usage" || steps !== undefined)) throw bad("Use a priority order instead of relay steps for auto-continue.");
      const checked = ordered ? ordered.filter((a) => a !== from.agent).map((agent) => ({ kind: "build", agent })) : checkSteps(steps, from, agents);
      if (ordered && (!canContinue(from.agent) || !ordered.includes(from.agent) ||
          !checked.some((s) => canContinue(s.agent)) || atOnce || item || postBack))
        throw bad("Include this provider and at least one other provider Reach can continue in.");
      if (!["reply", "usage"].includes(trigger)) throw bad("Unknown relay trigger.");
      if (trigger === "usage" && !ordered && (!RELAY_AGENTS.includes(from.agent) || checked.length !== 1 ||
          checked[0].kind !== "build" || !RELAY_AGENTS.includes(checked[0].agent) || checked[0].agent === from.agent ||
          atOnce || item || postBack || checked[0].instructions))
        throw bad("Auto-continue needs one other provider: Codex or Claude Code.");
      const reason = authorized(owner);
      if (reason) throw bad(reason, 403);
      const dir = from.agent === "openclaw" && cwd ? folder(cwd) : "";
      if (from.agent === "openclaw" && !dir && ["build", "review"].includes(checked[0].kind) && checked[0].agent !== "openclaw")
        throw bad("Pick the folder to work in.");
      if (relays.some((r) => ["waiting", "sending"].includes(r.state) && r.chain.some((c) => c.agent === from.agent && c.id === from.id) && !atOnce))
        throw bad("This chat already has a relay waiting. Cancel it first.", 409);
      const page = await sessions.read(from.agent, from.id, { limit: 200 });
      const items = page.items || [];
      // A chat picked to send to must be there; its name shows on the phone.
      for (const step of checked)
        if (step.kind === "send") {
          const target = await sessions.read(step.to.agent, step.to.id, { limit: 1 }).catch(() => null);
          if (!target?.session) throw bad("That chat isn't on this computer any more.", 404);
          if (step.to.agent === "openclaw" && !target.session.writable) throw bad("Reach writes only in OpenClaw chats it made. Pick one of those.");
          step.to = { ...step.to, title: target.session.title || "", cwd: target.session.cwd || "" };
        }
      const denied = authorized(owner);
      if (denied) throw bad(denied, 403);
      if (!atOnce && relays.some((r) => ["waiting", "sending"].includes(r.state) && r.chain.some((c) => c.agent === from.agent && c.id === from.id)))
        throw bad("This chat already has a relay waiting. Cancel it first.", 409);
      const r = {
        id: randomUUID(),
        owner,
        createdAt: now(),
        updatedAt: now(),
        waitingSince: now(),
        steps: checked,
        trigger,
        ...(ordered ? { priority: ordered } : {}),
        next: 0,
        chain: [{ agent: from.agent, id: from.id, title: page.session?.title || "", cwd: page.session?.cwd || dir }],
        // Waiting: a reply newer than the chat's end now (any reply ending
        // the turn it's in, when it's working now).
        since: trigger === "usage" || BUSY.has(page.session?.status) ? null : items.at(-1)?.id || null,
        expect: "",
        state: "waiting",
        problem: "",
        sent: [],
      };
      if (!atOnce) {
        relays.push(r);
        save();
        void check();
        return { relay: view(r) };
      }
      let outcome;
      if (item) {
        const at = items.findIndex((i) => i.id === item);
        outcome = at >= 0 ? turnOutcome(items.slice(0, at + 1)) : null;
      } else outcome = turnOutcome(items);
      if (outcome?.kind !== "reply") throw bad("There's no reply to send yet. Wait for the agent to finish.", 409);
      relays.push(r);
      const to = await fire(r, page, outcome, true);
      if (!to) throw bad(r.problem || "It couldn't be sent.", 409);
      return { relay: view(r), opened: { agent: to.agent, id: to.id } };
    },
    // Reach's own: when `from` (a helper's chat) answers the message that
    // begins with `expect`, its result goes to `to` (its lead), once.
    follow({ owner, from, to, expect, title = "", task = "", team = "" }) {
      const r = {
        id: randomUUID(),
        owner,
        createdAt: now(),
        updatedAt: now(),
        waitingSince: now(),
        steps: [{ kind: "report", to: { agent: to.agent, id: to.id, title: to.title || "" }, title, task, team }],
        next: 0,
        chain: [{ agent: from.agent, id: from.id, title: from.title || title, cwd: from.cwd || "" }],
        since: null,
        expect: marker(expect),
        state: "waiting",
        problem: "",
        sent: [],
      };
      relays.push(r);
      save();
      void check();
      return view(r);
    },
    // Reach's own, for a workflow (workflows.mjs): when `from` answers the
    // message that begins with `expect` (any message, when it's empty), with
    // a reply other than `since`, how its turn ended (a reply, an error or a
    // stop) is kept, once, and nothing is sent. Read back with get().
    watch({ owner, from, expect = "", since = null, workflow = "", task = "" }) {
      const r = {
        id: randomUUID(),
        owner,
        createdAt: now(),
        updatedAt: now(),
        waitingSince: now(),
        steps: [{ kind: "record", workflow, task }],
        next: 0,
        chain: [{ agent: from.agent, id: from.id, title: from.title || "", cwd: from.cwd || "" }],
        since,
        expect: marker(expect),
        state: "waiting",
        problem: "",
        sent: [],
      };
      relays.push(r);
      save();
      void check();
      return r.id;
    },
    cancel(id) {
      const r = relays.find((x) => x.id === id);
      if (!r) throw bad("That relay is gone.", 404);
      if (r.state === "sending") throw bad("It's being sent right now.", 409);
      if (r.state !== "waiting") return { cancelled: false };
      r.state = "stopped";
      r.problem = "Cancelled.";
      r.updatedAt = now();
      candidates.delete(r.id);
      save();
      return { cancelled: true };
    },
    // The agents a step can go to here.
    agents: () => [...agents],
    check,
    stop: () => clearEvery(timer),
  };
}
