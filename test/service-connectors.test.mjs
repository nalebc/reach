import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentServices } from "../server/agent-services.mjs";
import { createServiceConnectors } from "../server/service-connectors.mjs";
import { createAgentTools } from "../server/agent-tools.mjs";
import { browserToolsFor } from "../server/browser-tools.mjs";
import { agentRequestTimeout } from "../server/agent-transport.mjs";
import {
  FULL_CONTROL_VERSION,
  presetScopes,
} from "../server/agent-presets.mjs";
import {
  toolApps,
  toolBrowserFixture,
} from "./helpers/tool-browser-fixture.mjs";
import {
  presetFixture,
  privateIngressTest,
  apps,
} from "./helpers/preset-fixture.mjs";

// The browser and desktop adapters are synthetic on every operating system.
// Both platform catalogs still pass through production service/tool policy,
// schemas, interpreter, handles, consent and cancellation.
function fixture(t, platform) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "reach-service-browser-"),
  );
  const driver = toolBrowserFixture();
  const catalog = platform === "win32" ? [
    { id: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", name: "Google Chrome", bundleId: "exe:chrome.exe", running: true },
    { id: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", name: "Microsoft Edge", bundleId: "exe:msedge.exe", running: true },
  ] : toolApps;
  if (platform === "win32") {
    driver.browsers.delete("Safari");
    driver.browsers.set("Edge", []);
  }
  const client = {
    id: "agent",
    name: "Test agent",
    kind: "agent",
    status: "accepted",
    expiresAt: Date.now() + 600000,
    policy: {
      invite: true,
      browser: true,
      preset: "apps",
      roots: [],
      apps: catalog,
    },
    scopes: [
      "browser:read",
      "browser:screen",
      "browser:control",
      "browser:open",
    ],
  };
  const authorize = () => client,
    owner = () => ({ kind: "device", scopes: ["admin"] });
  const tools = createAgentTools(
    { dataDir },
    {
      driver,
      platform,
      waitMs: 100,
      runMs: 5000,
      desktop: {
        catalog: async (auth) => {
          auth();
          return catalog;
        },
        withBrowser: async (_client, _app, auth, work) =>
          work(
            async () => {
              auth();
            },
            async () => {},
          ),
      },
    },
  );
  const connectors = createServiceConnectors(tools, { platform });
  const services = createAgentServices({
    connectors,
    verifyClient: (id) => (id === client.id ? client : null),
  });
  const approve = (connectorId) =>
    services.decide(
      owner,
      services.request(authorize, { connectorId, reason: "Read my account" })
        .id,
      { decision: "approve" },
    );
  const run = (connectorId, action, values, requestId = crypto.randomUUID()) =>
    services.run(authorize, { connectorId, action, values, requestId });
  t.after(() => {
    services.close();
    tools.close();
    driver.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    client,
    authorize,
    owner,
    connectors,
    services,
    tools,
    driver,
    catalog,
    approve,
    run,
  };
}

for (const [platform, browser, otherBrowser] of [
  ["darwin", "Chrome", "Safari"], ["darwin", "Safari", "Chrome"],
  ["win32", "Chrome", "Edge"], ["win32", "Edge", "Chrome"],
]) {
const setup = t => fixture(t, platform);
test(`${platform}/${browser}: production registry contains real browser adapters only, with no example queries or orders`, (t) => {
  const f = setup(t),
    catalog = f.services.catalog(f.authorize);
  assert.deepEqual(
    catalog.connectors.map((c) => c.id),
    ["gmail", "walmart"],
  );
  assert.ok(
    catalog.connectors.every(
      (c) => c.transport === "browser" && !c.unavailable,
    ),
  );
  for (const connector of catalog.connectors) for (const action of connector.actions)
    assert.deepEqual(action.inputSchema.properties.browser.enum, platform === "win32" ? ["Chrome", "Edge"] : ["Chrome", "Safari"]);
  assert.doesNotMatch(JSON.stringify(catalog), /sample|fictional|DEMO-/i);
  assert.ok(
    catalog.connectors.every((c) =>
      c.actions.every((a) => !a.example.query && !a.example.order),
    ),
  );
  assert.equal(agentRequestTimeout("/api/browser/services/run", "POST"), 70000);
});

test(`${platform}/${browser}: Gmail service runs the browser interpreter with the chosen account; only verified subject/sender results are returned`, async (t) => {
  const f = setup(t);
  f.approve("gmail");
  const values = { browser, account: "2", query: "invoice" },
    id = crypto.randomUUID();
  const result = await f.run("gmail", "find", values, id);
  assert.equal(result.data.browser, browser);
  assert.equal(result.data.coverage, "visible_page");
  assert.equal(result.data.items[0].label, "Invoice October");
  assert.equal(result.data.items[0].detail, "sender@example.test");
  assert.ok(
    f.driver.calls.some(
      (call) => call.url === "https://mail.google.com/mail/u/2/#search/invoice",
    ),
  );
  assert.equal(f.driver.counters.clicks, 0);
  const count = f.driver.calls.length;
  assert.deepEqual(await f.run("gmail", "find", values, id), result);
  assert.equal(
    f.driver.calls.length,
    count,
    "lost response replay does not navigate again",
  );
});

test(`${platform}/${browser}: Full control runs the Gmail adapter directly using its invitation grant`, async (t) => {
  const f = setup(t);
  f.client.policy = {
    invite: true,
    browser: true,
    preset: "full",
    fullControlVersion: FULL_CONTROL_VERSION,
    roots: [],
  };
  f.client.scopes = presetScopes(f.client.policy);
  const result = await f.run("gmail", "find", {
    browser,
    account: "0",
    query: "invoice",
  });
  assert.equal(result.data.items[0].label, "Invoice October");
  const catalog = f.services.catalog(f.authorize);
  assert.ok(
    catalog.connectors.every(
      (connector) => connector.access.status === "approved",
    ),
  );
  const tools = browserToolsFor({ preset: "full", services: catalog });
  assert.equal(
    tools.find((tool) => tool.name === "reach_service_request")
      .approvalRequired,
    false,
  );
  assert.match(
    tools.find((tool) => tool.name === "reach_service_gmail_find").description,
    /Run directly/,
  );
  assert.ok(
    f.services.inspect().every((entry) => entry.approval === "invitation"),
  );
});

test(`${platform}/${browser}: Walmart selection tracks an actual interpreter handle and never accepts a handle from another browser`, async (t) => {
  const f = setup(t);
  f.approve("walmart");
  const found = await f.run("walmart", "find", {
    browser,
    query: "Blue chair",
  });
  const order = found.data.items[0].handle;
  await assert.rejects(
    f.run("walmart", "track", { browser: otherBrowser, order }),
    /browser|expired/i,
  );
  assert.equal(f.driver.counters.clicks, 0);
  const tracking = await f.run("walmart", "track", {
    browser,
    order,
  });
  assert.match(tracking.data.summary, /ORDER-123.*Delivered October 7/);
  assert.equal(f.driver.counters.clicks, 1);
  assert.deepEqual(Object.keys(tracking.data).sort(), ["browser", "summary"]);
});

test(`${platform}/${browser}: Files/Read only/hidden browser permissions cannot be bypassed by a service grant`, async (t) => {
  const f = setup(t);
  for (const preset of ["files", "readonly"]) {
    f.client.policy.preset = preset;
    const catalog = f.services.catalog(f.authorize);
    assert.ok(catalog.connectors.every((c) => c.unavailable));
    assert.ok(
      !browserToolsFor({ preset, services: catalog }).some(
        (tool) => tool.name === "reach_service_walmart_find",
      ),
    );
    assert.throws(() => f.approve("walmart"), /Agent Access/);
  }
  f.client.policy = { browser: true, preset: "full", hidden: f.catalog };
  assert.throws(() => f.approve("gmail"), /Agent Access/);
  assert.equal(f.driver.calls.length, 0);
});

test(`${platform}/${browser}: revoking service consent aborts the in-flight native browser call and releases no data`, async (t) => {
  const f = setup(t),
    grant = f.approve("gmail");
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  f.driver.transport = async (_browser, _request, { signal }) => {
    began(signal);
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(Error("cancelled")), {
        once: true,
      }),
    );
  };
  const running = f.run("gmail", "find", {
    browser,
    account: "0",
    query: "invoice",
  });
  const rejected = assert.rejects(running, /not approved|ended/);
  const signal = await started;
  f.services.decide(f.owner, grant.id, { decision: "revoke" });
  assert.equal(signal.aborted, true);
  await rejected;
  // Let the interpreter unwind after the manager's cancellation race.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.driver.counters.clicks, 0);
});

test(`${platform}/${browser}: login/setup failures yield guidance, never invented results or provider error details`, async (t) => {
  const f = setup(t);
  f.approve("gmail");
  f.driver.transport = async () => {
    throw Object.assign(Error("secret cookie in upstream response"), {
      code: "setup_required",
    });
  };
  await assert.rejects(
    f.run("gmail", "find", {
      browser,
      account: "0",
      query: "invoice",
    }),
    (error) => {
      if (platform === "win32") {
        assert.match(error.message, /extension/i);
        assert.doesNotMatch(error.message, /Apple Events|Mac/);
      } else assert.match(error.message, /Allow JavaScript from Apple Events/);
      assert.doesNotMatch(error.message, /secret|cookie/);
      return true;
    },
  );
});
}

test(
  "production HTTP wiring: Apps agent requests Gmail, phone approves, browser runs, revocation stops replay",
  privateIngressTest,
  async (t) => {
    const driver = toolBrowserFixture();
    t.after(() => driver.close());
    const f = await presetFixture(t, {
      browserToolOptions: { driver, waitMs: 100, runMs: 5000 },
      desktopExtras: {
        withBrowser: async (_client, _app, auth, work) =>
          work(
            async () => {
              auth();
            },
            async () => {},
          ),
      },
    });
    const agent = await f.join({
      preset: "apps",
      apps: [{ id: apps.chrome.id }],
    });
    const access = await agent.as("/api/browser");
    assert.deepEqual(
      access.body.services.connectors.map((c) => c.id),
      ["gmail", "walmart"],
    );
    const receipt = await agent.as("/api/browser/services/request", {
      method: "POST",
      body: { connectorId: "gmail", reason: "Search my mail" },
    });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    const route = `/api/agents/services/${receipt.body.id}`;
    assert.equal(
      (await f.call(route, { method: "POST", body: { decision: "approve" } }))
        .status,
      200,
    );
    const payload = {
      connectorId: "gmail",
      action: "find",
      values: { browser: "Chrome", account: "0", query: "invoice" },
      requestId: crypto.randomUUID(),
    };
    const result = await agent.as("/api/browser/services/run", {
      method: "POST",
      body: payload,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.items[0].label, "Invoice October");
    assert.equal(
      (await f.call(route, { method: "POST", body: { decision: "revoke" } }))
        .status,
      200,
    );
    assert.equal(
      (
        await agent.as("/api/browser/services/run", {
          method: "POST",
          body: payload,
        })
      ).status,
      403,
    );
    const full = await f.join({ name: "Trusted helper", preset: "full" });
    const direct = await full.as("/api/browser/services/run", {
      method: "POST",
      body: { ...payload, requestId: crypto.randomUUID() },
    });
    assert.equal(direct.status, 200, JSON.stringify(direct.body));
    assert.equal(direct.body.data.items[0].label, "Invoice October");
    const services = await full.as("/api/browser/services");
    assert.ok(
      services.body.connectors.every(
        (connector) => connector.access.status === "approved",
      ),
    );
    assert.ok(
      services.body.connectors.every(
        (connector) => connector.access.approval === "invitation",
      ),
    );
  },
);
