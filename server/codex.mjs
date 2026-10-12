import { object, readOnlyRpc, validateCodexResult, uncertainDelivery } from "./agent-sessions/compatibility.mjs";
import { describePrompt, answerFor } from "./agent-sessions/codex-live.mjs";
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
      if (this.child !== child) return;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(readOnlyRpc(p.method) ? fail(503, message) : uncertainDelivery("codex"));
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
      rejectAll("Codex disconnected. Check the conversation before sending again."),
    );
    child.stdin.on("error", () => rejectAll("Codex input disconnected. Check the conversation before sending again."));
    child.stderr.on("data", () => {});
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child !== child) return;
      try { this.receive(JSON.parse(line)); }
      catch { rejectAll("Codex returned an incompatible response. Use the screen or terminal."); child.kill(); }
    });
    await this.rpc("initialize", {
      clientInfo: { name: "reach", title: "Reach", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized" });
  }
  send(message, callback) {
    if (!this.child?.stdin.writable) throw fail(503, "Codex is not connected.");
    this.child.stdin.write(JSON.stringify(message) + "\n", callback);
  }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(readOnlyRpc(method) ? fail(504, "Codex did not answer the read request.") : uncertainDelivery("codex"));
      }, 30000);
      this.pending.set(requestId, { resolve, reject, timer, method });
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
    if (!object(message)) throw Error("Unsupported Codex message.");
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(message.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(message.id);
        message.error
          ? p.reject(
              fail(502, message.error.message || "Codex returned an error."),
            )
          : (() => { try { p.resolve(validateCodexResult(p.method, message.result)); } catch (error) { p.reject(error); } })();
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
        let prompt;
        try { prompt = describePrompt(message.method, p); }
        catch { this.send({ id: message.id, error: { code: -32602, message: "Unsupported approval shape." } }); return; }
        c.approvals.push({ id: message.id, method: message.method, params: p, prompt });
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
      if (typeof p.delta !== "string") throw Error("Invalid Codex text delta.");
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
      if (c.turnId && p.turn?.id !== c.turnId) return;
      // Only a known end finishes the turn; an unknown status keeps it.
      if (!["completed", "interrupted", "failed"].includes(p.turn?.status)) return;
      c.status = p.turn.status === "failed" ? "error" : "idle";
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
  async respond(threadId, requestId, body) {
    const c = this.get(threadId);
    const a = c.approvals.find((a) => String(a.id) === String(requestId));
    if (!a) throw fail(404, "This request is no longer pending.");
    if (a.attempted) throw fail(409, "This answer was already attempted. Check Codex.");
    const answer = a.method === "item/tool/requestUserInput"
      ? { answers: Object.fromEntries(Object.entries(body.answers || {}).map(([id, value]) => [id, [value]])) }
      : body;
    const result = answerFor(a.prompt || describePrompt(a.method, a.params), answer);
    a.attempted = true;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(uncertainDelivery("codex")), 30000);
      try { this.send({ id: a.id, result }, error => {
        clearTimeout(timer); error ? reject(uncertainDelivery("codex")) : resolve();
      }); } catch { clearTimeout(timer); reject(uncertainDelivery("codex")); }
    });
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
