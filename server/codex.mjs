import { findCodexExecutable } from "./capabilities.mjs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { atomicJson, loadJson, fail, id } from "./core.mjs";
export class Codex {
  pending = new Map();
  seq = 0;
  child = null;
  ready = null;
  loaded = new Set();
  constructor(config) {
    this.config = config;
    this.file = path.join(config.dataDir, "chats.json");
    this.chats = loadJson(this.file, []);
    for (const c of this.chats) {
      c.status = "idle";
      c.approvals = [];
    }
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => atomicJson(this.file, this.chats), 150);
    this.timer.unref();
  }
  list() {
    return this.chats
      .map(({ items, approvals, ...rest }) => ({
        ...rest,
        approvalsCount: approvals.length,
      }))
      .reverse();
  }
  get(threadId) {
    const c = this.chats.find((c) => c.id === threadId);
    if (!c) throw fail(404, "Chat not found.");
    return c;
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.boot().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  async boot() {
    const executable = await findCodexExecutable();
    if (!executable)
      throw fail(503, "Install Codex CLI and sign in on this computer.");
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const rejectAll = (message) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(fail(503, message));
      }
      this.pending.clear();
      this.child = null;
      this.ready = null;
      this.loaded.clear();
      for (const c of this.chats) {
        if (c.status === "running") c.status = "interrupted";
        c.approvals = [];
      }
      this.save();
    };
    child.on("error", () =>
      rejectAll(
        "Codex could not start. Install Codex CLI and sign in on this computer.",
      ),
    );
    child.on("exit", () =>
      rejectAll("Codex stopped. Send a new message to reconnect."),
    );
    child.stderr.on("data", () => {});
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch {}
    });
    await this.rpc("initialize", {
      clientInfo: { name: "reach", title: "Reach", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized" });
  }
  send(message) {
    if (!this.child?.stdin.writable) throw fail(503, "Codex is not connected.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          fail(
            504,
            "Codex took too long to respond. Check the computer and try again.",
          ),
        );
      }, 30000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({ id: requestId, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }
  receive(message) {
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(message.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(message.id);
        message.error
          ? p.reject(
              fail(502, message.error.message || "Codex returned an error."),
            )
          : p.resolve(message.result);
      }
      return;
    }
    const p = message.params || {};
    const c = this.chats.find((c) => c.id === p.threadId);
    if (!c) {
      if (message.id !== undefined)
        this.send({
          id: message.id,
          error: { code: -32601, message: "Unsupported request" },
        });
      return;
    }
    if (message.id !== undefined) {
      const supported = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
      ];
      if (supported.includes(message.method)) {
        c.approvals.push({ id: message.id, method: message.method, params: p });
        c.status = "waiting";
      } else {
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message:
              "Reach does not support this approval type. No permission granted.",
          },
        });
        c.error = "Codex requested a feature this client does not support.";
      }
    } else if (message.method === "item/agentMessage/delta") {
      let item = c.items.find((i) => i.id === p.itemId);
      if (!item) {
        item = { id: p.itemId, type: "agentMessage", text: "" };
        c.items.push(item);
      }
      item.text = (item.text || "") + p.delta;
    } else if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      const item = p.item;
      if (item) {
        const i = c.items.findIndex((x) => x.id === item.id);
        if (i < 0) c.items.push(item);
        else c.items[i] = item;
      }
    } else if (message.method === "turn/started") {
      c.status = "running";
      c.turnId = p.turn?.id;
    } else if (message.method === "turn/completed") {
      c.status = p.turn?.status === "failed" ? "error" : "idle";
      c.error = p.turn?.error?.message || null;
      c.approvals = [];
    } else if (message.method === "error") {
      c.error = p.error?.message || "Codex encountered an error.";
    }
    c.updatedAt = new Date().toISOString();
    if (c.items.length > 1000) c.items = c.items.slice(-1000);
    this.save();
  }
  async status() {
    await this.start();
    const r = await this.rpc("account/read", { refreshToken: false });
    return {
      available: true,
      signedIn: !!r.account,
      accountType: r.account?.type,
    };
  }
  async create(cwd, name, clientId) {
    await this.start();
    const r = await this.rpc("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceName: "reach",
    });
    const c = {
      id: r.thread.id,
      clientId,
      name: String(name || "New conversation").slice(0, 80),
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
      items: [],
      approvals: [],
    };
    this.chats.push(c);
    this.loaded.add(c.id);
    this.save();
    return c;
  }
  async message(threadId, text) {
    const c = this.get(threadId);
    if (["running", "waiting", "starting"].includes(c.status))
      throw fail(409, "Wait for this turn to finish, or stop it first.");
    if (typeof text !== "string" || !text.trim() || text.length > 50000)
      throw fail(400, "Enter a message of up to 50,000 characters.");
    c.status = "starting";
    c.error = null;
    try {
      await this.start();
      if (!this.loaded.has(threadId)) {
        await this.rpc("thread/resume", {
          threadId,
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        });
        this.loaded.add(threadId);
      }
      const r = await this.rpc("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      c.turnId = r.turn.id;
      if (c.status === "starting") c.status = "running";
      this.save();
      return c;
    } catch (e) {
      c.status = "error";
      c.error = e.message;
      this.save();
      throw e;
    }
  }
  async stop(threadId) {
    const c = this.get(threadId);
    if (c.turnId)
      await this.rpc("turn/interrupt", { threadId, turnId: c.turnId });
    c.status = "idle";
    c.approvals = [];
    this.save();
  }
  respond(threadId, requestId, body) {
    const c = this.get(threadId);
    const a = c.approvals.find((a) => String(a.id) === String(requestId));
    if (!a) throw fail(404, "This request is no longer pending.");
    let result;
    if (a.method === "item/tool/requestUserInput") {
      result = { answers: {} };
      for (const q of a.params.questions || []) {
        const answer = body.answers?.[q.id];
        if (typeof answer !== "string" || !answer.trim())
          throw fail(400, "Answer each question.");
        result.answers[q.id] = { answers: [answer.slice(0, 10000)] };
      }
    } else {
      if (!["accept", "decline"].includes(body.decision))
        throw fail(400, "Choose Allow or Deny.");
      result = { decision: body.decision };
    }
    this.send({ id: a.id, result });
    c.approvals = c.approvals.filter((x) => x !== a);
    c.status = c.approvals.length ? "waiting" : "running";
    this.save();
  }
  dispose() {
    clearTimeout(this.timer);
    atomicJson(this.file, this.chats);
    this.child?.kill();
  }
}
