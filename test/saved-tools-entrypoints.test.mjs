import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  presetFixture,
  privateIngressTest,
  apps,
} from "./helpers/preset-fixture.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/agent-cli.mjs", import.meta.url));
const remote = fileURLToPath(
  new URL("../scripts/agent-remote.mjs", import.meta.url),
);

// The CLI/MCP processes, HTTP authorization and saved-tool service are real.
// Tailscale identity and desktop IO are inert fixtures: this never controls a Mac.
async function connection(t, f, agent, origin) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "reach-saved-entry-"));
  const folder = path.join(home, "fixture");
  await fs.mkdir(folder);
  const file = path.join(folder, "credential.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      ...agent.joined,
      url: origin,
      origin,
      via: "direct",
      computer: "Synthetic Mac",
    }),
    { mode: 0o600 },
  );
  const children = new Set();
  t.after(async () => {
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return resolve();
            child.once("close", resolve);
            child.kill();
          }),
      ),
    );
    await fs.rm(home, { recursive: true, force: true });
  });
  const credentialCli = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [cli, ...args, "--credential", file, "--allow-local"],
          { timeout: 15000 },
        )
      ).stdout,
    );
  const remoteCli = async (...args) =>
    JSON.parse(
      (
        await exec(process.execPath, [remote, ...args, "--allow-local"], {
          env: { ...process.env, REACH_AGENT_HOME: home },
          timeout: 15000,
        })
      ).stdout,
    );
  const child = spawn(
    process.execPath,
    [cli, "mcp", "--credential", file, "--allow-local"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.add(child);
  let next = 0,
    errors = "";
  const pending = new Map(),
    notifications = [];
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    if (value.id === undefined) notifications.push(value);
    else pending.get(value.id)?.resolve(value);
  });
  const failed = (error) => {
    for (const request of [...pending.values()]) request.reject(error);
  };
  child.once("error", failed);
  child.once("close", (code) => {
    children.delete(child);
    failed(Error(`MCP closed (${code}): ${errors}`));
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`MCP timed out: ${method}`));
      }, 15000);
      const finish = (callback, value) => {
        clearTimeout(timer);
        pending.delete(id);
        callback(value);
      };
      pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params ? { params } : {}),
        }) + "\n",
      );
    });
  const call = (name, args = {}) =>
    request("tools/call", { name, arguments: args });
  const tool = async (name, args = {}) => {
    const reply = await call(name, args);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
    return JSON.parse(
      reply.result.content.find((part) => part.type === "text").text,
    );
  };
  return { request, call, tool, notifications, credentialCli, remoteCli };
}

test(
  "saved tasks round-trip through both CLIs and independent stdio agents, respecting owner disable and revocation",
  privateIngressTest,
  async (t) => {
    const seen = [];
    const front = {
      app: apps.chrome.name,
      bundle: apps.chrome.bundleId,
      path: apps.chrome.id,
      title: "Synthetic task form",
      layout: "fixture-layout",
      secure: false,
      blocked: "",
    };
    const f = await presetFixture(t, {
      desktopExtras: {
        front: async (_, authorize) => {
          authorize();
          return { ...front };
        },
        open: async (client, app, authorize) => {
          authorize();
          assert.equal(app, apps.chrome.id);
          seen.push({ clientId: client.id, type: "open" });
          return { ok: true, bundle: front.bundle };
        },
        act: async (client, action, authorize, options) => {
          authorize();
          if (options?.expected)
            assert.deepEqual(options.expected, {
              bundle: front.bundle,
              title: front.title,
              layout: front.layout,
            });
          seen.push({ clientId: client.id, ...action });
          return { ok: true, bundle: front.bundle };
        },
      },
    });
    const proxy = http.createServer((request, response) => {
      const upstream = http.request(
        {
          socketPath: f.socketPath,
          method: request.method,
          path: request.url,
          headers: {
            ...request.headers,
            host: "localhost",
            "x-forwarded-for": "100.64.0.5",
            "tailscale-user-login": "owner@example.test",
          },
        },
        (result) => {
          response.writeHead(result.statusCode, result.headers);
          result.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          proxy.closeAllConnections();
          proxy.close(resolve);
        }),
    );
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    const first = await f.join({
      preset: "apps",
      apps: [{ id: apps.chrome.id }],
    });
    const second = await f.join({
      preset: "apps",
      apps: [{ id: apps.chrome.id }],
    });
    const restricted = await f.join({
      preset: "apps",
      apps: [{ id: apps.notes.id }],
    });
    const [one, two, other] = await Promise.all([
      connection(t, f, first, origin),
      connection(t, f, second, origin),
      connection(t, f, restricted, origin),
    ]);
    const init = await one.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "synthetic-audit", version: "1" },
    });
    assert.equal(init.result.capabilities.tools.listChanged, true);
    // One line: the tools' own descriptions carry the rest.
    assert.match(init.result.instructions, /^Check reach_tools[^\n]*reach_tool_batch\./);
    assert.equal(
      (await one.request("tools/list")).result.tools.some((tool) =>
        tool.name.startsWith("reach_saved_"),
      ),
      false,
    );
    await one.tool("reach_record_shortcut", {
      name: "Fill the synthetic form",
    });
    await one.tool("reach_open_app", { app: apps.chrome.id });
    await one.tool("reach_act", {
      action: { type: "type", text: "ORIGINAL-PRIVATE-FORM-TEXT" },
    });
    await one.tool("reach_act", { action: { type: "key", key: "enter" } });
    const saved = await one.tool("reach_save_shortcut");
    const list = (await two.request("tools/list")).result.tools;
    const offered = list.find((tool) => tool.name.startsWith("reach_saved_"));
    assert.ok(offered);
    assert.equal(offered.title, "Fill the synthetic form");
    assert.deepEqual(offered.inputSchema.required, ["text1"]);
    assert.equal(offered.annotations.readOnlyHint, false);
    assert.equal(offered.annotations.destructiveHint, true);
    assert.ok(
      one.notifications.some(
        (note) => note.method === "notifications/tools/list_changed",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify((await f.call("/api/agents/shortcuts")).body),
      /ORIGINAL-PRIVATE-FORM-TEXT/,
    );
    assert.equal(
      (await other.request("tools/list")).result.tools.some(
        (tool) => tool.name === offered.name,
      ),
      false,
    );
    assert.equal(
      (await other.call(offered.name, { text1: "denied" })).result.isError,
      true,
    );
    for (const tools of [
      await two.credentialCli("tools"),
      await two.remoteCli("tools"),
    ])
      assert.deepEqual(
        tools.find((tool) => tool.name === offered.name).inputSchema,
        offered.inputSchema,
      );
    const before = seen.length;
    assert.equal(
      (
        await two.remoteCli(
          "call",
          offered.name,
          JSON.stringify({ text1: "Zoë — remote CLI" }),
        )
      ).status,
      "completed",
    );
    assert.equal(
      (await two.tool(offered.name, { text1: "MCP replacement value" })).status,
      "completed",
    );
    assert.deepEqual(
      seen
        .slice(before)
        .filter((item) => item.type === "type")
        .map((item) => item.text),
      ["Zoë — remote CLI", "MCP replacement value"],
    );
    assert.ok(
      seen
        .slice(before)
        .every((item) => item.clientId === second.joined.clientId),
    );
    assert.equal(
      (
        await f.call(`/api/agents/shortcuts/${saved.id}`, {
          method: "PATCH",
          body: { enabled: false },
        })
      ).status,
      200,
    );
    const stoppedAt = seen.length;
    assert.equal(
      (await two.call(offered.name, { text1: "must not run" })).result.isError,
      true,
    );
    assert.equal(
      (await two.request("tools/list")).result.tools.some(
        (tool) => tool.name === offered.name,
      ),
      false,
    );
    assert.equal(seen.length, stoppedAt);
    assert.equal(
      (
        await f.call(`/api/agents/shortcuts/${saved.id}`, {
          method: "PATCH",
          body: { enabled: true },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(`/api/clients/${second.joined.clientId}`, {
          method: "DELETE",
        })
      ).status,
      200,
    );
    assert.equal(
      (await two.call(offered.name, { text1: "revoked" })).result.isError,
      true,
    );
    assert.equal(seen.length, stoppedAt);
    assert.equal(
      (await one.tool(offered.name, { text1: "first agent still admitted" }))
        .status,
      "completed",
    );
    assert.ok(
      seen
        .slice(stoppedAt)
        .every((item) => item.clientId === first.joined.clientId),
    );
    assert.equal(
      (await f.call(`/api/agents/shortcuts/${saved.id}`, { method: "DELETE" }))
        .status,
      200,
    );
    assert.equal(
      (await one.call(offered.name, { text1: "deleted" })).result.isError,
      true,
    );
  },
);
