// Tag in: an agent uses a Mac app on its own hidden display, the way the
// phone's Apps do (server/app-threads.mjs), and hands it to you when only a
// person can go on (a sign-in code, "does this look right?"). You do that
// part on your phone, in the same live window, and hand it back.
//
// An agent may only touch apps it opened, never one a person has open, and
// never makes room by closing yours. It acts only while nobody is using the
// Mac, nobody controls the screen from a phone, Reach isn't paused, and the
// app isn't handed to you. When its access ends (expiry or revoke), its apps
// go back to the Mac: agents come in, do things, and leave.
import crypto from "node:crypto";
import fs from "node:fs";
import { fail } from "./core.mjs";
import { inputAction } from "./desktop-protocol.mjs";
import { MAX_THREADS } from "./app-threads.mjs";

// Seconds without a key press or mouse move on the Mac before an agent may
// act: someone at the Mac keeps their pointer and keyboard.
export const IDLE_AFTER = 15;
// An agent's apps open phone-shaped, so handing one to you needs no resize.
export const AGENT_PHONE = { width: 393, height: 852, scale: 3 };
const WAIT_MAX = 25000;
// Seconds of leeway between sending an action and the Mac's idle clock
// (ioreg's reading takes a moment): input older than that is a person's.
const OUR_SLACK = 0.5;
const REASON_MAX = 300;
const NOTE_MAX = 500;

const waiting = (message, status = 409) =>
  Object.assign(fail(status, message), { waiting: true });

// Width and height of a JPEG, from its frame header.
export function jpegSize(data) {
  if (!Buffer.isBuffer(data) || data[0] !== 0xff || data[1] !== 0xd8)
    return null;
  let at = 2;
  while (at + 9 < data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    const length = data.readUInt16BE(at + 2);
    // SOF0–SOF15, except the DHT/JPG/DAC markers that share the range.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return {
        height: data.readUInt16BE(at + 5),
        width: data.readUInt16BE(at + 7),
      };
    at += 2 + length;
  }
  return null;
}

// An agent's action, in the pixels of its last look at the window, as the
// input helper's actions on the hidden display (0–1 across the display).
export function agentActions(action, thread, basis) {
  if (!action || typeof action !== "object")
    throw fail(400, "Send an action: click, type, key, scroll or menu.");
  const { region, size } = thread;
  const scaleX = region.w / basis.width,
    scaleY = region.h / basis.height;
  const at = () => {
    const { x, y } = action;
    if (
      ![x, y].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      x > basis.width ||
      y > basis.height
    )
      throw fail(
        400,
        `x and y are pixels in the app's picture (0–${basis.width} by 0–${basis.height}).`,
      );
    return {
      x: (region.x + x * scaleX) / size.w,
      y: (region.y + y * scaleY) / size.h,
    };
  };
  const list = (() => {
    switch (action.type) {
      case "click":
        return [
          {
            type: "click",
            ...at(),
            button: action.button ?? "left",
            count: action.count ?? 1,
          },
        ];
      case "type":
        return [{ type: "text", text: action.text }];
      case "key":
        return [
          { type: "key", key: action.key, modifiers: action.modifiers ?? [] },
        ];
      case "menu":
        // Only through the app's menus (Accessibility): no pointer form.
        menuPath(action);
        return [];
      case "scroll": {
        // dy > 0 shows what's further down, in the picture's pixels; the
        // Mac takes at most 120 points per step, upwards positive.
        const dy = Math.round((Number(action.dy) || 0) * scaleY),
          dx = Math.round((Number(action.dx) || 0) * scaleX);
        if (!dy && !dx) throw fail(400, "Scroll by a dy (or dx) in pixels.");
        if (Math.abs(dy) > 5000 || Math.abs(dx) > 5000)
          throw fail(400, "Scroll at most 5000 pixels at a time.");
        const steps = Math.ceil(Math.max(Math.abs(dy), Math.abs(dx)) / 120);
        return [
          { type: "move", ...at() },
          ...Array.from({ length: steps }, (_, i) => ({
            type: "scroll",
            dy: -share(dy, steps, i),
            dx: -share(dx, steps, i),
          })),
        ];
      }
      default:
        throw fail(400, "Send an action: click, type, key, scroll or menu.");
    }
  })();
  return list.map(inputAction);
}
export function menuPath(action) {
  const path = action.path;
  if (
    !Array.isArray(path) ||
    !path.length ||
    path.length > 6 ||
    path.some((p) => typeof p !== "string" || !p.trim() || p.length > 80)
  )
    throw fail(400, 'A menu is a path of titles, like ["Edit", "Select All"].');
  return path.map((p) => p.trim());
}
// The same action through the app itself, without the pointer or keyboard
// (scripts/native/agent-input.swift), or null when it needs the pointer.
// Points are in the hidden display's points.
export function appAction(action, thread, basis) {
  const { region } = thread;
  const base = {
    app: thread.appId,
    display: thread.display,
    thread: thread.id,
  };
  // The agent's window, for actions that go to the app (keys, menus).
  const middle = { x: region.x + region.w / 2, y: region.y + region.h / 2 };
  switch (action.type) {
    case "click":
      if ((action.button ?? "left") !== "left" || (action.count ?? 1) !== 1)
        return null;
      return {
        ...base,
        cmd: "press",
        x: region.x + (action.x * region.w) / basis.width,
        y: region.y + (action.y * region.h) / basis.height,
      };
    case "type":
      return { ...base, ...middle, cmd: "text", text: action.text };
    case "key":
      return {
        ...base,
        ...middle,
        cmd: "key",
        key: action.key,
        modifiers: action.modifiers ?? [],
      };
    case "menu":
      return { ...base, ...middle, cmd: "menu", path: menuPath(action) };
    default:
      return null;
  }
}
// Step i's part of `total` split into `steps` near-equal whole parts.
const share = (total, steps, i) =>
  Math.trunc((total * (i + 1)) / steps) - Math.trunc((total * i) / steps);

export class AgentApps {
  constructor({
    threads,
    control,
    file,
    paused = () => false,
    idle,
    idleAfter = IDLE_AFTER,
    capture,
    createInput,
    // Starts the agent-only input helper (in-app actions), or null.
    targeted = null,
    // The display a phone's screen control is on, by its client id.
    controlDisplay = () => undefined,
    onChange = () => {},
    now = Date.now,
    inputIdleMs = 30000,
  }) {
    Object.assign(this, {
      threads,
      control,
      file,
      paused,
      idle,
      idleAfter,
      capture,
      createInput,
      targeted,
      controlDisplay,
      onChange,
      now,
      inputIdleMs,
    });
    // thread id -> { clientId, agent }
    this.owners = new Map();
    // hand-off id -> { id, threadId, clientId, agent, app, reason, state, … }
    this.handoffs = new Map();
    this.waiters = new Map();
    this.inputs = new Map();
    // Each app's actions, one after another.
    this.chains = new Map();
    // What each agent last saw of a window: its actions are in those pixels.
    this.seen = new Map();
    this.opening = new Set();
    // When Reach last sent agent input, and last saw a person's (ms).
    this.actedAt = -Infinity;
    this.personAt = -Infinity;
    this.load();
  }
  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [id, owner] of Object.entries(data.owners || {}))
        if (typeof owner?.clientId === "string")
          this.owners.set(id, {
            clientId: owner.clientId,
            agent: String(owner.agent || "An agent"),
          });
      for (const h of Array.isArray(data.handoffs) ? data.handoffs : [])
        if (typeof h?.id === "string" && typeof h.threadId === "string")
          this.handoffs.set(h.id, h);
    } catch {}
  }
  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          owners: Object.fromEntries(this.owners),
          // Only what someone still waits on.
          handoffs: [...this.handoffs.values()].filter(
            (h) => h.state === "waiting",
          ),
        }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, this.file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
  changed(reason, detail) {
    this.save();
    this.onChange(reason, detail);
  }
  // Which agent uses this app, for the phone's list.
  agentOf(threadId) {
    return this.owners.get(threadId)?.agent ?? null;
  }
  // A thread that went away (closed on the phone or the Mac) ends with it.
  forget(threadId, state = "closed") {
    let changed = this.owners.delete(threadId);
    this.seen.delete(threadId);
    this.chains.delete(threadId);
    this.stopInput(threadId);
    for (const h of this.handoffs.values())
      if (h.threadId === threadId && h.state === "waiting") {
        this.finish(h, { state });
        changed = true;
      }
    if (changed) this.changed("closed");
  }
  owned(client, id) {
    const owner = this.owners.get(id);
    if (!owner || owner.clientId !== client.id)
      throw fail(404, "That app isn't one this agent opened.");
    const thread = this.threads.get(id);
    if (!thread) {
      this.forget(id);
      throw fail(410, "That app was closed, on the phone or the Mac.");
    }
    return thread;
  }
  running(client, id) {
    const thread = this.owned(client, id);
    if (thread.state !== "running" || !thread.region || !thread.size)
      throw fail(
        409,
        `${thread.name} isn't running. Open it again with reach_open_app.`,
      );
    return thread;
  }
  view(thread) {
    const handoff = [...this.handoffs.values()].find(
      (h) => h.threadId === thread.id && h.state === "waiting",
    );
    return {
      id: thread.id,
      app: thread.name,
      appId: thread.appId,
      state: thread.state,
      ...(handoff && {
        withPerson: { handoff: handoff.id, reason: handoff.reason },
      }),
    };
  }
  list(client) {
    const mine = [];
    for (const [id, owner] of this.owners) {
      if (owner.clientId !== client.id) continue;
      const thread = this.threads.get(id);
      if (thread) mine.push(this.view(thread));
      else this.forget(id);
    }
    return mine;
  }
  async open(client, appId) {
    if (typeof appId !== "string" || !appId)
      throw fail(400, "Choose an app by its id, from reach_list_apps.");
    if (this.paused())
      throw waiting("Reach is paused on the Mac. Try again later.", 423);
    const existing = [...this.threads.threads.values()].find(
      (t) => t.appId === appId,
    );
    if (existing) {
      const owner = this.owners.get(existing.id);
      if (owner?.clientId !== client.id)
        throw fail(
          409,
          `${existing.name} is open on someone's phone. Choose another app, or ask them to close it.`,
        );
      if (existing.state === "running") return this.view(existing);
    } else if (this.threads.threads.size >= MAX_THREADS)
      // Never by closing someone's app: AppThreads would forget the oldest.
      throw fail(409, "Four apps are already open on phones. Try again later.");
    if (this.opening.has(appId))
      throw fail(409, "That app is still opening. Try again in a moment.");
    // Starting an app can bring it to the front (Chrome does, even when asked
    // not to): never while someone is using the Mac. One already running
    // opens a window of its own for the agent, out of their way; one that
    // would lend its existing window (Notes) waits, since that window may be
    // the one they're using.
    const now = await this.situation({ id: "", name: "" });
    if (now.wait) throw now.wait;
    if (!now.alone) {
      const helper = await this.appHelper();
      const reply = helper
        ? await helper.send({ cmd: "running", app: appId })
        : null;
      if (reply?.running !== true)
        throw waiting(
          `${now.why}, and starting that app could take their focus. Try again ${now.retry}, or use an app that's already open.`,
        );
    }
    this.opening.add(appId);
    try {
      let thread;
      try {
        thread = await this.threads.open(appId, AGENT_PHONE, {
          lend: now.alone === true,
        });
      } catch (e) {
        if (e.code !== "lend") throw e;
        throw waiting(
          `${now.why}, and opening that app would take their window. Try again ${now.retry}.`,
        );
      }
      this.owners.set(thread.id, {
        clientId: client.id,
        agent: client.name || "An agent",
      });
      this.changed("opened");
      return this.view(this.threads.get(thread.id));
    } finally {
      this.opening.delete(appId);
    }
  }
  // A picture of the window. Its pixels are the coordinates of reach_app_action.
  async see(client, id) {
    const thread = this.running(client, id);
    const source = (
      await this.capture({
        display: thread.display,
        region: thread.region,
        format: "jpeg",
        fps: 2,
        width: Math.max(16, Math.round(thread.region.w)),
        bitrate: 2000000,
      })
    )();
    let frame;
    try {
      // A one-byte frame means "unchanged": ask again for the picture.
      for (let i = 0; i < 4 && !(frame?.length > 4); i++)
        frame = await source.next();
    } finally {
      source.stop();
    }
    const size = jpegSize(frame);
    if (!size) throw fail(503, `Couldn't capture ${thread.name}. Try again.`);
    this.seen.set(id, size);
    return {
      ...this.view(thread),
      mimeType: "image/jpeg",
      image: frame.toString("base64"),
      width: size.width,
      height: size.height,
    };
  }
  // What's going on around the agent's app: something it must wait for (a
  // hand-off, a pause, a phone in this same app), or whether it's alone with
  // the Mac (then it may use the pointer too).
  async situation(thread) {
    const handoff = [...this.handoffs.values()].find(
      (h) => h.threadId === thread.id && h.state === "waiting",
    );
    if (handoff)
      return {
        wait: waiting(
          `${thread.name} is with the person ("${handoff.reason}"). Wait for it with reach_wait_for_person.`,
        ),
      };
    if (this.paused())
      return {
        wait: waiting("Reach is paused on the Mac. Try again later.", 423),
      };
    const holder = this.control.holder();
    if (
      holder &&
      thread.display &&
      this.controlDisplay(holder.clientId) === thread.display
    )
      return {
        wait: waiting(
          `${holder.name || "Someone"} is using ${thread.name} from a phone; you take turns in the same app. Try again in a minute.`,
        ),
      };
    if (holder)
      return {
        alone: false,
        why: `${holder.name || "Someone"} is using the screen from a phone`,
        retry: "in a minute",
      };
    const idle = await Promise.resolve()
      .then(() => this.idle())
      .catch(() => null);
    if (idle === null || !Number.isFinite(idle))
      return {
        alone: false,
        why: "Reach can't tell whether someone is at the Mac",
        retry: "shortly",
      };
    // The Mac counts Reach's own clicks and keys as input too. Input newer
    // than our last action is a person's; otherwise it was ours.
    const now = this.now();
    const sinceOurs = (now - this.actedAt) / 1000;
    if (idle < sinceOurs - OUR_SLACK)
      this.personAt = Math.max(this.personAt, now - idle * 1000);
    const sincePerson = (now - this.personAt) / 1000;
    if (sincePerson < this.idleAfter)
      return {
        alone: false,
        why: "Someone is using the Mac",
        retry: `in ${Math.ceil(this.idleAfter - sincePerson)} s`,
      };
    return { alone: true };
  }
  // In parallel with you: through the app itself first (its own window, no
  // pointer, no keyboard, nothing brought to the front). The pointer only
  // when nobody is at the Mac; otherwise the agent waits.
  async act(client, id, action) {
    const thread = this.running(client, id);
    const basis = this.seen.get(id) || {
      width: Math.round(thread.region.w),
      height: Math.round(thread.region.h),
    };
    const steps = agentActions(action, thread, basis);
    const inApp = appAction(action, thread, basis);
    const run = (this.chains.get(id) || Promise.resolve()).then(async () => {
      let tried;
      if (inApp) {
        const helper = await this.appHelper();
        if (helper) {
          const now = await this.situation(this.running(client, id));
          if (now.wait) throw now.wait;
          // A menu acts on the app's front window, so the app must be in
          // front: only when nobody is at the Mac (tested Oct 5: a menu
          // item of a background app does nothing).
          if (inApp.cmd === "menu") {
            if (!now.alone)
              throw waiting(
                `${now.why}, and menus need ${thread.name} in front. Try again ${now.retry}.`,
              );
            await this.threads.activate(id);
          }
          tried = await helper.send({ ...inApp, alone: now.alone === true });
          if (tried.done) {
            // Keys posted to the app may count as input on the Mac.
            if (tried.kind === "posted") this.actedAt = this.now();
            return { done: true, lane: "app" };
          }
        }
      }
      if (!steps.length)
        throw fail(
          409,
          `Couldn't use that menu${tried?.why ? `: ${tried.why}` : ""}.`,
        );
      const input = this.input(this.running(client, id));
      for (const step of steps) {
        // Checked before every step: a person can come back mid-way.
        const now = await this.situation(this.running(client, id));
        if (now.wait) throw now.wait;
        if (!now.alone)
          throw waiting(
            `${now.why}${tried ? `, and this needs the pointer (${tried.why})` : ""}. Try again ${now.retry}.`,
          );
        if (step === steps[0]) await this.threads.activate(id);
        try {
          await (await input.helper).send(step);
        } finally {
          this.actedAt = this.now();
        }
      }
      this.touchInput(id);
      return { done: true, lane: "pointer" };
    });
    // The next action waits for this one, whatever its outcome.
    this.chains.set(
      id,
      run.catch(() => {}),
    );
    return run;
  }
  // The agent-only input helper, started once; null when there's none.
  appHelper() {
    if (!this.targeted) return Promise.resolve(null);
    if (this.app?.stopped) this.appStart = null;
    return (this.appStart ??= Promise.resolve()
      .then(() => this.targeted())
      .then(
        (helper) => (this.app = helper),
        () => {
          this.appStart = null;
          return null;
        },
      ));
  }
  input(thread) {
    let input = this.inputs.get(thread.id);
    if (!input || input.display !== thread.display || input.stopped) {
      this.stopInput(thread.id);
      input = {
        display: thread.display,
        helper: Promise.resolve().then(() => this.createInput(thread.display)),
      };
      // A failed start isn't kept: the next action tries again.
      input.helper.catch(() => {
        if (this.inputs.get(thread.id) === input) this.inputs.delete(thread.id);
      });
      this.inputs.set(thread.id, input);
    }
    this.touchInput(thread.id);
    return input;
  }
  touchInput(id) {
    const input = this.inputs.get(id);
    if (!input) return;
    clearTimeout(input.timer);
    input.timer = setTimeout(() => this.stopInput(id), this.inputIdleMs);
    input.timer.unref?.();
  }
  stopInput(id) {
    const input = this.inputs.get(id);
    if (!input) return;
    this.inputs.delete(id);
    input.stopped = true;
    clearTimeout(input.timer);
    input.helper.then(
      (h) => h.stop(),
      () => {},
    );
  }
  handOff(client, id, reason) {
    const thread = this.running(client, id);
    const text = typeof reason === "string" ? reason.trim() : "";
    if (!text)
      throw fail(400, "Say what the person should do, in one short sentence.");
    const open = [...this.handoffs.values()].find(
      (h) => h.threadId === id && h.state === "waiting",
    );
    if (open) return this.handoffView(open);
    const handoff = {
      id: crypto.randomUUID(),
      threadId: id,
      clientId: client.id,
      agent: client.name || "An agent",
      app: thread.name,
      appId: thread.appId,
      reason: text.slice(0, REASON_MAX),
      state: "waiting",
      createdAt: new Date(this.now()).toISOString(),
    };
    this.handoffs.set(handoff.id, handoff);
    this.stopInput(id);
    this.changed("handoff", handoff);
    return this.handoffView(handoff);
  }
  handoffView(h) {
    return {
      handoff: h.id,
      app: h.app,
      state: h.state,
      ...(h.note && { note: h.note }),
    };
  }
  // Until the person hands the app back (or WAIT_MAX passes: ask again).
  async wait(client, handoffId, ms = WAIT_MAX) {
    const h = this.handoffs.get(handoffId);
    if (!h || h.clientId !== client.id)
      throw fail(404, "No such hand-off for this agent.");
    if (h.state === "waiting" && !this.threads.get(h.threadId))
      this.forget(h.threadId);
    const asked = Number(ms);
    const limit = Number.isFinite(asked)
      ? Math.max(0, Math.min(WAIT_MAX, asked))
      : WAIT_MAX;
    if (h.state === "waiting" && limit > 0) {
      await new Promise((resolve) => {
        const set = this.waiters.get(h.id) || new Set();
        this.waiters.set(h.id, set);
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        };
        const timer = setTimeout(done, limit);
        set.add(done);
      });
    }
    return this.handoffView(h);
  }
  finish(h, { state, note }) {
    h.state = state;
    if (note) h.note = note;
    h.doneAt = new Date(this.now()).toISOString();
    for (const done of this.waiters.get(h.id) || []) done();
    this.waiters.delete(h.id);
  }
  // What waits for a person, for the phone.
  pending() {
    const out = [];
    for (const h of this.handoffs.values()) {
      if (h.state !== "waiting") continue;
      if (!this.threads.get(h.threadId)) {
        this.forget(h.threadId);
        continue;
      }
      out.push({
        id: h.id,
        threadId: h.threadId,
        agent: h.agent,
        app: h.app,
        appId: h.appId,
        reason: h.reason,
        createdAt: h.createdAt,
      });
    }
    return out;
  }
  // The person is done ("back"), or tells the agent to stop ("stopped").
  handBack(handoffId, { note, stop = false } = {}) {
    const h = this.handoffs.get(handoffId);
    if (!h) throw fail(404, "That hand-off has ended.");
    if (h.state !== "waiting") return this.handoffView(h);
    const text = typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : "";
    this.finish(h, { state: stop ? "stopped" : "back", note: text });
    this.changed("handback");
    return this.handoffView(h);
  }
  async close(client, id) {
    this.owned(client, id);
    const result = await this.threads.close(id);
    this.forget(id);
    return result;
  }
  // The agent leaves: its apps go back to the Mac.
  async release(clientId) {
    const mine = [...this.owners]
      .filter(([, o]) => o.clientId === clientId)
      .map(([id]) => id);
    for (const id of mine) {
      if (this.threads.get(id)) await this.threads.close(id).catch(() => {});
      this.forget(id, "ended");
    }
    return mine.length;
  }
  // Agents whose access ended (expiry, revoke, a changed profile) leave.
  async sweep(valid) {
    const ended = new Set(
      [...this.owners.values()]
        .map((o) => o.clientId)
        .filter((clientId) => !valid(clientId)),
    );
    for (const clientId of ended) await this.release(clientId);
    return ended.size;
  }
  shutdown() {
    for (const id of [...this.inputs.keys()]) this.stopInput(id);
    this.app?.stop?.();
    for (const set of this.waiters.values()) for (const done of set) done();
  }
}
