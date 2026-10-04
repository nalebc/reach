#!/usr/bin/env node
// Stdio MCP adapter: the agent runs this locally; HTTPS requests reach its computer.
import readline from "node:readline";
import { createAgentClient, privateFile } from "./agent-client.mjs";
const credential = process.env.REACH_CREDENTIAL
  ? JSON.parse(privateFile(process.env.REACH_CREDENTIAL))
  : {
      url: process.env.REACH_URL || "http://localhost:4317",
      token: process.env.REACH_TOKEN,
    };
const client = createAgentClient(credential, {
  allowLocal:
    process.env.REACH_ALLOW_LOCAL === "1" || !process.env.REACH_CREDENTIAL,
});
const location = {
  root: {
    type: "integer",
    minimum: 0,
    description: "Shared folder index, from reach_device. Defaults to 0.",
  },
  path: { type: "string", description: "Path relative to the shared folder." },
};
const tools = [
  {
    name: "reach_device",
    description: "Read the connected computer and its shared folders.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reach_list_files",
    description: "List files in a shared folder on the remote computer.",
    inputSchema: { type: "object", properties: location },
  },
  {
    name: "reach_read_file",
    description: "Read a UTF-8 text file up to 1 MB on the remote computer.",
    inputSchema: { type: "object", properties: location, required: ["path"] },
  },
  {
    name: "reach_write_file",
    description:
      "Update an existing UTF-8 file up to 128 KiB. Requires files:write and sha256 from its last read; a conflict must be reconciled, never blindly retried.",
    inputSchema: {
      type: "object",
      properties: {
        ...location,
        text: { type: "string" },
        sha256: { type: "string" },
      },
      required: ["path", "text", "sha256"],
    },
  },
  {
    name: "reach_create_folder",
    description:
      "Create a folder inside an allowed shared folder. Requires files:write.",
    inputSchema: {
      type: "object",
      properties: { ...location, name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "reach_run_command",
    description:
      "Run a shell command as the computer user. Returns a job ID; poll reach_get_job for output. Only execute commands authorized by the user.",
    inputSchema: {
      type: "object",
      properties: {
        ...location,
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 3600000 },
      },
      required: ["command"],
    },
  },
  {
    name: "reach_get_job",
    description: "Read a command job’s status, output, and exit code.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "reach_cancel_job",
    description: "Stop a command job and its child processes.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "reach_list_chats",
    description: "List Codex conversations created through Reach.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reach_create_chat",
    description:
      "Create a Codex conversation in a shared folder. Requires codex scope.",
    inputSchema: {
      type: "object",
      properties: { ...location, name: { type: "string" } },
    },
  },
  {
    name: "reach_send_message",
    description:
      "Send instructions to a Reach Codex conversation. Approval requests must be reviewed by a user in the Reach app.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
  },
  {
    name: "reach_get_chat",
    description:
      "Read a Codex conversation, including pending approvals. This tool does not grant approvals.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];
async function api(route, method = "GET", body) {
  return client(route, method, body);
}
async function call(name, a) {
  const query = new URLSearchParams({
    root: String(a.root || 0),
    path: a.path || "",
  });
  const encoded = encodeURIComponent(a.id || "");
  switch (name) {
    case "reach_device":
      return api("/api/device");
    case "reach_list_files":
      return api("/api/files?" + query);
    case "reach_read_file":
      return api("/api/files/text?" + query);
    case "reach_write_file":
      return api("/api/files/text?" + query, "PUT", {
        text: a.text,
        sha256: a.sha256,
      });
    case "reach_create_folder":
      return api("/api/files/folder", "POST", a);
    case "reach_run_command":
      return api("/api/jobs", "POST", a);
    case "reach_get_job":
      return api("/api/jobs/" + encoded);
    case "reach_cancel_job":
      return api("/api/jobs/" + encoded, "DELETE");
    case "reach_list_chats":
      return api("/api/chats");
    case "reach_create_chat":
      return api("/api/chats", "POST", a);
    case "reach_send_message":
      return api("/api/chats/" + encoded + "/messages", "POST", {
        text: a.text,
      });
    case "reach_get_chat":
      return api("/api/chats/" + encoded);
    default:
      throw Error("Unknown tool");
  }
}
const write = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
readline
  .createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", async (line) => {
    let r;
    try {
      r = JSON.parse(line);
      if (r.id === undefined) return;
      let result;
      if (r.method === "initialize")
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "reach", version: "0.1.0" },
        };
      else if (r.method === "ping") result = {};
      else if (r.method === "tools/list") {
        const scopes =
          (await api("/api/device")).access?.scopes || credential.scopes || [];
        result = {
          tools: tools.filter((tool) => {
            if (tool.name === "reach_device") return true;
            const scope = ["reach_write_file", "reach_create_folder"].includes(
              tool.name,
            )
              ? "files:write"
              : ["reach_list_files", "reach_read_file"].includes(tool.name)
                ? "files:read"
                : tool.name.includes("chat") ||
                    tool.name === "reach_send_message"
                  ? "codex"
                  : "exec";
            return (
              scopes.includes(scope) ||
              (scope.startsWith("files:") && scopes.includes("files"))
            );
          }),
        };
      } else if (r.method === "tools/call") {
        try {
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  await call(r.params.name, r.params.arguments || {}),
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (e) {
          result = {
            isError: true,
            content: [{ type: "text", text: e.message }],
          };
        }
      } else {
        write({
          id: r.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
      }
      write({ id: r.id, result });
    } catch (e) {
      write({ id: r?.id ?? null, error: { code: -32603, message: e.message } });
    }
  });
