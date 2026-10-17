import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_STORE } from "./helpers/service-connector-fixture.mjs";
import { createAgentServices } from "../server/agent-services.mjs";
import { createServiceConnectors } from "../server/service-connectors.mjs";
import { startDom, settle } from "./dom/harness.mjs";

let dom, ServiceTools, AccessPanel, useAccess, NeedsYouStrip, SavedTools;
const views = new Set();
const peer = {
  id: "mac",
  name: "Mac",
  url: "https://reach.test",
  token: "agent",
};
const button = (root, text) =>
  [...root.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
before(async () => {
  dom = await startDom();
  ({ default: ServiceTools } = await dom.load("/src/ServiceAgentTools.tsx"));
  ({ ServiceAccessPanel: AccessPanel, useServiceAccess: useAccess } =
    await dom.load("/src/service-access.tsx"));
  ({ NeedsYouStrip } = await dom.load("/src/NeedsYou.tsx"));
  ({ default: SavedTools } = await dom.load("/src/SavedAgentTools.tsx"));
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
after(async () => dom?.close());
async function render(Component, props) {
  const view = await dom.render(dom.React.createElement(Component, props));
  views.add(view);
  return view;
}
function setup(t, connectors = [SAMPLE_STORE]) {
  const client = {
    id: "agent",
    name: "Order helper",
    kind: "agent",
    status: "accepted",
    scopes: ["browser:read"],
    policy: { browser: true, preset: "readonly", roots: [] },
    expiresAt: Date.now() + 600000,
  };
  const owner = { id: "phone", kind: "device", scopes: ["admin"] };
  const service = createAgentServices({
    connectors,
    verifyClient: (id) => (id === client.id ? client : null),
  });
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, body });
    let value;
    try {
      if (route === "/api/browser/services")
        value = service.catalog(() => client);
      else if (route === "/api/browser/services/request")
        value = service.request(() => client, body);
      else if (route === "/api/browser/services/run")
        value = await service.run(() => client, body);
      else if (route === "/api/agents/services")
        value = service.list(() => owner);
      else if (route.startsWith("/api/agents/services/"))
        value = service.decide(() => owner, route.split("/").at(-1), body);
      else throw Error(`Unexpected route ${route}`);
      return Response.json(value);
    } catch (error) {
      return Response.json(
        { error: error.message },
        { status: error.status || 500 },
      );
    }
  };
  t.after(() => service.close());
  return { service, client, owner, calls };
}
function Home(props) {
  const { items } = useAccess(props.peer);
  return dom.React.createElement(NeedsYouStrip, { items });
}

test("one click requests access, phone approval resumes the task, later reads need no new approval, revoke clears results", async (t) => {
  const f = setup(t);
  const agent = await render(ServiceTools, { peer });
  await dom.waitFor(() => button(agent.container, "Check order status"));
  button(agent.container, "Check order status").click();
  button(agent.container, "Check order status").click();
  await dom.waitFor(() =>
    agent.container.textContent.includes("automatically after approval"),
  );
  assert.equal(
    f.calls.filter((call) => call.route.endsWith("/request")).length,
    1,
  );
  assert.equal(f.calls.filter((call) => call.route.endsWith("/run")).length, 0);
  const phone = await render(Home, { peer: { ...peer, token: "owner" } });
  await dom.waitFor(() => button(phone.container, "Allow for session"));
  assert.match(phone.container.textContent, /Built-in sample account/);
  assert.match(phone.container.textContent, /Read order status/);
  button(phone.container, "Allow for session").click();
  await dom.waitFor(() =>
    agent.container.textContent.includes("Your sample desk lamp"),
  );
  assert.match(agent.container.textContent, /Completed/);
  button(agent.container, "Check order status").click();
  await dom.waitFor(
    () => f.calls.filter((call) => call.route.endsWith("/run")).length === 2,
  );
  assert.equal(
    f.calls.filter((call) => call.route.endsWith("/request")).length,
    1,
  );
  const access = await render(AccessPanel, {
    peer: { ...peer, token: "owner" },
  });
  await dom.waitFor(() => button(access.container, "Revoke service access"));
  button(access.container, "Revoke service access").click();
  await dom.waitFor(
    () => !agent.container.textContent.includes("Your sample desk lamp"),
  );
  assert.equal(f.service.inspect()[0].status, "revoked");
});

test("denying access stops the queued read and exposes no sample result", async (t) => {
  const f = setup(t);
  const agent = await render(ServiceTools, { peer });
  await dom.waitFor(() => button(agent.container, "Check order status"));
  button(agent.container, "Check order status").click();
  await dom.waitFor(() => f.service.inspect().length);
  const phone = await render(Home, { peer: { ...peer, token: "owner" } });
  await dom.waitFor(() => button(phone.container, "Deny"));
  button(phone.container, "Deny").click();
  await dom.waitFor(() => agent.container.textContent.includes("not approved"));
  assert.equal(f.calls.filter((call) => call.route.endsWith("/run")).length, 0);
});

test("Tools works without browser permissions or browser endpoints", async (t) => {
  const f = setup(t);
  const view = await render(SavedTools, {
    peer,
    ended: () => {},
    servicesEnabled: true,
    browserEnabled: false,
  });
  await dom.waitFor(() => button(view.container, "Check order status"));
  assert.ok(f.calls.every((call) => call.route === "/api/browser/services"));
  assert.equal(
    view.container.querySelector('[aria-label="Tool browser"]'),
    null,
  );
  assert.ok(
    [
      ...view.container.querySelector('[aria-label="Filter tools"]').options,
    ].some((option) => option.value === "services"),
  );
});

test("switching agent connections drops a waiting automatic run", async (t) => {
  const f = setup(t);
  const view = await render(ServiceTools, { peer });
  await dom.waitFor(() => button(view.container, "Check order status"));
  button(view.container, "Check order status").click();
  await dom.waitFor(() => f.service.inspect().length);
  await view.unmount();
  views.delete(view);
  f.service.decide(() => f.owner, f.service.inspect()[0].id, {
    decision: "approve",
  });
  const next = await render(ServiceTools, {
    peer: { ...peer, token: "different" },
  });
  await settle(3200);
  assert.equal(f.calls.filter((call) => call.route.endsWith("/run")).length, 0);
  assert.ok(!next.container.textContent.includes("Completed"));
});

test("live service UI selects the browser, displays account results and tracks an order without handle entry", async (t) => {
  const native = [];
  const handle = "a0000000-0000-4000-8000-000000000001";
  const f = setup(
    t,
    createServiceConnectors({
      run: async (authorize, input) => {
        authorize();
        native.push(input);
        return {
          status: "completed",
          browser: input.browser,
          data:
            input.id === "builtin_walmart_find"
              ? {
                  orders: {
                    coverage: "visible_page",
                    more: true,
                    items: [
                      {
                        order: "ORDER-TEST",
                        handle,
                        expiresAt: Date.now() + 60000,
                      },
                    ],
                  },
                }
              : { tracking: "ORDER-TEST · In transit" },
        };
      },
    }),
  );
  f.client.policy.preset = "full";
  f.client.scopes.push("browser:screen", "browser:control", "browser:open");
  const view = await render(ServiceTools, { peer });
  await dom.waitFor(() => button(view.container, "Find orders"));
  assert.doesNotMatch(view.container.textContent, /sample|fictional/i);
  assert.equal(
    view.container.querySelectorAll("input").length,
    2,
    "search fields only; no handle or credential fields",
  );
  const card = button(view.container, "Find orders").closest("article");
  const browser = card.querySelector("select");
  browser.value = "Safari";
  browser.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle(30);
  const input = card.querySelector("input");
  Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set.call(input, "chair");
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle(30);
  button(card, "Find orders").click();
  await dom.waitFor(() => f.service.inspect().length);
  f.service.decide(() => f.owner, f.service.inspect()[0].id, {
    decision: "approve",
  });
  await dom.waitFor(() => button(card, "Track shipment"));
  assert.match(card.textContent, /visible page in Safari/);
  assert.match(card.textContent, /More results/);
  assert.deepEqual(native[0].values, { query: "chair" });
  assert.equal(native[0].browser, "Safari");
  button(card, "Track shipment").click();
  await dom.waitFor(() => card.textContent.includes("In transit"));
  assert.equal(native[1].id, "builtin_walmart_track");
  assert.deepEqual(native[1].values, { order: handle });
  assert.equal(native[1].browser, "Safari");
  assert.equal(f.calls.filter((c) => c.route.endsWith("/request")).length, 1);
});

test("browser service cards explain Agent Access restrictions and cannot request a grant from Read only", async (t) => {
  const f = setup(
    t,
    createServiceConnectors({ run: () => assert.fail("must not run") }),
  );
  const view = await render(ServiceTools, { peer });
  await dom.waitFor(() => button(view.container, "Find orders"));
  assert.equal(button(view.container, "Find orders").disabled, true);
  assert.equal(button(view.container, "Find messages").disabled, true);
  assert.match(view.container.textContent, /Agent Access/);
  assert.equal(f.service.inspect().length, 0);
});

test("a stale catalog uses an already approved service request immediately", async (t) => {
  const f = setup(t);
  // The catalog can lag another tab's owner approval. Hold this tab's refresh
  // to prove the request response itself drives the correct UI state.
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (run, ms, ...args) =>
    ms === 3000 ? 0 : interval(run, ms, ...args),
  );
  const view = await render(ServiceTools, { peer });
  await dom.waitFor(() => button(view.container, "Check order status"));
  const approval = f.service.request(() => f.client, {
    connectorId: SAMPLE_STORE.id,
    reason: "Check my sample order.",
  });
  f.service.decide(() => f.owner, approval.id, { decision: "approve" });
  button(view.container, "Check order status").click();
  await dom.waitFor(() => f.calls.filter((call) => call.route.endsWith("/request")).length === 1);
  await settle();
  assert.equal(f.calls.filter((call) => call.route.endsWith("/run")).length, 1);
  await dom.waitFor(() => view.container.textContent.includes("Your sample desk lamp"));
  assert.doesNotMatch(view.container.textContent, /automatically after approval/);
});
