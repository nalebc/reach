import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createReach } from "../server/index.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.env.REACH_TEST_TRANSPORT_BENCHMARK === "1";
const rounded = (value) => Math.round(value * 1000) / 1000;
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return {
    samples: values.length,
    min: rounded(sorted[0]),
    median: rounded(
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    ),
    p95: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    max: rounded(sorted.at(-1)),
  };
};

// Opt-in performance evidence, not a machine-dependent speed assertion in CI.
// Every call runs the real agent runtime against the same read-only HTTP
// fixture. No screen capture/input, external connection, or LLM is involved.
test(
  "measure process-per-call CLI versus persistent stdio MCP against a read-only local Reach",
  {
    skip: !enabled && "set REACH_TEST_TRANSPORT_BENCHMARK=1",
    timeout: 60000,
  },
  async (t) => {
    const dir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "reach-transport-benchmark-")),
    );
    const agentHome = path.join(dir, "agent-home"),
      shared = path.join(dir, "shared");
    fs.mkdirSync(shared);
    const front = {
      app: "Fixture",
      title: "Synthetic read-only observation",
      bundleId: "test.fixture",
      canType: false,
    };
    const reach = await createReach({
      roots: [shared],
      dataDir: path.join(dir, "private"),
      screen: false,
      agentPolicyFile: path.join(dir, "policy.json"),
      browserFilesSupported: true,
      agentDesktop: {
        available: () => true,
        front: async (_client, authorize) => {
          authorize();
          return front;
        },
        cancelClient() {},
      },
      browserCapture: async () =>
        assert.fail("Benchmark never captures the host"),
      browserInput: async () =>
        assert.fail("Benchmark never controls the host"),
      desktopTerminals: {
        platform: "linux",
        run: async () => assert.fail("Benchmark never opens terminals"),
      },
    });
    const processes = new Set(),
      requests = [];
    reach.server.prependListener("request", (req) =>
      requests.push(`${req.method} ${req.url}`),
    );
    await new Promise((resolve) =>
      reach.server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${reach.server.address().port}`;
    const invitation = reach.auth.inviteBrowser({
      name: "Transport benchmark",
      preset: "readonly",
      ttlSeconds: 600,
      folders: [{ root: 0, path: "" }],
    });
    const joined = admitAgent(reach.auth, invitation.invitation);
    const connection = path.join(agentHome, "fixture");
    fs.mkdirSync(connection, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(connection, "credential.json"),
      JSON.stringify({
        version: 1,
        via: "direct",
        computer: "Fixture",
        origin,
        token: joined.token,
        scopes: joined.scopes,
        expiresAt: Date.now() + 600000,
      }),
      { mode: 0o600 },
    );
    t.after(async () => {
      for (const child of processes) child.kill("SIGKILL");
      reach.server.closeAllConnections();
      await reach.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const runtime = path.join(repo, "scripts/agent-remote.mjs");
    function start(args) {
      const env = Object.fromEntries(
        ["PATH", "TMPDIR", "TEMP", "SystemRoot", "WINDIR", "LANG"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      );
      env.REACH_AGENT_HOME = agentHome;
      const started = performance.now();
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=256",
          runtime,
          ...args,
          "--computer",
          "fixture",
          "--allow-local",
        ],
        {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
          killSignal: "SIGKILL",
        },
      );
      processes.add(child);
      let stdout = "",
        stderr = "",
        sequence = 0,
        buffer = "";
      const waiting = new Map();
      const done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          processes.delete(child);
          for (const pending of waiting.values())
            pending.reject(Error("MCP process ended before its response"));
          waiting.clear();
          resolve({
            code,
            stdout,
            stderr,
            ms: rounded(performance.now() - started),
          });
        });
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 1024 * 1024) child.kill("SIGKILL");
        if (args[0] !== "mcp") return;
        buffer += chunk;
        while (buffer.includes("\n")) {
          const at = buffer.indexOf("\n"),
            line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            child.kill("SIGKILL");
            continue;
          }
          const pending = waiting.get(message.id);
          if (pending) {
            waiting.delete(message.id);
            pending.resolve(message);
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 65536) child.kill("SIGKILL");
      });
      const rpc = async (method, params) => {
        const id = ++sequence;
        const response = new Promise((resolve, reject) =>
          waiting.set(id, { resolve, reject }),
        );
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
        const reply = await response;
        assert.equal(reply.error, undefined, JSON.stringify(reply.error));
        return reply.result;
      };
      return { child, done, rpc, started };
    }
    async function cli(args) {
      const before = requests.length,
        execution = start(args);
      execution.child.stdin.end();
      const result = await execution.done;
      assert.equal(result.code, 0, result.stderr);
      if (args[0] === "call")
        assert.deepEqual(JSON.parse(result.stdout), front);
      return { ms: result.ms, requests: requests.slice(before) };
    }
    async function mcpStart() {
      const before = requests.length,
        process = start(["mcp"]);
      await process.rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      });
      const initializedMs = rounded(performance.now() - process.started);
      process.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      const catalog = await process.rpc("tools/list");
      assert.ok(catalog.tools.some((tool) => tool.name === "reach_front"));
      const readyMs = rounded(performance.now() - process.started);
      return {
        ...process,
        initializedMs,
        readyMs,
        setupRequests: requests.slice(before),
      };
    }
    async function mcpCall(process) {
      const before = requests.length,
        started = performance.now();
      const result = await process.rpc("tools/call", {
        name: "reach_front",
        arguments: {},
      });
      const ms = rounded(performance.now() - started);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.deepEqual(
        JSON.parse(result.content.find((item) => item.type === "text").text),
        front,
      );
      return { ms, requests: requests.slice(before) };
    }
    async function stop(process) {
      process.child.stdin.end();
      assert.equal((await process.done).code, 0);
    }
    const baseline = [],
      cold = [];
    for (let sample = 0; sample < 12; sample++) {
      baseline.push(await cli(["help"]));
      let cliCall, mcp;
      const measureMcp = async () => {
        const process = await mcpStart(),
          first = await mcpCall(process);
        mcp = {
          initializedMs: process.initializedMs,
          readyMs: process.readyMs,
          setupRequests: process.setupRequests,
          firstCall: first,
          totalMs: rounded(performance.now() - process.started),
        };
        await stop(process);
      };
      if (sample % 2) {
        await measureMcp();
        cliCall = await cli(["call", "reach_front", "{}"]);
      } else {
        cliCall = await cli(["call", "reach_front", "{}"]);
        await measureMcp();
      }
      cold.push({ cli: cliCall, mcp });
    }
    const persistent = await mcpStart(),
      warm = [];
    await mcpCall(persistent); // one explicit warmup, excluded from steady-state samples
    for (let sample = 0; sample < 40; sample++)
      warm.push(await mcpCall(persistent));
    await stop(persistent);
    const result = {
      schema: "reach.agent-transport-benchmark.v1",
      at: new Date().toISOString(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpu: os.cpus()[0]?.model,
        runtime: "scripts/agent-remote.mjs",
      },
      scenario:
        "real admitted read-only credential; reach_front; loopback HTTP; inert desktop adapter; source runtime",
      command:
        "REACH_TEST_TRANSPORT_BENCHMARK=1 REACH_TRANSPORT_BENCHMARK_OUTPUT=/tmp/reach-transport-benchmark.json npm run test:file -- --test-concurrency=1 test/agent-transport-benchmark.test.mjs",
      summaryMs: {
        cliHelpProcessBaseline: summarize(baseline.map((sample) => sample.ms)),
        cliProcessPerCall: summarize(cold.map((sample) => sample.cli.ms)),
        mcpProcessInitialize: summarize(
          cold.map((sample) => sample.mcp.initializedMs),
        ),
        mcpProcessInitializeAndDiscover: summarize(
          cold.map((sample) => sample.mcp.readyMs),
        ),
        mcpColdFirstCallAfterDiscovery: summarize(
          cold.map((sample) => sample.mcp.firstCall.ms),
        ),
        mcpColdStartThroughFirstResult: summarize(
          cold.map((sample) => sample.mcp.totalMs),
        ),
        mcpWarmCall: summarize(warm.map((sample) => sample.ms)),
      },
      requestCounts: {
        cliPerCall: summarize(cold.map((sample) => sample.cli.requests.length)),
        mcpSetup: summarize(
          cold.map((sample) => sample.mcp.setupRequests.length),
        ),
        mcpPerCall: summarize(warm.map((sample) => sample.requests.length)),
      },
      limitations: [
        "No model inference, WAN/Tailscale latency, TLS handshakes, physical desktop execution or external providers are measured.",
        "Cold means a fresh process; operating-system code and filesystem caches are not flushed. Alternating CLI/MCP order reduces order bias.",
        "CLI timing includes process startup, live access discovery, execution and process exit. MCP cold total ends at its first result and excludes shutdown.",
        "Warm MCP reuses one stdio process after initialization and discovery. Current CLI starts a fresh process for every command; it has no equivalent warm process mode.",
        "CLI help is a lower-bound process/import baseline, not an isolated measurement of all startup work in call or MCP modes.",
        "Host CPU load is not controlled. Results are comparative evidence for this fixture, not a production latency guarantee.",
      ],
      raw: { baseline, cold, warm },
    };
    if (process.env.REACH_TRANSPORT_BENCHMARK_OUTPUT)
      fs.writeFileSync(
        path.resolve(process.env.REACH_TRANSPORT_BENCHMARK_OUTPUT),
        JSON.stringify(result, null, 2) + "\n",
      );
    t.diagnostic(JSON.stringify(result.summaryMs));
  },
);
