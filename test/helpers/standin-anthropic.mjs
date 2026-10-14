// A stand-in for Anthropic's Messages API, for running the real Claude Code
// against it with no account (ANTHROPIC_BASE_URL to this server, a dummy
// key). Each prompt the test types names a script: the tool calls Claude is
// to make for it, one per reply, then "done". Every request is kept, so a
// test can read what Claude Code sent back (a tool's result, a denial and its
// reason). Answers stream as the real API does (server-sent events), each
// message with its own id: Claude Code drops a reply whose id it has seen.
import crypto from "node:crypto";
import http from "node:http";

const textOf = (message) =>
  typeof message?.content === "string"
    ? [message.content]
    : Array.isArray(message?.content)
      ? message.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text)
      : [];
const resultsOf = (message) => (Array.isArray(message?.content) ? message.content.filter((b) => b?.type === "tool_result") : []);
// A tool result's words, whichever shape Claude Code gave them.
export const resultText = (result) =>
  typeof result?.content === "string"
    ? result.content
    : Array.isArray(result?.content)
      ? result.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : "";

// script: { "<words in the prompt>": [{ name, input }, ...] }, matched
// case-insensitively against the newest prompt that names one.
export async function startStandIn(script) {
  const requests = [];
  const keys = Object.keys(script).map((key) => [key, key.toLowerCase()]);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {}
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    // The newest prompt naming a script, and the results Claude Code sent since.
    let at = -1;
    let key = null;
    messages.forEach((m, i) => {
      if (m?.role !== "user") return;
      const words = textOf(m).join("\n").toLowerCase();
      const found = keys.find(([, lower]) => words.includes(lower));
      if (found) [at, key] = [i, found[0]];
    });
    const results = at < 0 ? [] : messages.slice(at + 1).flatMap(resultsOf);
    const tools = Array.isArray(body?.tools) ? body.tools.map((t) => t?.name).filter(Boolean) : [];
    requests.push({ url: req.url, model: body?.model, key, results: results.map((r) => ({ id: r.tool_use_id, error: !!r.is_error, text: resultText(r) })), tools, at: Date.now() });
    if (req.method !== "POST" || !String(req.url).startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Not here." } }));
    }
    if (String(req.url).includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    // Only the conversation itself (it has tools) gets the script; Claude
    // Code's side requests (a title, a topic) get a word.
    const calls = key && tools.length ? script[key] : [];
    const next = calls[results.length];
    const blocks = next
      ? [{ type: "tool_use", id: `toolu_${crypto.randomBytes(10).toString("hex")}`, name: next.name, input: next.input }]
      : [{ type: "text", text: "done" }];
    const stop = next ? "tool_use" : "end_turn";
    const id = `msg_${crypto.randomBytes(10).toString("hex")}`;
    const usage = { input_tokens: 10, output_tokens: 5 };
    if (!body?.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body?.model, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    blocks.forEach((block, index) => {
      if (block.type === "tool_use") {
        event("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      } else {
        event("content_block_start", { index, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
      }
      event("content_block_stop", { index });
    });
    event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    event("message_stop", {});
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    // What Claude Code sent back for a script's calls, in order.
    results: (key) => requests.filter((r) => r.key === key).reduce((longest, r) => (r.results.length > longest.length ? r.results : longest), []),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Claude Code's own config folder for a test (CLAUDE_CONFIG_DIR): past its
// first-run screens, the folder trusted, the stand-in key approved, so an
// interactive session starts straight at the prompt.
export const STANDIN_KEY = `sk-ant-api03-reach-standin-${"0".repeat(40)}`;
export function claudeConfig({ folders = [] } = {}) {
  return {
    hasCompletedOnboarding: true,
    theme: "dark",
    numStartups: 5,
    customApiKeyResponses: { approved: [STANDIN_KEY.slice(-20)], rejected: [] },
    projects: Object.fromEntries(folders.map((folder) => [folder, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] }])),
  };
}
// The environment Claude Code runs in: only the stand-in, never Anthropic.
export function claudeEnv({ base = process.env, configDir, url, extra = {} }) {
  const env = { ...base };
  for (const name of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/i.test(name)) delete env[name];
  return {
    ...env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: STANDIN_KEY,
    ANTHROPIC_BASE_URL: url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    ...extra,
  };
}
