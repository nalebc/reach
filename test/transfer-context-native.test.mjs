// Opt in with REACH_TEST_CODEX_BINARY. Runs the installed native harness against
// a local mock Responses endpoint; no account or real model inference is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { codexArchive } from "../server/agent-sessions/portable-history.mjs";

test("native Codex loads bounded context and preserves the full imported transcript", {
  skip: !process.env.REACH_TEST_CODEX_BINARY,
  timeout: 30_000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-transfer-native-"));
  let child, lines;
  const pending = new Map();
  let captured;
  const input = new Promise(resolve => { captured = resolve; });
  const endpoint = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url?.includes("/responses")) captured(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Fixture stops before inference", type: "invalid_request_error" } }));
  });
  t.after(async () => {
    if (child) {
      const exited = new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", resolve); });
      child.kill(); lines?.close();
      for (const p of pending.values()) clearTimeout(p.timer);
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(force);
    }
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise(resolve => endpoint.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { endpoint.once("error", reject); endpoint.listen(0, "127.0.0.1", resolve); });
  const home = path.join(dir, "codex-home");
  await fs.mkdir(home);
  const baseURL = `http://127.0.0.1:${endpoint.address().port}/v1`;
  await fs.writeFile(path.join(home, "config.toml"), `model = "gpt-6.1-sol"\nmodel_provider = "transfer_fixture"\n[model_providers.transfer_fixture]\nname = "Transfer fixture"\nbase_url = "${baseURL}"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const file = path.join(dir, "history.jsonl");
  const huge = "Old answer " + "x".repeat(600_000);
  const archive = codexArchive({ cwd: dir, items: [{ role: "user", kind: "text", text: "Original task" }, { role: "assistant", kind: "text", text: huge }, { role: "user", kind: "text", text: "Latest task" }], from: "Claude Code", context: { items: [{ role: "user", kind: "text", text: "Latest task" }], summary: "The original work is done. Next step: Windows." }, archivePath: file });
  await fs.writeFile(file, archive.lines.map(JSON.stringify).join("\n") + "\n");
  child = spawn(process.env.REACH_TEST_CODEX_BINARY, ["app-server"], { cwd: dir, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  lines = readline.createInterface({ input: child.stdout });
  child.stderr.resume();
  let next = 1;
  child.on("error", error => { for (const p of pending.values()) p.reject(error); });
  child.on("exit", () => { for (const p of pending.values()) p.reject(new Error("Native app-server exited")); });
  lines.on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  await rpc("initialize", { clientInfo: { name: "reach-transfer-native", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const fork = await rpc("thread/fork", { threadId: archive.id, path: file, cwd: dir, excludeTurns: true, modelProvider: "transfer_fixture" });
  const read = await rpc("thread/read", { threadId: fork.thread.id, includeTurns: true });
  assert.ok(read.thread.turns.some(t => t.items?.some(i => i.type === "agentMessage" && i.text === huge)), "the entire old answer remains readable");
  await rpc("turn/start", { threadId: fork.thread.id, input: [{ type: "text", text: "Continue" }] });
  let timer;
  const request = await Promise.race([input, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No local inference request")), 15_000); })]).finally(() => clearTimeout(timer));
  const modelContext = JSON.stringify(request.input);
  assert.ok(modelContext.length < 200_000, `bounded request: ${modelContext.length}`);
  assert.match(modelContext, /The original work is done\. Next step: Windows\./);
  assert.match(modelContext, /Latest task/);
  assert.match(modelContext, /Original task/);
  assert.ok(!modelContext.includes("x".repeat(1000)), "pre-compaction history is excluded from inference");
});
