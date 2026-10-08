import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createAgentTools } from "../server/agent-tools.mjs";
import {
  validateToolDefinition,
  toolInputs,
  protocolDescription,
} from "../server/tool-protocol.mjs";
import { PREBUILT_TOOLS } from "../server/prebuilt-tools.mjs";
import {
  browserToolRequest,
  browserToolsFor,
  deterministicToolName,
} from "../server/browser-tools.mjs";
import { toolsFor, callTool } from "../scripts/mcp-server.mjs";
import {
  presetFixture,
  privateIngressTest,
} from "./helpers/preset-fixture.mjs";
import {
  toolBrowserFixture,
  toolApps,
  exampleTool,
} from "./helpers/tool-browser-fixture.mjs";

function setup(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tool-test-")),
    driver = toolBrowserFixture();
  let client = {
    id: "agent",
    name: "Test agent",
    kind: "agent",
    status: "accepted",
    expiresAt: Date.now() + 600000,
    policy: { browser: true, preset: "full", roots: [] },
    scopes: [
      "browser:read",
      "browser:open",
      "browser:control",
      "browser:screen",
    ],
  };
  const authorize = () => client;
  const desktop = {
    catalog: async (auth) => {
      auth();
      return toolApps;
    },
    withBrowser: async (_client, _app, auth, work) =>
      work(
        async () => {
          auth();
        },
        async () => {},
      ),
  };
  const config = { dataDir },
    options = {
      desktop,
      driver,
      waitMs: 250,
      runMs: 5000,
      pdf: async () => Buffer.from("%PDF-1.4 test snapshot").toString("base64"),
      ...extra,
    };
  let tools = createAgentTools(config, options);
  t.after(() => {
    tools.close();
    driver.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const run = (
    id,
    values = {},
    browser = "Chrome",
    requestId = crypto.randomUUID(),
  ) => tools.run(authorize, { id, values, browser, requestId });
  return {
    get tools() {
      return tools;
    },
    driver,
    dataDir,
    desktop,
    authorize,
    run,
    get client() {
      return client;
    },
    set client(value) {
      client = value;
    },
    restart() {
      tools.close();
      tools = createAgentTools(config, options);
    },
  };
}

test("every prebuilt tool and the protocol example use the identical definition validator", () => {
  for (const tool of PREBUILT_TOOLS)
    assert.deepEqual(validateToolDefinition(tool, { builtIn: true }), tool);
  assert.deepEqual(
    validateToolDefinition(protocolDescription().example),
    protocolDescription().example,
  );
  for (const edit of [
    { protocol: "reach.tool.v2" },
    { id: "builtin_fake" },
    { script: "alert(1)" },
    { origins: ["http://example.com"] },
    { origins: ["https://127.0.0.1"] },
    { origins: ["https://10.1.2.3"] },
    { origins: ["https://100.64.0.1"] },
    { origins: ["https://example.ts.net"] },
    { inputs: { browser: { type: "string", label: "Bad" } } },
    {
      steps: [
        { op: "navigate", url: "https://example.com/" },
        { op: "click", target: { role: "button" } },
      ],
    },
    { steps: [{ op: "execute", script: "anything" }] },
    { steps: [{ op: "constructor" }] },
    { steps: [{ op: "__proto__" }] },
  ])
    assert.throws(
      () => validateToolDefinition({ ...exampleTool(), ...edit }),
      /Invalid Reach tool/,
    );
  assert.throws(
    () =>
      toolInputs(
        { inputs: { item: { type: "handle", label: "Item" } } },
        { item: "-".repeat(36) },
      ),
    /supply Item/,
  );
});

for (const browser of ["Chrome", "Safari"])
  test(`${browser}: Gmail search → exact message → attachment → one saved draft, with idempotent replay`, async (t) => {
    const f = setup(t);
    const search = await f.run(
      "builtin_gmail_find",
      { query: "invoice October" },
      browser,
    );
    assert.equal(search.status, "completed", JSON.stringify(search));
    assert.equal(search.data.messages.coverage, "visible_page");
    const message = search.data.messages.items[0];
    assert.equal(message.subject, "Invoice October");
    const opened = await f.run(
      "builtin_gmail_open",
      { message: message.handle },
      browser,
    );
    assert.equal(opened.status, "completed", JSON.stringify(opened));
    const attachment = opened.data.attachments.items[0];
    assert.equal(attachment.filename, "invoice.pdf");
    const downloaded = await f.run(
      "builtin_gmail_attachment",
      { attachment: attachment.handle },
      browser,
    );
    assert.equal(downloaded.status, "completed", JSON.stringify(downloaded));
    const id = crypto.randomUUID(),
      values = {
        file: downloaded.data.file.handle,
        to: "owner@example.test",
        subject: "Here is the invoice",
        body: "Requested document",
      };
    const draft = await f.run("builtin_gmail_draft", values, browser, id);
    assert.equal(draft.status, "completed", JSON.stringify(draft));
    assert.equal(draft.data.draft_subject, values.subject);
    assert.equal(f.driver.counters.drafts, 1);
    assert.equal(f.driver.counters.attachments, 1);
    assert.deepEqual(
      await f.run("builtin_gmail_draft", values, browser, id),
      draft,
    );
    assert.equal(f.driver.counters.drafts, 1);
    const tab = f.driver.browsers.get(browser)[0];
    assert.equal(
      tab.dom.window.document.querySelector("[name=to]").value,
      values.to,
    );
    assert.equal(
      tab.dom.window.document.querySelector("[contenteditable=true]")
        .textContent,
      values.body,
    );
    assert.ok(!f.driver.calls.some((call) => call.target?.name === "Send"));
    const persisted = fs.readFileSync(
      path.join(f.dataDir, "agent-tool-runs.json"),
      "utf8",
    );
    assert.ok(
      !persisted.includes(values.subject) &&
        !persisted.includes(values.body) &&
        !persisted.includes(values.to),
    );
    assert.equal(
      fs.statSync(path.join(f.dataDir, "agent-tool-runs.json")).mode & 0o777,
      0o600,
    );
  });

for (const browser of ["Chrome", "Safari"])
  test(`${browser}: order handles produce a receipt snapshot and verified tracking`, async (t) => {
    const f = setup(t);
    const orders = await f.run(
      "builtin_walmart_find",
      { query: "chair" },
      browser,
    );
    assert.equal(orders.status, "completed", JSON.stringify(orders));
    const order = orders.data.orders.items[0];
    assert.equal(order.order, "ORDER-123");
    const receipt = await f.run(
      "builtin_walmart_receipt",
      { order: order.handle },
      browser,
    );
    assert.equal(receipt.status, "completed", JSON.stringify(receipt));
    assert.equal(receipt.data.file.mime, "application/pdf");
    assert.equal(
      fs.statSync(
        path.join(f.dataDir, "agent-tool-files", receipt.data.file.handle),
      ).mode & 0o777,
      0o600,
    );
    const refreshed = await f.run(
      "builtin_walmart_find",
      { query: "ORDER-123" },
      browser,
    );
    const tracking = await f.run(
      "builtin_walmart_track",
      { order: refreshed.data.orders.items[0].handle },
      browser,
    );
    assert.equal(tracking.status, "completed", JSON.stringify(tracking));
    assert.match(tracking.data.tracking, /Delivered/);
  });

test(
  "agents create, discover and execute a custom tool using the same catalog, browser bridge and MCP contract",
  privateIngressTest,
  async (t) => {
    const driver = toolBrowserFixture();
    t.after(() => driver.close());
    const f = await presetFixture(t, {
      desktopExtras: {
        catalog: async (auth) => {
          auth();
          return toolApps;
        },
        withBrowser: async (_client, _app, auth, work) =>
          work(async () => auth()),
      },
      browserToolOptions: { driver, waitMs: 250 },
    });
    const agent = await f.join({
      preset: "apps",
      apps: toolApps.map(({ id }) => ({ id })),
    });
    const api = async (route, method = "GET", body) => {
      const r = await agent.as(route, { method, body });
      assert.ok(r.status < 400, JSON.stringify(r));
      return r.body;
    };
    let access = await api("/api/browser");
    assert.deepEqual(access.browserTools.browsers, ["Chrome", "Safari"]);
    const protocol = await callTool(api, "reach_tool_protocol", {}, access);
    assert.equal(protocol.protocol, "reach.tool.v1");
    const definition = exampleTool();
    await callTool(api, "reach_define_tool", { definition }, access);
    access = await api("/api/browser");
    const name = deterministicToolName(definition);
    assert.ok(
      toolsFor(agent.joined.scopes, access).some((tool) => tool.name === name),
    );
    const requestId = crypto.randomUUID(),
      args = { browser: "Safari", requestId };
    const plan = browserToolRequest(name, args, access);
    assert.equal(plan.route, "/api/browser/tools/run");
    const result = await callTool(api, name, args, access);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.data.result, "Done");
    assert.deepEqual(await callTool(api, name, args, access), result);
    assert.equal(driver.counters.clicks, 1);
    assert.equal(
      (await api(`/api/browser/tools/operations/${requestId}`)).status,
      "completed",
    );
    assert.equal((await agent.as("/api/agents/tools")).status, 403);
    const owner = await f.call("/api/agents/tools");
    assert.equal(owner.status, 200);
    assert.ok(
      owner.body.tools.some((entry) => entry.definition.id === definition.id),
    );
    assert.equal(
      (
        await f.call(`/api/agents/tools/${definition.id}`, {
          method: "PATCH",
          body: { enabled: false },
        })
      ).status,
      200,
    );
    assert.ok(
      !(await api("/api/browser")).browserTools.tools.some(
        (tool) => tool.id === definition.id,
      ),
    );
  },
);

test("ambiguous tabs or elements stop without clicking, and passwords cannot be filled", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, exampleTool());
  const tab = f.driver.add("Chrome", "https://example.com/");
  const second = tab.dom.window.document
    .querySelector("button")
    .cloneNode(true);
  tab.dom.window.document.querySelector("main").append(second);
  const result = await f.run("example_task");
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "ambiguous");
  assert.equal(f.driver.counters.clicks, 0);
  f.driver.add("Chrome", "https://example.com/");
  const tabs = await f.run("example_task");
  assert.equal(tabs.code, "ambiguous");
  assert.equal(f.driver.counters.clicks, 0);
  const secure = exampleTool("secure_test");
  secure.inputs = { value: { type: "string", label: "Text" } };
  secure.steps = [
    { op: "navigate", url: "https://example.com/" },
    {
      op: "fill",
      target: { css: "input[type=password]" },
      value: { input: "value" },
    },
    { op: "assert", target: { role: "main" } },
  ];
  await f.tools.define(f.authorize, secure);
  const safari = f.driver.add("Safari", "https://example.com/");
  safari.dom.window.document.querySelector("input").type = "password";
  const protectedRun = await f.run(
    "secure_test",
    { value: "not-persisted" },
    "Safari",
  );
  assert.equal(protectedRun.status, "stopped");
  assert.equal(safari.dom.window.document.querySelector("input").value, "");
});

test("missing selectors and changed sites fail closed rather than inventing steps", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, exampleTool());
  const tab = f.driver.add("Chrome", "https://example.com/");
  tab.dom.window.document.querySelector("button").remove();
  const missing = await f.run("example_task");
  assert.equal(missing.code, "missing");
  assert.equal(f.driver.counters.clicks, 0);
  const wrong = exampleTool("wrong_site");
  wrong.steps[0].url = "https://evil.example/";
  await f.tools.define(f.authorize, wrong);
  const before = f.driver.calls.length;
  const result = await f.run("wrong_site");
  assert.equal(result.code, "wrong_site");
  assert.equal(f.driver.calls.length, before);
});

test("stale, changed-identity, cross-browser and cross-agent item handles are refused before clicks", async (t) => {
  const f = setup(t);
  const search = await f.run("builtin_gmail_find", { query: "invoice" });
  const handle = search.data.messages.items[0].handle;
  await assert.rejects(
    f.run("builtin_gmail_open", { message: handle }, "Safari"),
    /another browser/,
  );
  const original = f.client;
  f.client = { ...original, id: "other-agent" };
  await assert.rejects(
    f.run("builtin_gmail_open", { message: handle }),
    /another session/,
  );
  f.client = original;
  const tab = f.driver.browsers.get("Chrome")[0];
  tab.dom.window.document.querySelector(".bog").textContent =
    "Different invoice";
  const changed = await f.run("builtin_gmail_open", { message: handle });
  assert.equal(changed.code, "stale");
  assert.equal(f.driver.counters.clicks, 0);
  tab.dom.window.document.querySelector("tr").remove();
  const stale = await f.run("builtin_gmail_open", { message: handle });
  assert.equal(stale.code, "stale");
  assert.equal(f.driver.counters.clicks, 0);
});

test("definition IDs are immutable, hidden apps and view-only presets cannot gain browser tools", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, exampleTool());
  await assert.rejects(
    f.tools.define(f.authorize, exampleTool()),
    /already exists/,
  );
  f.client = {
    ...f.client,
    policy: {
      ...f.client.policy,
      hidden: toolApps.map(({ id, bundleId }) => ({ id, bundleId })),
    },
  };
  assert.deepEqual((await f.tools.catalog(f.authorize)).tools, []);
  await assert.rejects(f.run("example_task"), /allowed copy/);
  f.client = {
    ...f.client,
    policy: { ...f.client.policy, preset: "readonly" },
  };
  assert.throws(() => f.tools.protocol(f.authorize), /current screen/);
});

test("expired item and file handles, changed permission and owner interruption stop subsequent effects", async (t) => {
  let clock = Date.now();
  const f = setup(t, { now: () => clock });
  const search = await f.run("builtin_gmail_find", { query: "invoice" });
  clock += 300001;
  await assert.rejects(
    f.run("builtin_gmail_open", {
      message: search.data.messages.items[0].handle,
    }),
    /expired/,
  );
  clock = Date.now();
  await f.tools.define(f.authorize, exampleTool());
  f.driver.after = async (_browser, request) => {
    if (request.op === "assert")
      f.client = {
        ...f.client,
        policy: { ...f.client.policy, hidden: [toolApps[0]] },
      };
  };
  const revoked = await f.run("example_task");
  assert.equal(revoked.status, "stopped");
  assert.equal(revoked.code, "access_changed");
  assert.equal(f.driver.counters.clicks, 0);
});

test("lost acknowledgements, concurrent duplicate calls and restart recovery never replay an effect", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, exampleTool());
  const requestId = crypto.randomUUID();
  f.driver.after = async (_browser, request) => {
    if (request.op === "click")
      throw Object.assign(Error("Acknowledgement lost"), {
        uncertain: true,
        code: "uncertain",
      });
  };
  const uncertain = await f.run("example_task", {}, "Chrome", requestId);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(f.driver.counters.clicks, 1);
  assert.deepEqual(
    await f.run("example_task", {}, "Chrome", requestId),
    uncertain,
  );
  assert.equal(f.driver.counters.clicks, 1);
  await assert.rejects(
    f.run("example_task", { extra: "different" }, "Chrome", requestId),
    /different inputs/,
  );
  f.restart();
  const restored = await f.run("example_task", {}, "Chrome", requestId);
  assert.equal(restored.status, "uncertain");
  assert.equal(f.driver.counters.clicks, 1);
  f.driver.after = null;
  let release, entered;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    blocker = new Promise((resolve) => {
      release = resolve;
    });
  f.driver.before = async (_browser, request) => {
    if (request.op === "click") {
      entered();
      await blocker;
    }
  };
  const concurrentId = crypto.randomUUID(),
    first = f.run("example_task", {}, "Chrome", concurrentId);
  await ready;
  assert.equal(
    (await f.run("example_task", {}, "Chrome", concurrentId)).status,
    "running",
  );
  await assert.rejects(f.run("example_task"), /Another tool/);
  release();
  assert.equal((await first).status, "completed");
  assert.equal(f.driver.counters.clicks, 2);
});

test("setup failure reports needs_owner and never guesses a keyboard fallback", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, exampleTool());
  f.driver.before = async (_browser, request) => {
    if (request.op === "preflight")
      throw Object.assign(
        Error("Allow JavaScript from Apple Events is disabled"),
        { code: "setup_required" },
      );
  };
  const result = await f.run("example_task");
  assert.equal(result.status, "needs_owner");
  assert.equal(result.completedSteps, 0);
  assert.equal(f.driver.counters.clicks, 0);
  assert.deepEqual(
    f.driver.calls.map((call) => call.op),
    ["tabs", "preflight"],
  );
  assert.equal(f.driver.browsers.get("Chrome").length, 0);
  f.driver.before = null;
  const same = await f.run("example_task", {}, "Chrome", result.requestId);
  assert.equal(
    same.status,
    "needs_owner",
    "a recorded failure is never replayed under the same ID",
  );
  assert.equal(f.driver.calls.length, 2);
  assert.equal((await f.run("example_task")).status, "completed");
  assert.equal(f.driver.counters.clicks, 1);
});

test("missing Automation or a profile window stops before browser navigation, then a fresh run can succeed", async (t) => {
  const f = setup(t);
  const original = f.desktop.withBrowser;
  f.desktop.withBrowser = async () => {
    throw Object.assign(
      Error("The owner needs to allow Reach’s Terminal in macOS Automation."),
      { kind: "setup_required" },
    );
  };
  const denied = await f.run("builtin_open_walmart");
  assert.equal(denied.status, "needs_owner");
  assert.equal(denied.code, "setup_required");
  assert.equal(denied.completedSteps, 0);
  assert.equal(f.driver.calls.length, 0);
  f.desktop.withBrowser = original;
  f.driver.before = async (_browser, request) => {
    if (request.op === "preflight")
      throw Object.assign(Error("Open a Chrome profile window."), {
        code: "browser_window_required",
      });
  };
  const noWindow = await f.run("builtin_open_walmart");
  assert.equal(noWindow.status, "needs_owner");
  assert.equal(noWindow.completedSteps, 0);
  assert.deepEqual(
    f.driver.calls.map((call) => call.op),
    ["tabs", "preflight"],
  );
  f.driver.before = null;
  assert.equal((await f.run("builtin_open_walmart")).status, "completed");
});

test("the scripting check uses the matched Chrome profile window and preserves it through handle-based tools", async (t) => {
  const f = setup(t);
  f.driver.add("Chrome", "https://example.com/");
  const account = f.driver.add("Chrome", "https://www.walmart.com/orders");
  account.window = 77;
  f.driver.before = async (_browser, request) => {
    if (request.op === "preflight" && request.window !== 77)
      throw Object.assign(
        Error("Scripting is disabled in the other profile."),
        { code: "setup_required" },
      );
  };
  const result = await f.run("builtin_walmart_find", { query: "chair" });
  assert.equal(result.status, "completed");
  const tracked = await f.run("builtin_walmart_track", {
    order: result.data.orders.items[0].handle,
  });
  assert.equal(tracked.status, "completed");
  assert.deepEqual(
    f.driver.calls
      .filter((call) => call.op === "preflight")
      .map((call) => call.window),
    [77, 77],
  );
  assert.equal(f.driver.browsers.get("Chrome").length, 2);
});

test("a signed-out Walmart tracking form at the orders URL needs the owner before any task step", async (t) => {
  const f = setup(t);
  const tab = f.driver.add("Chrome", "https://www.walmart.com/orders");
  tab.dom.window.document.body.innerHTML =
    '<h1>Track your order</h1><input aria-label="Email address"><input aria-label="Order number"><button>View order status</button><h1>Sign in to do more with your account</h1><button>Sign in or create account</button>';
  const result = await f.run("builtin_open_walmart");
  assert.equal(result.status, "needs_owner");
  assert.equal(result.code, "login_required");
  assert.equal(result.completedSteps, 0);
  assert.match(result.error, /owner needs to sign in to Walmart/);
  assert.equal(f.driver.counters.clicks, 0);
  assert.equal(f.driver.browsers.get("Chrome").length, 1);
  f.driver.load(tab, "https://www.walmart.com/orders");
  assert.equal((await f.run("builtin_open_walmart")).status, "completed");
  tab.dom.window.document.body.insertAdjacentHTML(
    "beforeend",
    "<div hidden><h1>Sign in to do more with your account</h1><button>Sign in or create account</button></div>",
  );
  assert.equal(
    (await f.run("builtin_open_walmart")).status,
    "completed",
    "hidden sign-in templates do not block a signed-in workspace",
  );
});

test("existing drafts are preserved and missing or tampered file handles fail before composition", async (t) => {
  const f = setup(t);
  const orders = await f.run("builtin_walmart_find", { query: "chair" });
  const receipt = await f.run("builtin_walmart_receipt", {
    order: orders.data.orders.items[0].handle,
  });
  const values = {
    file: receipt.data.file.handle,
    to: "owner@example.test",
    subject: "Receipt",
    body: "Attached",
  };
  const gmail = f.driver.add(
    "Chrome",
    "https://mail.google.com/mail/u/0/#inbox",
  );
  const dialog = gmail.dom.window.document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.textContent = "Existing unsent draft";
  gmail.dom.window.document.body.append(dialog);
  const blocked = await f.run("builtin_gmail_draft", values);
  assert.equal(blocked.code, "unexpected");
  assert.equal(f.driver.counters.drafts, 0);
  assert.equal(dialog.isConnected, true);
  dialog.remove();
  const file = path.join(f.dataDir, "agent-tool-files", values.file);
  fs.unlinkSync(file);
  const secret = path.join(f.dataDir, "private-value.txt");
  fs.writeFileSync(secret, "secret");
  fs.symlinkSync(secret, file);
  const before = f.driver.calls.length;
  await assert.rejects(
    f.run("builtin_gmail_draft", values),
    /changed or disappeared/,
  );
  assert.equal(f.driver.calls.length, before);
  assert.equal(f.driver.counters.drafts, 0);
  await assert.rejects(
    f.run("builtin_gmail_draft", { ...values, file: crypto.randomUUID() }),
    /expired or belongs/,
  );
  assert.equal(f.driver.counters.drafts, 0);
});

test("declared empty results are distinguished from page drift, and hidden matches do not cause ambiguity", async (t) => {
  const f = setup(t),
    tab = f.driver.add(
      "Chrome",
      "https://mail.google.com/mail/u/0/#search/invoice",
    );
  tab.dom.window.document.querySelector("main").innerHTML =
    "No conversations found.";
  const empty = await f.run("builtin_gmail_find", { query: "invoice" });
  assert.equal(empty.status, "completed");
  assert.deepEqual(empty.data.messages.items, []);
  tab.dom.window.document.querySelector("main").textContent =
    "Unexpected new page";
  const drift = await f.run("builtin_gmail_find", { query: "invoice" });
  assert.equal(drift.status, "stopped");
  assert.equal(drift.code, "missing");
  await f.tools.define(f.authorize, exampleTool());
  const example = f.driver.add("Safari", "https://example.com/");
  const duplicate = example.dom.window.document
    .querySelector("button")
    .cloneNode(true);
  duplicate.hidden = true;
  example.dom.window.document.body.append(duplicate);
  assert.equal((await f.run("example_task", {}, "Safari")).status, "completed");
  assert.equal(f.driver.counters.clicks, 1);
});

test("downloads enforce the file limit; protected pages and cross-site controls cannot be used", async (t) => {
  const f = setup(t);
  const search = await f.run("builtin_gmail_find", { query: "invoice" }),
    opened = await f.run("builtin_gmail_open", {
      message: search.data.messages.items[0].handle,
    });
  const tab = f.driver.browsers.get("Chrome")[0];
  tab.dom.window.fetch = async () =>
    new Response("too large", {
      headers: { "Content-Length": String(9 * 1024 * 1024) },
    });
  const download = await f.run("builtin_gmail_attachment", {
    attachment: opened.data.attachments.items[0].handle,
  });
  assert.equal(download.code, "download_failed");
  assert.match(download.error, /file limit/);
  await f.tools.define(f.authorize, exampleTool());
  const example = f.driver.add("Safari", "https://example.com/");
  example.dom.window.document.title = "Password Manager";
  assert.equal((await f.run("example_task", {}, "Safari")).code, "protected");
  assert.equal(f.driver.counters.clicks, 1);
  const secret = exampleTool("secret_site");
  secret.origins = ["https://passwords.google.com"];
  secret.steps[0].url = "https://passwords.google.com/";
  await assert.rejects(f.tools.define(f.authorize, secret), /Password stores/);
});

test("a document reload with the same URL invalidates Safari handles, and revocation clears private files", async (t) => {
  const f = setup(t);
  const search = await f.run(
      "builtin_gmail_find",
      { query: "invoice" },
      "Safari",
    ),
    tab = f.driver.browsers.get("Safari")[0];
  delete tab.dom.window.__reach_tool_protocol_v1__;
  const stale = await f.run(
    "builtin_gmail_open",
    { message: search.data.messages.items[0].handle },
    "Safari",
  );
  assert.equal(stale.code, "stale");
  assert.equal(f.driver.counters.clicks, 0);
  const orders = await f.run("builtin_walmart_find", { query: "chair" }),
    receipt = await f.run("builtin_walmart_receipt", {
      order: orders.data.orders.items[0].handle,
    });
  const file = path.join(
    f.dataDir,
    "agent-tool-files",
    receipt.data.file.handle,
  );
  assert.equal(fs.existsSync(file), true);
  f.tools.cancelClient(f.client.id);
  assert.equal(fs.existsSync(file), false);
});

test("interrupted durable records recover as uncertain and a run time limit prevents a later click", async (t) => {
  const f = setup(t, { runMs: 150 });
  await f.tools.define(f.authorize, exampleTool());
  f.driver.before = async (_browser, request) => {
    if (request.op === "assert")
      await new Promise((resolve) => setTimeout(resolve, 180));
  };
  const limited = await f.run("example_task");
  assert.equal(limited.code, "time_limit");
  assert.equal(f.driver.counters.clicks, 0);
  const file = path.join(f.dataDir, "agent-tool-runs.json"),
    ledger = JSON.parse(fs.readFileSync(file));
  ledger[0].status = "running";
  fs.writeFileSync(file, JSON.stringify(ledger));
  f.restart();
  const recovered = f.tools.operation(f.authorize, limited.requestId);
  assert.equal(recovered.status, "uncertain");
  assert.equal(recovered.code, "interrupted");
  assert.equal(f.driver.counters.clicks, 0);
});

test("generic JSON tool creation validation rejects cycles, getters and unbounded arrays", () => {
  const access = {
    preset: "full",
    screen: true,
    control: true,
    open: true,
    roots: [],
    terminals: [],
  };
  const cycle = exampleTool();
  cycle.steps[0].extra = cycle;
  assert.throws(
    () =>
      browserToolRequest("reach_define_tool", { definition: cycle }, access),
    /deeply nested/,
  );
  const getter = exampleTool();
  Object.defineProperty(getter.inputs, "value", {
    enumerable: true,
    get() {
      throw Error("getter executed");
    },
  });
  assert.throws(
    () =>
      browserToolRequest("reach_define_tool", { definition: getter }, access),
    /plain/,
  );
  const large = exampleTool();
  large.steps[0].extra = Array(25).fill("x");
  assert.throws(
    () =>
      browserToolRequest("reach_define_tool", { definition: large }, access),
    /bounded/,
  );
});

test("an owner's disable remains effective for the current run after a quick re-enable", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, exampleTool());
  let release, entered;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    blocking = new Promise((resolve) => {
      release = resolve;
    });
  f.driver.before = async (_browser, request) => {
    if (request.op === "assert") {
      entered();
      await blocking;
    }
  };
  const run = f.run("example_task");
  await ready;
  f.tools.update("example_task", false);
  f.tools.update("example_task", true);
  release();
  const result = await run;
  assert.equal(result.status, "stopped");
  assert.equal(result.code, "access_changed");
  assert.equal(f.driver.counters.clicks, 0);
});
