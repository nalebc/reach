#!/usr/bin/env node
// Stdio MCP adapter: the agent runs this locally; HTTPS requests reach its computer.
import { createAgentClient, privateFile } from "./agent-client.mjs";
import { serveMcp } from "./mcp-server.mjs";
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
await serveMcp({
  api: (route, method = "GET", body) => client(route, method, body),
  scopes: credential.scopes,
});
