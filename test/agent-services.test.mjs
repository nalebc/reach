import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createAgentServices } from "../server/agent-services.mjs";
import { SAMPLE_STORE } from "./helpers/service-connector-fixture.mjs";
import {
  browserToolsFor,
  browserToolRequest,
} from "../server/browser-tools.mjs";
import { toolsFor, callTool } from "../scripts/mcp-server.mjs";
import {
  presetFixture,
  privateIngressTest,
} from "./helpers/preset-fixture.mjs";

function fixture(t, extra = {}) {
  let time = Date.now();
  const client = {
    id: "agent",
    name: "Test agent",
    kind: "agent",
    status: "accepted",
    scopes: ["device", "browser:read", "files:read"],
    expiresAt: time + 600000,
    policy: { browser: true, preset: "readonly", roots: [] },
  };
  const owner = { id: "phone", kind: "device", scopes: ["admin"] };
  const notices = [],
    events = [];
  const service = createAgentServices({
    connectors: [SAMPLE_STORE],
    verifyClient: (id) => (id === client.id ? client : null),
    now: () => time,
    notify: (value) => notices.push(value),
    record: (...value) => events.push(value),
    ...extra,
  });
  t.after(() => service.close());
  const authorize = () => client;
  const request = () =>
    service.request(authorize, {
      connectorId: "sample_store",
      reason: "Check my order",
    });
  const approve = () =>
    service.decide(() => owner, request().id, { decision: "approve" });
  const payload = (
    values = { orderId: "DEMO-1001" },
    requestId = crypto.randomUUID(),
  ) => ({
    connectorId: "sample_store",
    action: "order_status",
    values,
    requestId,
  });
  return {
    service,
    client,
    owner,
    authorize,
    request,
    approve,
    payload,
    notices,
    events,
    advance: (ms) => (time += ms),
  };
}

test("one phone approval grants only service reads; duplicate requests and runs reuse results", async (t) => {
  let calls = 0;
  const f = fixture(t, {
    connectors: [
      {
        ...SAMPLE_STORE,
        run: (...args) => {
          calls++;
          return SAMPLE_STORE.run(...args);
        },
      },
    ],
  });
  const original = structuredClone(f.client);
  assert.equal(f.service.catalog(f.authorize).connectors[0].access, null);
  await assert.rejects(f.service.run(f.authorize, f.payload()), /not approved/);
  assert.deepEqual(f.request(), f.request());
  assert.equal(f.notices.length, 1);
  f.approve();
  const input = f.payload(),
    result = await f.service.run(f.authorize, input);
  assert.equal(result.sample, undefined);
  assert.equal(result.data.status, "shipped");
  assert.deepEqual(await f.service.run(f.authorize, input), result);
  assert.equal(calls, 1);
  await assert.rejects(
    f.service.run(f.authorize, { ...input, values: { orderId: "DEMO-1002" } }),
    /another service run/,
  );
  assert.deepEqual(
    f.client,
    original,
    "service approval cannot alter laptop scopes",
  );
});

test("only an owner can approve; grants are private to the admitted agent", async (t) => {
  const f = fixture(t),
    receipt = f.request();
  assert.throws(
    () => f.service.decide(f.authorize, receipt.id, { decision: "approve" }),
    /Only the owner/,
  );
  assert.throws(
    () => f.service.list(() => ({ kind: "guest", scopes: ["admin"] })),
    /Only the owner/,
  );
  f.service.decide(() => f.owner, receipt.id, { decision: "approve" });
  const other = { ...f.client, id: "another-agent" };
  assert.equal(f.service.catalog(() => other).connectors[0].access, null);
  await assert.rejects(
    f.service.run(() => other, f.payload()),
    /not approved/,
  );
  for (const status of ["pending", "revoked", "invited"]) {
    assert.throws(
      () => f.service.catalog(() => ({ ...f.client, status })),
      /active, approved/,
    );
  }
});

test("denial, expiry, changed access and stopping a session invalidate service consent", async (t) => {
  const f = fixture(t),
    pending = f.request();
  f.service.decide(() => f.owner, pending.id, { decision: "deny" });
  await assert.rejects(f.service.run(f.authorize, f.payload()), /not approved/);
  assert.throws(f.request, /Wait a moment/);
  f.advance(31000);
  f.approve();
  f.client.policy = { ...f.client.policy, roots: ["/changed"] };
  await assert.rejects(f.service.run(f.authorize, f.payload()), /not approved/);
  const grant = f.approve();
  f.service.cancelClient(f.client.id);
  assert.equal(
    f.service.inspect().find((e) => e.id === grant.id).status,
    "revoked",
  );
  f.advance(31000);
  f.request();
  f.advance(300001);
  assert.throws(
    () =>
      f.service.decide(() => f.owner, f.service.inspect()[0].id, {
        decision: "approve",
      }),
    /already ended/,
  );
});

test("revocation blocks cached results and aborts an in-flight provider read", async (t) => {
  let finish, started;
  const began = new Promise((resolve) => (started = resolve));
  const f = fixture(t, {
    connectors: [
      {
        ...SAMPLE_STORE,
        run: (_action, input, { signal }) => {
          started(signal);
          return new Promise(
            (resolve) =>
              (finish = () =>
                resolve({
                  orderId: input.orderId,
                  status: "shipped",
                  summary: "private result",
                })),
          );
        },
      },
    ],
  });
  const grant = f.approve();
  const pending = f.service.run(f.authorize, f.payload());
  const signal = await began;
  f.service.decide(() => f.owner, grant.id, { decision: "revoke" });
  assert.equal(signal.aborted, true);
  finish();
  await assert.rejects(pending, /not approved/);
  assert.equal(
    f.events.some((event) => event.join(" ").includes("private result")),
    false,
  );
});

test("malformed input, arbitrary endpoints, write actions and provider error secrets never escape", async (t) => {
  const f = fixture(t, {
    connectors: [
      {
        ...SAMPLE_STORE,
        run: () => {
          throw Error("Authorization: secret-token");
        },
      },
    ],
  });
  f.approve();
  for (const payload of [
    { ...f.payload(), url: "http://localhost" },
    { ...f.payload(), connectorId: "unknown" },
    { ...f.payload(), action: "cancel_order" },
    f.payload({ orderId: "../secret" }),
    f.payload({ orderId: "DEMO-1001", token: "agent-supplied" }),
    { ...f.payload(), requestId: "bad" },
  ])
    await assert.rejects(f.service.run(f.authorize, payload));
  await assert.rejects(
    f.service.run(f.authorize, f.payload()),
    (error) =>
      !error.message.includes("secret-token") &&
      /could not complete/.test(error.message),
  );
  assert.throws(
    () =>
      createAgentServices({
        connectors: [{ ...SAMPLE_STORE, actions: [{ readOnly: false }] }],
      }),
    /read-only/,
  );
});

test("MCP and browser expose service tools to read-only agents with fixed request mappings", async (t) => {
  const f = fixture(t);
  const access = {
    preset: "readonly",
    services: f.service.catalog(f.authorize),
    roots: [],
    terminals: [],
  };
  const name = "reach_service_sample_store_order_status";
  assert.ok(browserToolsFor(access).some((tool) => tool.name === name));
  const tools = toolsFor(f.client.scopes, access);
  assert.equal(
    tools.find((tool) => tool.name === name).annotations.readOnlyHint,
    true,
  );
  assert.equal(
    tools.find((tool) => tool.name === "reach_service_request").annotations
      .readOnlyHint,
    false,
  );
  assert.ok(
    !tools.some(
      (tool) => tool.name === "reach_act" || tool.name === "reach_shell",
    ),
  );
  const args = { orderId: "DEMO-1001", requestId: crypto.randomUUID() };
  const plan = browserToolRequest(name, args, access);
  assert.equal(plan.route, "/api/browser/services/run");
  assert.equal(plan.body.connectorId, "sample_store");
  assert.deepEqual(
    await callTool(async (...args) => args, name, args, access),
    [plan.route, plan.method, plan.body],
  );
});

test(
  "real agent routes: phone approves, read-only agent runs, owner revokes without changing laptop access",
  privateIngressTest,
  async (t) => {
    const f = await presetFixture(t, {
      serviceOptions: { connectors: [SAMPLE_STORE] },
    });
    const agent = await f.join({
      preset: "readonly",
      folders: [{ root: 1, path: "" }],
    });
    const catalog = await agent.as("/api/browser/services");
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    const access = await agent.as("/api/browser");
    assert.equal(access.body.services.connectors[0].id, "sample_store");
    assert.equal(access.body.control, false);
    const run = {
      connectorId: "sample_store",
      action: "order_status",
      values: { orderId: "DEMO-1001" },
      requestId: crypto.randomUUID(),
    };
    assert.equal(
      (
        await agent.as("/api/browser/services/run", {
          method: "POST",
          body: run,
        })
      ).status,
      403,
    );
    const request = await agent.as("/api/browser/services/request", {
      method: "POST",
      body: { connectorId: "sample_store", reason: "Read order status" },
    });
    assert.equal(request.status, 200, JSON.stringify(request.body));
    const route = `/api/agents/services/${request.body.id}`;
    assert.equal(
      (await agent.as(route, { method: "POST", body: { decision: "approve" } }))
        .status,
      403,
    );
    assert.equal(
      (await f.call(route, { method: "POST", body: { decision: "approve" } }))
        .status,
      200,
    );
    const done = await agent.as("/api/browser/services/run", {
      method: "POST",
      body: run,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.status, "shipped");
    assert.equal(
      (
        await agent.as("/api/browser/desktop/input", {
          method: "POST",
          body: {},
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.call(route, { method: "POST", body: { decision: "revoke" } }))
        .status,
      200,
    );
    assert.equal(
      (
        await agent.as("/api/browser/services/run", {
          method: "POST",
          body: run,
        })
      ).status,
      403,
    );
  },
);

test("pause, grant expiry and provider timeout stop reads; output projection drops extra fields", async (t) => {
  let paused = true;
  const f = fixture(t, {
    paused: () => paused,
    connectors: [
      {
        ...SAMPLE_STORE,
        run: async (_action, values) => ({
          orderId: values.orderId,
          status: "processing",
          summary: "Queued",
          token: "secret",
        }),
      },
    ],
  });
  f.approve();
  await assert.rejects(f.service.run(f.authorize, f.payload()), /paused/);
  paused = false;
  const input = f.payload();
  const result = await f.service.run(f.authorize, input);
  assert.equal(result.data.token, undefined);
  f.advance(600001);
  await assert.rejects(f.service.run(f.authorize, input), /active, approved/);
  const slow = fixture(t, {
    runMs: 20,
    connectors: [{ ...SAMPLE_STORE, run: () => new Promise(() => {}) }],
  });
  slow.approve();
  // The manager's timers intentionally do not keep Reach alive at shutdown.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await assert.rejects(
      slow.service.run(slow.authorize, slow.payload()),
      /could not complete/,
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
