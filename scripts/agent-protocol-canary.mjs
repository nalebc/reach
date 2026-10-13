// Account-free protocol checks. Never submit a user turn or answer an approval.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export function checkCodexSchemas(schemas) {
  const required = {
    "v2/ThreadQueueAddResponse.json": { queuedSubmission: null },
    "v2/ThreadQueueDeleteResponse.json": { deleted: "boolean" },
    "v2/TurnStartResponse.json": { turn: null },
    "v2/TurnSteerResponse.json": { turnId: "string" },
    "v2/ThreadTurnsListResponse.json": { data: "array" },
    "ToolRequestUserInputParams.json": { questions: "array" },
    "CommandExecutionRequestApprovalParams.json": { threadId: "string" },
  };
  for (const [file, fields] of Object.entries(required)) {
    const schema = schemas[file];
    for (const [field, type] of Object.entries(fields))
      if (!schema?.required?.includes(field) || !schema.properties?.[field] || (type && schema.properties[field].type !== type))
        throw Error(`Protocol contract changed: ${file} (${field}).`);
  }
}
export async function protocolCanary(agent, executable) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-protocol-"));
  try {
    if (agent === "codex") {
      await exec(executable, ["app-server", "generate-json-schema", "--experimental", "--out", dir], { timeout: 30000, maxBuffer: 1024 * 1024 });
      const files = ["v2/ThreadQueueAddResponse.json", "v2/ThreadQueueDeleteResponse.json", "v2/TurnStartResponse.json", "v2/TurnSteerResponse.json", "v2/ThreadTurnsListResponse.json", "ToolRequestUserInputParams.json", "CommandExecutionRequestApprovalParams.json"];
      const schemas = Object.fromEntries(await Promise.all(files.map(async f => [f, JSON.parse(await fs.readFile(path.join(dir, f), "utf8"))])));
      checkCodexSchemas(schemas);
      return { schema: "passed", contracts: files.length, modelTurns: 0 };
    }
    return await new Promise((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|REACH_)/.test(key)));
      const child = spawn(executable, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompts", "host"], {
        cwd: dir, env: { ...env, CLAUDE_CONFIG_DIR: dir, CI: "1" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let done = false, buffer = "";
      let said = "";
      const finish = (error) => {
        if (done) return; done = true; clearTimeout(timer);
        child.stdin.destroy(); child.kill();
        // What Claude Code itself said, so a failure in CI names its cause.
        const tail = said.replace(/\s+/g, " ").trim().slice(-300);
        error ? reject(Error(`${error}${tail ? ` It said: ${tail}` : ""}`)) : resolve({ initialize: "passed", modelTurns: 0 });
      };
      // A first start on a fresh runner takes longer than a laptop's.
      const timer = setTimeout(() => finish("Claude initialization timed out."), 45000);
      child.on("error", () => finish("Claude could not initialize."));
      child.on("exit", () => finish("Claude exited without an initialization acknowledgement."));
      child.stdin.on("error", () => finish("Claude initialization transport failed."));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { said = (said + chunk).slice(-4000); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) return finish("Claude initialization exceeded its size limit.");
        for (let i; (i = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { return finish("Claude emitted an invalid protocol message."); }
          if (m?.type !== "control_response" || m.response?.request_id !== "reach-canary") continue;
          const r = m.response;
          if (r.subtype !== "success" || !r.response || !Array.isArray(r.response.models) || !Array.isArray(r.response.commands))
            return finish("Claude initialization contract changed.");
          finish();
        }
      });
      child.stdin.write(JSON.stringify({ type: "control_request", request_id: "reach-canary", request: { subtype: "initialize" } }) + "\n");
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
