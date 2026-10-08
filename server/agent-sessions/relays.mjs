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
import { agentName } from "./move.mjs";
import { turnOutcome } from "./turn-watch.mjs";
import { CODEX_MODES } from "./codex.mjs";
import { visibleUserText } from "./message-text.mjs";
import { backMessage, relayMessage, reportMessage, reviewMessage, turnMaterial } from "./chat-context.mjs";

// Who can receive (new chats, messages); whose chats can be read to send on.
export const RELAY_AGENTS = ["codex", "claude"];
const SOURCES = ["codex", "claude", "gemini"];
const KINDS = ["build", "review", "send", "back", "report", "record"];
export const MAX_STEPS = 3;
// A relay left waiting this long stops (set it up again if still wanted).
export const WAIT_MS = 24 * 60 * 60 * 1000;
const BUSY = new Set(["running", "waiting"]);
const ID = /^[\w-]{1,80}$/;

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
export function checkSteps(steps, from) {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) throw bad(`Choose one to ${MAX_STEPS} steps.`);
  return steps.map((step, n) => {
    const kind = step?.kind;
    if (!KINDS.includes(kind)) throw bad("Unknown step.");
    const instructions = clean(step.instructions, 4000);
    if (kind === "build" || kind === "review") {
      if (!RELAY_AGENTS.includes(step.agent)) throw bad("Choose Codex or Claude Code.");
      return { kind, agent: step.agent, ...(instructions ? { instructions } : {}) };
    }
    if (kind === "report" || kind === "record") throw bad("Unknown step.");
    if (kind === "send") {
      const to = { agent: step.to?.agent, id: step.to?.id };
      if (!RELAY_AGENTS.includes(to.agent) || typeof to.id !== "string" || !ID.test(to.id)) throw bad("Pick a Codex or Claude Code chat.");
      if (n === 0 && to.agent === from.agent && to.id === from.id) throw bad("Pick another chat.");
      return { kind, to, ...(instructions ? { instructions } : {}) };
    }
    if (n === 0) throw bad("There's no chat to send back to yet.");
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
  sessions,
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
    const step = r.steps[r.next];
    const src = r.chain.at(-1);
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
        const dir = folder(cwd);
        text =
          step.kind === "review"
            ? reviewMessage({ from, title, cwd: dir, material })
            : relayMessage({ from, title, cwd: dir, material, instructions: step.instructions, build: true });
        const name = step.kind === "review" ? `Review: ${title || from}` : title;
        const started = await sessions.start(step.agent, {
          cwd: dir,
          text,
          images: [],
          ...(await startMode(step, modes)),
          ...(step.agent === "codex" && name ? { name: name.slice(0, 120) } : {}),
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
        const result = await sessions.send(target.agent, target.id, { text, images: [], owner: r.owner });
        // Taken in line, not yet in the chat (a Claude app chat at work, or
        // you at the Mac): it goes in when that chat is free.
        queued = result?.queued === true && result?.delivered === false;
        to = { agent: target.agent, id: target.id, title: target.title || "", cwd: target.cwd || "" };
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
          if (outcome.kind === "reply" && ours && outcome.item.id !== r.since) {
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
              r.problem = `${agentName(src.agent)} ${outcome.kind === "stopped" ? "was stopped" : "ended on an error"}. This waits for its next reply.`;
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
    async start({ owner, from, steps, now: atOnce = false, item = null }) {
      if (!SOURCES.includes(from?.agent) || typeof from?.id !== "string" || !ID.test(from.id)) throw bad("Unknown chat.", 404);
      const checked = checkSteps(steps, from);
      const reason = authorized(owner);
      if (reason) throw bad(reason, 403);
      if (relays.some((r) => r.state === "waiting" && r.chain.length === 1 && r.chain[0].agent === from.agent && r.chain[0].id === from.id && !atOnce))
        throw bad("This chat already has a relay waiting. Cancel it first.", 409);
      const page = await sessions.read(from.agent, from.id, { limit: 200 });
      const items = page.items || [];
      // A chat picked to send to must be there; its name shows on the phone.
      for (const step of checked)
        if (step.kind === "send") {
          const target = await sessions.read(step.to.agent, step.to.id, { limit: 1 }).catch(() => null);
          if (!target?.session) throw bad("That chat isn't on this computer any more.", 404);
          step.to = { ...step.to, title: target.session.title || "", cwd: target.session.cwd || "" };
        }
      const r = {
        id: randomUUID(),
        owner,
        createdAt: now(),
        updatedAt: now(),
        waitingSince: now(),
        steps: checked,
        next: 0,
        chain: [{ agent: from.agent, id: from.id, title: page.session?.title || "", cwd: page.session?.cwd || "" }],
        // Waiting: a reply newer than the chat's end now (any reply ending
        // the turn it's in, when it's working now).
        since: BUSY.has(page.session?.status) ? null : items.at(-1)?.id || null,
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
    check,
    stop: () => clearEvery(timer),
  };
}
