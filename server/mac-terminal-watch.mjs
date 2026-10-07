import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import crypto from "node:crypto";
import { desktopBinary } from "./desktop-native.mjs";
import { fail } from "./core.mjs";

// The Mac's Terminal and iTerm2 windows, kept current by events instead of
// the phone asking every few seconds. A small helper reports new and closed
// tabs and each tab's output (scripts/native/terminal-watch.swift); only then
// is the slow AppleScript list or read run, and the phone is told through
// its live connection. Nothing runs while the terminals are idle.
export function terminalWatchHelper(config) {
  return async () => {
    const binary = await desktopBinary(config, "terminal-watch");
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    const helper = new EventEmitter();
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        helper.emit("event", JSON.parse(line));
      } catch {}
    });
    child.on("exit", () => helper.emit("exit"));
    child.on("error", () => helper.emit("exit"));
    child.stdin.on("error", () => {});
    helper.send = (message) => {
      if (child.stdin.writable)
        child.stdin.write(JSON.stringify(message) + "\n");
    };
    helper.stop = () => child.stdin.end();
    return helper;
  };
}

// Spinner glyphs agents animate in their titles (✳ ✻ · ⠂) don't count as a
// change: symbols anywhere, and anything before each part's first word.
const restless = /[\p{So}\p{Co}]/gu;
const steady = (name) =>
  String(name)
    .split(/\s+—\s+/)
    .map((part) => part.replace(restless, "").replace(/^[^\p{L}\p{N}]+/u, ""))
    .join(" — ");
const digest = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 12);

export class MacTerminalWatch {
  constructor({
    terminals,
    start,
    onChange = () => {},
    // Stay ready this long after the last phone leaves.
    linger = 30000,
    // Output may rename a tab (titles, commands starting): look again, at
    // most this often while something prints.
    renameCheck = 5000,
    // A safety look at the list while phones are connected.
    safety = 60000,
    // An open tab is read at most this often while it prints; other tabs,
    // for their last line on Home, at most every `peekGap`.
    readGap = 300,
    peekGap = 2000,
    // A phone waiting for new text hears back within this time regardless.
    wait = 20000,
  }) {
    Object.assign(this, { terminals, start, onChange });
    Object.assign(this, {
      linger,
      renameCheck,
      safety,
      readGap,
      peekGap,
      wait,
    });
  }
  users = 0;
  helper = null;
  snapshot = null;
  version = "";
  tabs = new Map();
  timers = {};
  // Each tab's last line, for Home; `activity` counts their changes.
  peeks = new Map();
  activity = 0;
  activityWaiters = new Set();
  peeksWatchedUntil = 0;
  get ready() {
    return !!(this.helper && this.snapshot);
  }
  // Each connected phone that may see Mac terminals keeps the watch running.
  retain() {
    this.users++;
    clearTimeout(this.timers.linger);
    if (!this.helper && !this.starting) this.starting = this.begin();
  }
  release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users) return;
    clearTimeout(this.timers.linger);
    this.timers.linger = setTimeout(() => this.end(), this.linger);
    this.timers.linger.unref?.();
  }
  async begin() {
    try {
      const helper = await this.start();
      if (!this.users) return helper.stop();
      this.helper = helper;
      helper.on("event", (event) => this.event(event));
      helper.on("exit", () => {
        if (this.helper !== helper) return;
        // Back to asking, until the next phone connects.
        this.end();
      });
      await this.refresh();
      this.timers.safety = setInterval(() => void this.refresh(), this.safety);
      this.timers.safety.unref?.();
    } catch {
      // No helper (no Command Line Tools): phones keep asking as before.
    } finally {
      this.starting = null;
    }
  }
  end() {
    for (const timer of Object.values(this.timers)) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = {};
    const helper = this.helper;
    this.helper = null;
    helper?.stop();
    this.snapshot = null;
    for (const tab of this.tabs.values()) for (const w of tab.waiters) w.done();
    this.tabs.clear();
    this.peeks.clear();
    for (const w of this.activityWaiters) w();
    if (this.version) {
      this.version = "";
      this.onChange();
    }
  }
  event(event) {
    if (["opened", "closed", "app"].includes(event.type)) this.soon(250);
    else if (event.type === "output") {
      const now = Date.now();
      for (const [id, tab] of this.tabs) {
        if (tab.tty !== event.tty) continue;
        if (tab.waiters.size || tab.watchedUntil > now) void this.read(id);
        else if (this.peeksWatchedUntil > now) void this.read(id, this.peekGap);
      }
      if (!this.timers.rename) {
        this.timers.rename = setTimeout(() => {
          delete this.timers.rename;
          void this.refresh();
        }, this.renameCheck);
        this.timers.rename.unref?.();
      }
    }
  }
  soon(delay) {
    clearTimeout(this.timers.soon);
    this.timers.soon = setTimeout(() => {
      delete this.timers.soon;
      void this.refresh();
    }, delay);
    this.timers.soon.unref?.();
  }
  refresh() {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        const result = await this.terminals.list(() => {}, {
          background: true,
        });
        if (!this.helper) return;
        this.snapshot = result;
        const listed = new Set();
        for (const s of result.sessions) {
          listed.add(s.id);
          const tab = this.tabs.get(s.id);
          if (tab) tab.tty = s.tty;
          else
            this.tabs.set(s.id, {
              tty: s.tty,
              text: undefined,
              version: 0,
              readAt: 0,
              watchedUntil: 0,
              waiters: new Set(),
            });
        }
        for (const [id, tab] of this.tabs)
          if (!listed.has(id)) {
            this.tabs.delete(id);
            if (this.peeks.delete(id)) this.touched();
            for (const w of tab.waiters) w.gone();
          }
        // Only listed tabs are watched; a closed tab's tty is let go.
        this.helper.send({
          ttys: [...new Set(result.sessions.map((s) => s.tty).filter(Boolean))],
        });
        const version = digest([
          result.sessions.map((s) => [s.id, steady(s.name)]),
          result.providers.map((p) => [p.id, !!p.running, p.error || ""]),
        ]);
        if (version !== this.version) {
          this.version = version;
          this.onChange();
        }
      } catch {
        // Kept as last seen; the next event or safety look tries again.
      } finally {
        this.refreshing = null;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      }
    })();
    return this.refreshing;
  }
  list(authorize) {
    authorize();
    return this.snapshot;
  }
  // The tab's text once it differs from `after` (the version the phone has),
  // or `{version, unchanged}` when nothing printed for a while.
  async text(id, after, authorize, signal) {
    authorize();
    const tab = this.tabs.get(id);
    if (!tab) throw fail(404, "This terminal has closed. Refresh the list.");
    tab.watchedUntil = Date.now() + 60000;
    if (!tab.version) await this.read(id);
    authorize();
    // A first read that failed (a permission prompt, a busy app) says why.
    if (!tab.version && tab.error) throw tab.error;
    if (!this.tabs.has(id))
      throw fail(404, "This terminal has closed. Refresh the list.");
    if (tab.version !== after) return { text: tab.text, version: tab.version };
    const result = await new Promise((resolve, reject) => {
      const waiter = {
        done: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", waiter.done);
          tab.waiters.delete(waiter);
          resolve(
            tab.version !== after
              ? { text: tab.text, version: tab.version }
              : { version: tab.version, unchanged: true },
          );
        },
        gone: () => {
          clearTimeout(timer);
          tab.waiters.delete(waiter);
          reject(fail(404, "This terminal has closed. Refresh the list."));
        },
      };
      const timer = setTimeout(waiter.done, this.wait);
      signal?.addEventListener("abort", waiter.done);
      tab.waiters.add(waiter);
    });
    authorize();
    return result;
  }
  // One read at a time per tab; output during a read earns one more after it.
  read(id, every = this.readGap) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.every = Math.min(tab.every ?? Infinity, every);
    if (tab.reading) {
      tab.dirty = true;
      return tab.reading;
    }
    tab.reading = (async () => {
      try {
        const gap = tab.readAt + tab.every - Date.now();
        tab.every = undefined;
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        tab.readAt = Date.now();
        // A phone viewing the tab scrolls back through it; a Home peek
        // needs only the screen.
        const viewed = tab.waiters.size > 0 || tab.watchedUntil > Date.now();
        const { text } = await this.terminals.action(
          id,
          "read",
          viewed ? { scrollback: true } : null,
          () => {},
          {
            background: true,
          },
        );
        tab.error = null;
        if (!tab.version || text !== tab.text) {
          tab.text = text;
          tab.version++;
          for (const w of [...tab.waiters]) w.done();
        }
        const line =
          String(text)
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => /[\p{L}\p{N}]/u.test(l))
            .pop() || "";
        if (this.tabs.get(id) === tab && this.peeks.get(id) !== line) {
          this.peeks.set(id, line);
          this.touched();
        }
      } catch (e) {
        tab.error = e;
        if (e.status === 404) this.soon(0);
      } finally {
        tab.reading = null;
        if (tab.dirty && this.tabs.get(id) === tab) {
          tab.dirty = false;
          void this.read(id, tab.every ?? this.readGap);
        }
      }
    })();
    return tab.reading;
  }
  touched() {
    this.activity++;
    for (const w of [...this.activityWaiters]) w();
  }
  // Every tab's last line once any differs from version `after`; tabs are
  // read only after they print, so Home costs nothing while they're idle.
  async peekAll(after, authorize, signal) {
    authorize();
    this.peeksWatchedUntil = Date.now() + 60000;
    // First look: every tab once.
    await Promise.all(
      [...this.tabs.keys()]
        .filter((id) => !this.peeks.has(id))
        .map((id) => this.read(id, 0)),
    );
    if (this.activity === after) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          this.activityWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, this.wait);
        signal?.addEventListener("abort", done);
        this.activityWaiters.add(done);
      });
    }
    authorize();
    return { version: this.activity, peeks: Object.fromEntries(this.peeks) };
  }
}
