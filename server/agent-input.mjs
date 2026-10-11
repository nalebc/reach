// The agent-only input helper (scripts/native/agent-input.swift): acts inside
// one app through Accessibility, without the Mac's pointer or keyboard, so a
// person can use the Mac at the same time. JSON lines, one reply per request.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { desktopBinary } from "./desktop-native.mjs";

export class AgentInputHelper {
  static async start(config) {
    const binary = await desktopBinary(config, "agent-input");
    return new AgentInputHelper(
      spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] }),
    );
  }
  constructor(child, { timeoutMs = 5000 } = {}) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.next = 0;
    this.stopped = false;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      this.pending.delete(reply.id);
      clearTimeout(waiting.timer);
      const { id, ...rest } = reply;
      waiting.resolve(rest);
    });
    child.stdin.on("error", () => this.stop());
    child.on("error", () => this.stop());
    child.on("exit", () => this.stop());
  }
  // A reply. A request sent but not answered (in time, or before the helper
  // ended) may still land: { done: false, unknown: true }, never a plain
  // "not done" that the server would retry with the pointer.
  send(request, timeoutMs = this.timeoutMs) {
    if (this.stopped)
      return Promise.resolve({ done: false, why: "input helper stopped" });
    const id = ++this.next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ done: false, unknown: true, why: "no answer from the app" });
        // Still busy with it: what's queued behind would land late. A fresh
        // helper starts on the next action.
        this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(JSON.stringify({ id, ...request }) + "\n");
    });
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ done: false, unknown: true, why: "input helper stopped" });
    }
    this.pending.clear();
    this.child.stdin.destroy();
    // SIGTERM lets the helper release a key it holds; a helper stuck in a
    // call doesn't get to run more than a second longer.
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    force.unref?.();
    child.once("exit", () => clearTimeout(force));
  }
}
