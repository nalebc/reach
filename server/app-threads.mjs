import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fail } from "./core.mjs";
import { RemoteBroadcast } from "./remote-screen.mjs";
import { NativeScreenSource } from "./screen-stream.mjs";
import { desktopBinary } from "./desktop-native.mjs";
import { pausedMessage } from "./screen.mjs";

// Apps on your phone: each app runs on the Mac, on its own hidden display, in
// a window shaped like the phone (scripts/native/app-displays.m). Its video
// and input reuse the live screen's channels, pointed at that display.
const exec = promisify(execFile);
const helperSource = fileURLToPath(
  new URL("../scripts/native/app-displays.m", import.meta.url),
);
export const MAX_THREADS = 4;

// One phone-sized window at its full Retina pixels, 60 fps and a generous
// bitrate ceiling. The "auto" quality lets RemoteBroadcast lower frame rate
// and bitrate when the connection struggles, and climb back when it recovers.
export const APP_STREAM = {
  quality: "auto",
  width: 2560,
  fps: 60,
  bitrate: 16000000,
};

let building = null;
// Built from source on first use and cached under its hash, like the other
// native helpers; any edit to the source recompiles it. Quitting Reach
// (`signal`) stops a build still running, so Ctrl+C never waits for it.
export async function appDisplaysBinary(config, { signal } = {}) {
  const code = await fsp.readFile(helperSource);
  const file = path.join(
    config.dataDir,
    `reach-app-displays-${crypto.createHash("sha256").update(code).digest("hex").slice(0, 12)}`,
  );
  if (fs.existsSync(file)) return file;
  building ??= (async () => {
    const tmp = `${file}-${process.pid}.tmp`;
    try {
      await exec(
        "/usr/bin/xcrun",
        [
          "clang",
          "-fobjc-arc",
          "-O2",
          ...["AppKit", "ApplicationServices", "CoreGraphics", "IOKit"].flatMap(
            (f) => ["-framework", f],
          ),
          helperSource,
          "-o",
          tmp,
        ],
        { timeout: 120000, maxBuffer: 1024 * 1024, signal },
      );
      await fsp.chmod(tmp, 0o700);
      await fsp.rename(tmp, file);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      if (signal?.aborted) throw e;
      throw fail(
        503,
        "Could not prepare the app display helper. Install Apple Command Line Tools.",
      );
    }
  })().finally(() => {
    building = null;
  });
  await building;
  return file;
}

// JSON lines with the helper: numbered requests and replies, plus events.
export class AppDisplaysHelper {
  constructor(child, { onEvent = () => {}, onExit = () => {} } = {}) {
    this.child = child;
    this.next = 0;
    this.pending = new Map();
    this.stopped = false;
    this.onExit = onExit;
    let buffer = "";
    child.stderr?.on("data", () => {});
    child.stdin.on("error", () => this.ended());
    child.on("error", () => this.ended());
    child.on("exit", () => this.ended());
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return this.child.kill("SIGTERM");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.event) {
          onEvent(message);
          continue;
        }
        const request = this.pending.get(message.re);
        if (!request) continue;
        this.pending.delete(message.re);
        clearTimeout(request.timer);
        if (message.error)
          request.reject(
            Object.assign(
              fail(message.code === "accessibility" ? 403 : 409, message.error),
              { code: message.code },
            ),
          );
        else request.resolve(message);
      }
    });
  }
  static async start(config, handlers) {
    const binary = await appDisplaysBinary(config, handlers);
    return new AppDisplaysHelper(
      spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] }),
      handlers,
    );
  }
  request(cmd, payload = {}, timeout = 45000) {
    if (this.stopped)
      return Promise.reject(fail(503, "The app display helper stopped."));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail(504, "The Mac took too long to answer. Try again."));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + "\n");
    });
  }
  ended() {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(fail(503, "The app display helper stopped."));
    }
    this.pending.clear();
    this.onExit();
  }
  // Closing stdin makes the helper give every window back, then exit.
  stop() {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => this.child.kill("SIGKILL"), 10000);
      force.unref();
      this.child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      this.child.stdin.end();
    });
  }
}

// Phone viewports arrive in CSS pixels, which are Mac points at 1:1.
export function phoneViewport(value = {}) {
  const width = Math.round(Number(value.width)),
    height = Math.round(Number(value.height));
  if (
    ![width, height].every((n) => Number.isInteger(n) && n >= 200 && n <= 1000)
  )
    throw fail(400, "Send the phone's screen size in points.");
  // Pixels per point (an iPhone is 3). Older phones pages don't send it.
  const scale =
    value.scale === undefined ? 3 : Math.round(Number(value.scale) * 2) / 2;
  if (!(scale >= 1 && scale <= 4))
    throw fail(400, "Send the phone's pixel density between 1 and 4.");
  return { width, height, scale };
}
// The phone shows the window across its width: more pixels than its screen
// has only cost decoding and drawing time, which the phone pays in lag.
export const streamWidth = (phone) =>
  Math.min(
    APP_STREAM.width,
    phone ? Math.ceil(phone.width * (phone.scale || 3)) : APP_STREAM.width,
  );
const rect = (r) =>
  r && ["x", "y", "w", "h"].every((k) => Number.isFinite(r[k]))
    ? { x: r.x, y: r.y, w: r.w, h: r.h }
    : undefined;
const portrait = (p) => p.height >= p.width;

export class AppThreads {
  constructor({
    file,
    listApps,
    startHelper,
    platform = process.platform,
    onChange = () => {},
  }) {
    Object.assign(this, { file, listApps, startHelper, platform, onChange });
    this.threads = new Map();
    this.minimums = {};
    this.helper = null;
    this.starting = null;
    // Reach paused on the Mac: no app opens; running ones are held.
    this.paused = false;
    // The helper's menu bar item stays while Reach runs (showMenu).
    this.resident = false;
    this.onMenu = () => {};
    // The app in front on the Mac (null once the helper stops telling), and
    // each app opening, as the helper tells them.
    this.onFrontmost = () => {};
    this.onLaunched = () => {};
    this.restartedAt = 0;
    this.stopping = false;
    this.quitting = new AbortController();
    this.load();
  }
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      // Hidden displays never outlive Reach: saved threads come back paused,
      // one tap reopens them. Ones held by a pause still come back on Resume.
      for (const t of Array.isArray(data.threads) ? data.threads : [])
        if (
          typeof t?.id === "string" &&
          typeof t.appId === "string" &&
          typeof t.name === "string"
        ) {
          let phone;
          try {
            if (t.held) phone = phoneViewport(t.phone);
          } catch {}
          this.threads.set(t.id, {
            id: t.id,
            appId: t.appId,
            name: t.name,
            createdAt: t.createdAt,
            state: "paused",
            ...(phone && { held: true, phone }),
          });
        }
      if (data.minimums && typeof data.minimums === "object")
        this.minimums = data.minimums;
    } catch {}
  }
  save() {
    const data = {
      threads: [...this.threads.values()].map(
        ({ id, appId, name, createdAt, held, phone }) => ({
          id,
          appId,
          name,
          createdAt,
          ...(held && { held, phone }),
        }),
      ),
      minimums: this.minimums,
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
  view(t) {
    return {
      id: t.id,
      appId: t.appId,
      name: t.name,
      state: t.state,
      createdAt: t.createdAt,
      ...(t.held && { held: true }),
      ...(t.state === "running" && {
        display: t.display,
        region: t.region,
        size: t.size,
        scale: t.scale,
      }),
    };
  }
  list() {
    return [...this.threads.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((t) => this.view(t));
  }
  get(id) {
    return typeof id === "string" ? this.threads.get(id) : undefined;
  }
  // Hidden displays belong to their threads, not to the Screen picker.
  ownsDisplay(display) {
    for (const t of this.threads.values())
      if (t.display && t.display === String(display)) return true;
    return false;
  }
  async ready() {
    if (this.helper && !this.helper.stopped) return this.helper;
    if (this.stopping) throw fail(503, "Reach is quitting.");
    this.starting ??= this.startHelper({
      onEvent: (event) => this.event(event),
      onExit: () => this.exited(),
      signal: this.quitting.signal,
    })
      .then((helper) => {
        // Up only after Reach began quitting: it gives everything back.
        if (this.stopping) {
          void helper.stop();
          throw fail(503, "Reach is quitting.");
        }
        // A fresh helper shows Reach's menu bar item again.
        if (this.resident) {
          helper.request("state", { paused: this.paused }).catch(() => {});
          if (this.waitingChats?.length) helper.request("waiting", { chats: this.waitingChats }).catch(() => {});
        }
        return helper;
      })
      .finally(() => {
        this.starting = null;
      });
    this.helper = await this.starting;
    return this.helper;
  }
  // Reach's own item in the Mac's menu bar, with Pause or Resume, for as
  // long as Reach runs. Its clicks arrive as `onMenu(paused)`.
  async showMenu() {
    this.resident = true;
    // A helper starting now shows it as soon as it's up (ready).
    const fresh = !this.helper || this.helper.stopped;
    const helper = await this.ready();
    if (!fresh) await helper.request("state", { paused: this.paused });
  }
  // Messages from the phone waiting for their Claude app chat, listed in the
  // menu bar item (a click opens the chat). Shown only with that item.
  waiting(chats) {
    this.waitingChats = chats;
    if (!this.resident || !this.helper || this.helper.stopped) return;
    this.helper.request("waiting", { chats }).catch(() => {});
  }
  pause(t) {
    t.state = "paused";
    delete t.display;
    delete t.region;
    delete t.size;
    delete t.scale;
  }
  event(event) {
    if (event.event === "pause" || event.event === "resume")
      return this.onMenu(event.event === "pause");
    if (event.event === "pointer-guard")
      return console.log(
        "Reach: macOS didn't let Reach watch this Mac's own mouse, so it can get lost on the apps' hidden displays. Allow Terminal in System Settings → Privacy & Security → Accessibility, then restart Reach.",
      );
    if (event.event === "frontmost") return this.onFrontmost(String(event.bundle || ""));
    if (event.event === "launched") return this.onLaunched(String(event.bundle || ""));
    const t = this.get(event.thread);
    if (!t) return;
    if (event.event === "region" && rect(event.region)) {
      t.region = rect(event.region);
      this.onChange(t, "region");
    } else if (event.event === "closed") {
      // Closed from within the app; the phone offers to reopen it.
      t.state = "closed";
      this.onChange(t, "closed");
    } else if (event.event === "released") {
      // "Return all to this Mac" from the Mac's menu bar.
      this.pause(t);
      this.onChange(t, "released");
    } else if (event.event === "quit") {
      // The app quit (from the phone, or on the Mac): its thread ends.
      this.threads.delete(t.id);
      this.save();
      this.onChange(t, "quit");
    }
  }
  exited() {
    this.helper = null;
    this.onFrontmost(null);
    // Held threads stay held: Resume reopens them.
    for (const t of this.threads.values())
      if (t.state !== "paused") {
        this.pause(t);
        this.onChange(t, "released");
      }
    // The menu bar item comes back, unless the helper keeps failing.
    if (
      this.resident &&
      !this.stopping &&
      Date.now() - this.restartedAt > 30000
    ) {
      this.restartedAt = Date.now();
      setTimeout(() => {
        if (!this.stopping) this.ready().catch(() => {});
      }, 2000).unref?.();
    }
  }
  // Pause: every app on the phone goes back to the Mac's own screens, its
  // window kept open as it is, and is held to come back on Resume.
  async hold() {
    this.paused = true;
    if (![...this.threads.values()].some((t) => t.state !== "paused")) return;
    const helper = await this.ready();
    const result = await helper.request("pause");
    for (const id of Array.isArray(result.held) ? result.held : []) {
      const t = this.get(id);
      if (t?.state === "running") {
        this.pause(t);
        t.held = true;
        this.onChange(t, "held");
      } else
        // Its window was already closed on the Mac: nothing to bring back,
        // so the helper lets go of it now ("Open again" still works).
        await helper.request("close", { thread: id }).catch(() => {});
    }
    this.save();
  }
  // Resume: each held app's window goes back to the phone. One closed on the
  // Mac meanwhile opens again, as a fresh tap on it would.
  async resumeAll() {
    this.paused = false;
    const held = [...this.threads.values()].filter((t) => t.held);
    if (!held.length) return;
    const helper = await this.ready();
    // Each stays held (the phone shows it coming back) until it's back.
    for (const t of held) {
      if (this.paused) break;
      if (this.threads.get(t.id) !== t || !t.held) continue;
      try {
        const result = await helper.request("resume", { thread: t.id });
        t.held = false;
        this.started(t, result);
        this.onChange(t, "opened");
      } catch (e) {
        if (e.code === "gone" && t.phone && !this.paused)
          await this.open(t.appId, t.phone).catch(() => {});
        if (t.held) {
          t.held = false;
          this.onChange(t, "failed");
        }
      }
    }
    this.save();
  }
  started(t, result) {
    Object.assign(t, {
      state: "running",
      name: result.app?.name || t.name,
      display: String(result.display),
      region: rect(result.region),
      size: result.size,
      scale: result.scale,
    });
    if (result.minimum?.w > 0) this.minimums[t.appId] = result.minimum;
  }
  async open(appId, viewport) {
    if (this.platform !== "darwin")
      throw fail(501, "Apps on your phone need a Mac for now.");
    if (this.paused) throw fail(423, pausedMessage(this.platform));
    const phone = phoneViewport(viewport);
    const app = (await this.listApps()).find((a) => a.id === appId);
    if (!app) throw fail(404, "Choose an app from this computer’s app list.");
    let t = [...this.threads.values()].find((x) => x.appId === appId);
    if (t?.state === "running") {
      if (portrait(t.phone) !== portrait(phone)) await this.rotate(t.id, phone);
      return this.view(t);
    }
    if (t?.state === "starting") throw fail(409, `${t.name} is still opening.`);
    if (t?.state === "closed") await this.release(t);
    if (!t) {
      if (this.threads.size >= MAX_THREADS) {
        // Make room by forgetting the oldest paused thread.
        const oldest = [...this.threads.values()]
          .filter((x) => x.state === "paused")
          .sort((a, b) =>
            String(a.createdAt).localeCompare(String(b.createdAt)),
          )[0];
        if (!oldest)
          throw fail(
            409,
            "Four apps are already open on your phone. Close one first.",
          );
        this.threads.delete(oldest.id);
      }
      t = {
        id: crypto.randomUUID(),
        appId,
        name: app.name,
        createdAt: new Date().toISOString(),
        state: "paused",
      };
      this.threads.set(t.id, t);
    }
    t.state = "starting";
    t.held = false;
    this.onChange(t, "starting");
    try {
      const helper = await this.ready();
      // Paused while the helper started: nothing moves off the Mac's screen.
      if (this.paused) throw fail(423, pausedMessage(this.platform));
      const result = await helper.request("open", {
        thread: t.id,
        path: app.id,
        phone: { w: phone.width, h: phone.height },
        ...(this.minimums[appId] && { minimum: this.minimums[appId] }),
      });
      this.started(t, result);
      t.phone = phone;
      this.save();
      this.onChange(t, "opened");
      return this.view(t);
    } catch (e) {
      this.pause(t);
      this.save();
      this.onChange(t, "failed");
      throw e;
    }
  }
  running(id) {
    const t = this.get(id);
    if (!t) throw fail(404, "That app isn't open on your phone.");
    if (t.state !== "running")
      throw fail(409, `${t.name} isn't running on your phone. Open it again.`);
    return t;
  }
  async rotate(id, viewport) {
    const t = this.running(id);
    const phone = phoneViewport(viewport);
    const result = await (
      await this.ready()
    ).request("rotate", {
      thread: t.id,
      phone: { w: phone.width, h: phone.height },
    });
    t.phone = phone;
    t.region = rect(result.region) || t.region;
    this.onChange(t, "region");
    return this.view(t);
  }
  async activate(id) {
    const t = this.running(id);
    await (await this.ready()).request("activate", { thread: t.id });
    return this.view(t);
  }
  // Quit the app like ⌘Q. `confirm` is needed when it also has windows on
  // the Mac's own screens; until then the reply says how many.
  async quit(id, confirm = false) {
    const t = this.get(id);
    if (!t) throw fail(404, "That app isn't open on your phone.");
    if (t.state === "starting") throw fail(409, `${t.name} is still opening.`);
    if (t.state === "paused") {
      this.threads.delete(id);
      this.save();
      this.onChange(t, "removed");
      return { quit: false, removed: true };
    }
    const result = await (
      await this.ready()
    ).request("quit", { thread: t.id, confirm: confirm === true }, 15000);
    if (result.confirm) return { confirm: true, others: result.others };
    if (result.quit && this.threads.get(id) === t) {
      this.threads.delete(id);
      this.save();
      this.onChange(t, "quit");
    }
    // Still running: it is asking something (unsaved changes) on its display.
    return result.quit ? { quit: true } : { quit: false, waiting: true };
  }
  // Text fields in the window, in points from its top-left, so a tap on one
  // opens the phone's keyboard right away.
  async fields(id) {
    const t = this.running(id);
    const result = await (
      await this.ready()
    ).request("fields", { thread: t.id }, 3000);
    const fields = (Array.isArray(result.fields) ? result.fields : [])
      .filter((f) => rect(f))
      .map((f) => ({ ...rect(f), secure: f.secure === true }));
    return { fields, complete: result.complete === true };
  }
  async release(t) {
    if (t.state === "paused") return { closed: false, returned: false };
    const result = this.helper
      ? await this.helper.request("close", { thread: t.id })
      : { closed: false, returned: false };
    this.pause(t);
    return result;
  }
  async close(id) {
    const t = this.get(id);
    if (!t) throw fail(404, "That app isn't open on your phone.");
    if (t.state === "starting") throw fail(409, `${t.name} is still opening.`);
    const result = await this.release(t);
    this.threads.delete(id);
    this.save();
    this.onChange(t, "removed");
    return { closed: !!result.closed, returned: !!result.returned };
  }
  async closeAll() {
    for (const t of [...this.threads.values()])
      if (t.state !== "paused") {
        await this.release(t).catch(() => this.pause(t));
        this.onChange(t, "released");
      }
  }
  async shutdown() {
    this.stopping = true;
    this.quitting.abort();
    await this.helper?.stop();
  }
}

// Video for app threads: the live screen's broadcast, cropped to the app's
// window on its hidden display, with no pointer drawn.
export class AppScreenHub {
  constructor(threads, prepare) {
    this.threads = threads;
    this.prepare = prepare;
    this.groups = new Map();
    this.viewers = new Map();
  }
  async add(ws, authorize, message) {
    if (this.viewers.size >= 4)
      throw fail(429, "Four app streams are already connected.");
    const t = this.threads.running(message.thread);
    const format = message.format === "jpeg" ? "jpeg" : "h264";
    const options = {
      ...APP_STREAM,
      width: Math.min(
        streamWidth(t.phone),
        Number.isInteger(message.maxWidth) && message.maxWidth >= 640
          ? message.maxWidth
          : Infinity,
      ),
      display: t.display,
      format,
      region: t.region,
      ...(format === "jpeg" && { fps: 20 }),
    };
    const key = JSON.stringify([
      t.id,
      t.display,
      t.region,
      format,
      options.width,
    ]);
    let group = this.groups.get(key);
    if (!group) {
      group = new RemoteBroadcast(
        () => this.prepare(options),
        options,
        () => this.groups.delete(key),
      );
      group.thread = t.id;
      this.groups.set(key, group);
    }
    this.viewers.set(ws, group);
    ws.send(JSON.stringify({ type: "ready", protocol: 2, ...options }));
    group.add(ws, authorize);
  }
  ack(ws, id, keyframe = false) {
    const group = this.viewers.get(ws);
    group?.ack(ws, id);
    if (keyframe && group?.viewers.get(ws)) group.viewers.get(ws).key = true;
  }
  owns(ws) {
    return this.viewers.has(ws);
  }
  remove(ws) {
    this.viewers.get(ws)?.remove(ws);
    this.viewers.delete(ws);
  }
  // The window moved, the phone rotated, or the app closed: viewers reconnect
  // (retryable) and get a fresh crop, or are told the app is gone.
  end(threadId, message, retryable) {
    for (const [ws, group] of [...this.viewers])
      if (!threadId || group.thread === threadId) {
        group.fail(ws, message, retryable);
        this.viewers.delete(ws);
      }
  }
  stop(message = "Screen viewing is off.", retryable = false) {
    this.end(null, message, retryable);
  }
}

// The live screen's capture helper, cropped to the window and without the
// pointer (see scripts/native/screen-stream.swift).
export async function appScreenSource(config, options) {
  const binary = await desktopBinary(config, "screen-stream");
  const { x, y, w, h } = options.region;
  return () =>
    new NativeScreenSource(binary, [
      options.display,
      options.format,
      String(options.fps),
      String(options.width),
      String(options.bitrate),
      "auto",
      [x, y, w, h].join(","),
    ]);
}
