#!/usr/bin/env node
// A team lead's tools (server/agent-sessions/teams.mjs), as an MCP server
// over stdio: the lead's agent (Claude Code, Codex) runs it with
// REACH_TEAM_FILE naming the team's key file (mode 0600), and each tool call
// goes to Reach on its private socket. Only JSON-RPC goes to stdout.
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
import { TEAM_TOOLS } from "../server/agent-sessions/team-tools.mjs";

const file = process.env.REACH_TEAM_FILE || "";
const key = (() => {
  try {
    const stat = fs.statSync(file);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value?.socket === "string" && typeof value?.token === "string" ? value : null;
  } catch {
    return null;
  }
})();

// One request to Reach, on a connection of its own.
const ask = (tool, args) =>
  new Promise((resolve, reject) => {
    if (!key) return reject(new Error("This team has ended (its key is gone). Carry on without helpers."));
    const socket = net.createConnection(key.socket);
    let buffer = "";
    const timer = setTimeout(() => (socket.destroy(), reject(new Error("Reach didn't answer."))), 45000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, token: key.token, tool, args })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const reply = JSON.parse(buffer.slice(0, i));
        if (reply.error) reject(new Error(reply.error));
        else resolve(reply.result);
      } catch {
        reject(new Error("Reach answered something unexpected."));
      }
    });
    socket.on("error", () => (clearTimeout(timer), reject(new Error("Reach isn't running, so the team can't act right now."))));
  });

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined || m.id === null) return; // notifications
  if (m.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "reach_team", version: "1" } },
    });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: TEAM_TOOLS } });
  if (m.method === "tools/call") {
    const name = m.params?.name;
    if (!TEAM_TOOLS.some((t) => t.name === name)) return send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Unknown tool." } });
    try {
      const result = await ask(name, m.params?.arguments || {});
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (error) {
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: error.message }], isError: true } });
    }
  }
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found." } });
});
