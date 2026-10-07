import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { createAgentClient } from "../scripts/agent-client.mjs";
import { tailnetApi } from "../scripts/agent-remote.mjs";
import { serveMcp } from "../scripts/mcp-server.mjs";
import { agentErrorDetails } from "../server/agent-transport.mjs";

const busy = {
  error: "Agent A is using the Mac.",
  kind: "busy",
  holder: "Agent A",
  retryInMs: 1200,
};
const expected = { ...busy, status: 409 };
const head = (status, body) => {
  let sent = false;
  return {
    status,
    headers: ["content-type", "application/json"],
    read: async () =>
      sent ? null : ((sent = true), Buffer.from(JSON.stringify(body))),
    cancel() {},
  };
};
const responseApi = (body) =>
  tailnetApi(
    {
      fetch: () => ({ response: Promise.resolve(head(409, body)), abort() {} }),
    },
    "https://fixture.tailnet.ts.net",
    "fixture",
  );
async function local(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return createAgentClient(
    {
      url: `http://127.0.0.1:${server.address().port}`,
      token: "fixture-token-with-no-authority",
    },
    { allowLocal: true, proxy: "" },
  );
}
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
function deadlines(t) {
  const timers = [],
    real = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms === 35000 || ms === 70000) {
      timers.push({ ms, fire: () => fn(...args) });
      return real(fn, 10000, ...args);
    }
    return real(fn, ms, ...args);
  });
  return {
    timers,
    passOldLimit: () =>
      timers
        .filter((timer) => timer.ms <= 35000)
        .forEach((timer) => timer.fire()),
  };
}

test("a Full-control shell result survives the ordinary request deadline, on direct HTTP and the tailnet adapter", async (t) => {
  const clock = deadlines(t);
  const api = await local(t, (req, res) => {
    clock.passOldLimit();
    json(res, 200, { status: "executed", output: "fixture completed" });
  });
  assert.equal(
    (await api("/api/browser/shell", "POST", { command: "fixture", root: 0 }))
      .output,
    "fixture completed",
  );
  assert.ok(
    clock.timers.every((timer) => timer.ms > 60000),
    "the server has60s plus termination/logging overhead",
  );
  clock.timers.length = 0;
  let finish;
  const throughNode = tailnetApi(
    {
      fetch: () => ({
        response: new Promise((resolve) => {
          finish = resolve;
        }),
        abort() {
          throw Error("unexpected early abort");
        },
      }),
    },
    "https://fixture.tailnet.ts.net",
    "fixture",
  );
  const pending = throughNode("/api/browser/shell", "POST", {
    command: "fixture",
    root: 0,
  });
  clock.passOldLimit();
  finish(head(200, { status: "executed", output: "tailnet completed" }));
  assert.equal((await pending).output, "tailnet completed");
  assert.ok(clock.timers.every((timer) => timer.ms > 60000));
});

test("ordinary and lookalike routes keep the shorter deadline and writes never retry", async (t) => {
  const clock = deadlines(t);
  let received = 0;
  const api = await local(t, () => {
    received++;
    clock.passOldLimit();
  });
  for (const [route, method] of [
    ["/api/browser/shell?other=1", "POST"],
    ["/api/browser/shell", "GET"],
    ["/api/browser/desktop/open", "POST"],
  ]) {
    clock.timers.length = 0;
    await assert.rejects(
      api(route, method, { app: "/fixture.app" }),
      /Mutating operations are not retried/,
    );
    assert.deepEqual(
      clock.timers.map((timer) => timer.ms),
      [35000],
    );
  }
  assert.equal(received, 3);
});

test("desktop scheduling metadata reaches direct HTTP, tailnet and MCP callers without arbitrary fields", async (t) => {
  const body = {
    ...busy,
    token: "private-fixture",
    stack: "private-stack",
    arbitrary: { secret: "no" },
  };
  const api = await local(t, (_req, res) => json(res, 409, body));
  for (const client of [api, responseApi(body)])
    await assert.rejects(
      client("/api/browser/desktop/input", "POST", {}),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.kind, "busy");
        assert.equal(error.retryInMs, 1200);
        assert.deepEqual(error.body, expected);
        assert.equal(JSON.stringify(error).includes("private-"), false);
        return true;
      },
    );
  const input = new PassThrough(),
    output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => (text += chunk));
  const done = serveMcp({ api, scopes: ["exec"], input, output });
  input.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "reach_run_command", arguments: { command: "fixture" } },
    }) + "\n",
  );
  await done;
  const result = JSON.parse(text).result;
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
});

test("scheduling errors bound display text and retain only valid retry guidance", () => {
  const result = agentErrorDetails({
    status: 409,
    body: {
      error: "x".repeat(2000),
      kind: "busy",
      holder: "A\n" + "x".repeat(200),
      retryInMs: 1200.2,
      token: "secret",
    },
  });
  assert.equal(result.error.length, 1000);
  assert.equal(result.holder.length, 100);
  assert.ok(!result.holder.includes("\n"));
  assert.equal(result.retryInMs, 1201);
  for (const retryInMs of [-1, Infinity, 60001, "1200"])
    assert.equal(
      agentErrorDetails({ body: { ...busy, retryInMs } }).retryInMs,
      undefined,
    );
  assert.deepEqual(
    agentErrorDetails({
      status: 200,
      body: {
        error: "failed",
        kind: "unknown",
        holder: "hidden",
        retryInMs: 2,
      },
    }),
    { error: "failed" },
  );
  assert.deepEqual(
    agentErrorDetails({
      body: {
        error: "paused",
        kind: "paused",
        holder: "ignored",
        retryInMs: 2,
      },
    }),
    { error: "paused", kind: "paused" },
  );
});


test("an agent name containing Abort or Cancel remains a structured busy response", async () => {
  for (const holder of ["Abort Agent", "Cancel bot"]) {
    const body = { ...busy, holder, error: `${holder} is using the Mac.` };
    await assert.rejects(responseApi(body)("/api/browser/desktop/input", "POST", {}), error => {
      assert.equal(error.status, 409);
      assert.equal(error.kind, "busy");
      assert.equal(error.holder, holder);
      assert.equal(error.retryInMs, 1200);
      assert.equal(error.message, body.error);
      return true;
    });
  }
});
