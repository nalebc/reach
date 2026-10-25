import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  toolBrowserFixture,
  toolAppsFor,
  toolPrivateStateParent,
  exampleTool,
} from "./helpers/tool-browser-fixture.mjs";
import { createAgentTools } from "../server/agent-tools.mjs";
import {
  createToolBrowserDriver,
  nativeToolProcess,
} from "../server/tool-browser-driver.mjs";

const privateStateParent = toolPrivateStateParent(test);

test("exact nested identities reject similarly prefixed orders and result reads cannot cross panels", async (t) => {
  const driver = toolBrowserFixture({ platform: "darwin" });
  t.after(() => driver.close());
  const tab = driver.add("Safari", "https://www.walmart.com/orders/123"),
    document = crypto.randomUUID();
  tab.dom.window.document.body.innerHTML =
    '<article data-testid="order-details"><span data-testid="order-id">ORDER-1234</span><p>Wrong order</p></article>';
  await driver.page("Safari", driver.info(tab), {
    op: "bind",
    origins: ["https://www.walmart.com"],
    document,
  });
  const request = {
    op: "pdf",
    origins: ["https://www.walmart.com"],
    document,
    target: {
      css: '[data-testid="order-details"]',
      identity: { css: '[data-testid="order-id"]', equals: "ORDER-123" },
    },
  };
  assert.equal(
    (await driver.page("Safari", driver.info(tab), request)).code,
    "missing",
  );
  tab.dom.window.document.querySelector(
    '[data-testid="order-id"]',
  ).textContent = "ORDER-123";
  assert.match(
    (await driver.page("Safari", driver.info(tab), request)).text,
    /Wrong order/,
  );
  const duplicate = tab.dom.window.document
    .querySelector('[data-testid="order-id"]')
    .cloneNode(true);
  tab.dom.window.document.querySelector("article").append(duplicate);
  assert.equal(
    (await driver.page("Safari", driver.info(tab), request)).code,
    "ambiguous",
  );
});

test("exact input equality does not accept an older query with the same prefix", async (t) => {
  const driver = toolBrowserFixture({ platform: "darwin" });
  t.after(() => driver.close());
  const tab = driver.add(
      "Chrome",
      "https://mail.google.com/mail/u/0/#search/invoice",
    ),
    document = crypto.randomUUID();
  await driver.page("Chrome", driver.info(tab), {
    op: "bind",
    origins: ["https://mail.google.com"],
    document,
  });
  tab.dom.window.document.querySelector("input").value = "invoice November";
  const result = await driver.page("Chrome", driver.info(tab), {
    op: "wait",
    origins: ["https://mail.google.com"],
    document,
    target: { role: "textbox", name: "Search mail", equals: "invoice" },
  });
  assert.equal(result.code, "missing");
});

test("one acknowledged effect cannot be executed again even if the transport repeats the command", async (t) => {
  const driver = toolBrowserFixture({ platform: "darwin" });
  t.after(() => driver.close());
  const tab = driver.add("Chrome", "https://example.com/"),
    document = crypto.randomUUID();
  await driver.page("Chrome", driver.info(tab), {
    op: "bind",
    origins: ["https://example.com"],
    document,
  });
  const request = {
    op: "click",
    origins: ["https://example.com"],
    document,
    command: "same-command",
    target: { role: "button", name: "Do task" },
  };
  assert.equal(
    (await driver.page("Chrome", driver.info(tab), request)).applied,
    true,
  );
  assert.equal(
    (await driver.page("Chrome", driver.info(tab), request)).code,
    "uncertain",
  );
  assert.equal(driver.counters.clicks, 1);
});

test("the native driver sends only fixed interpreter source and uses stdin, including hostile literal text", async () => {
  const calls = [],
    driver = createToolBrowserDriver({
      platform: "darwin",
      process: async (...args) => {
        calls.push(args);
        return JSON.stringify({ text: "safe" });
      },
    });
  await driver.page(
    "Chrome",
    { window: "window", tab: "tab", url: "https://example.com/" },
    { op: "fill", value: "'); throw Error('unsafe'); // ` $()" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.equal(calls[0][1].length, 3);
  const data = JSON.parse(calls[0][2]);
  assert.equal(data.op, "evaluate");
  assert.equal(data.expectedURL, "https://example.com/");
  assert.match(data.source, /toolPageOperation/);
  assert.ok(!calls[0][1].some((arg) => arg.includes("unsafe")));
});

test("native failures redact diagnostic paths and retain useful setup or target messages", async () => {
  const rejected = async (message) => {
    let failure;
    try {
      await nativeToolProcess(
        process.execPath,
        [
          "-e",
          `process.stderr.write(${JSON.stringify(message)}); process.exitCode=1;`,
        ],
        "",
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.doesNotMatch(
      failure.message,
      /\/Users\/|tool-browser\.js|execution error/,
    );
    return failure;
  };
  const generic = await rejected(
    "/Users/sample/Reach/scripts/native/tool-browser.js: execution error: Error: Error: (-2700)",
  );
  assert.equal(generic.code, "browser_changed");
  assert.match(generic.message, /browser command failed/);
  assert.equal(
    (await rejected("execution error: Error: Error: (-10000)")).code,
    "browser_changed",
    "a general AppleEvent failure is not evidence of a disabled permission",
  );
  const setup = await rejected(
    "/Users/sample/Reach/scripts/native/tool-browser.js: execution error: JavaScript from Apple Events is disabled (-10000)",
  );
  assert.equal(setup.code, "setup_required");
  assert.equal(setup.status, 503);
  assert.match(setup.message, /owner needs to enable/);
  const target = await rejected(
    "/Users/sample/Reach/scripts/native/tool-browser.js: execution error: Error: The target document changed. No action was taken. (-2700)",
  );
  assert.equal(
    target.message,
    "The target document changed. No action was taken.",
  );
});

test("structured browser setup errors retain their code and service status", async () => {
  const driver = createToolBrowserDriver({
    platform: "darwin",
    process: async () =>
      JSON.stringify({
        error: "Enable Allow JavaScript from Apple Events.",
        code: "setup_required",
        uncertain: false,
      }),
  });
  await assert.rejects(
    driver.transport("Safari", { op: "preflight" }),
    (error) =>
      error.status === 503 &&
      error.code === "setup_required" &&
      error.uncertain !== true && /owner needs to enable/.test(error.message),
  );
});

test("native command timeout waits for process termination before freeing its caller", async () => {
  const start = Date.now();
  await assert.rejects(
    nativeToolProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      "",
      { timeoutMs: 120 },
    ),
    (error) => error.uncertain === true,
  );
  assert.ok(Date.now() - start >= 120);
});

for (const [platform, browser] of [["darwin", "Chrome"], ["win32", "Chrome"], ["win32", "Edge"]])
test(`${platform === "darwin" ? "" : `${platform} ${browser}: `}a whole tool deadline stops later effects and private results use a durable request record`, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(privateStateParent(), "reach-tool-kernel-")),
    driver = toolBrowserFixture({ platform });
  const client = {
    id: "a",
    name: "Agent",
    kind: "agent",
    expiresAt: Date.now() + 100000,
    policy: { browser: true, preset: "full" },
    scopes: ["browser:screen", "browser:control", "browser:open"],
  };
  const tools = createAgentTools(
    { dataDir },
    {
      driver,
      platform,
      runMs: 150,
      desktop: {
        catalog: async () => toolAppsFor(platform),
        withBrowser: async (_client, _app, auth, work) =>
          work(async () => auth()),
      },
    },
  );
  t.after(() => {
    tools.close();
    driver.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await tools.define(() => client, exampleTool());
  driver.before = async (_browser, request) => {
    if (request.op === "assert")
      await new Promise((resolve) => setTimeout(resolve, 180));
  };
  const requestId = crypto.randomUUID(),
    result = await tools.run(() => client, {
      id: "example_task",
      values: {},
      browser,
      requestId,
    });
  assert.equal(result.code, "time_limit");
  assert.equal(driver.counters.clicks, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "agent-tool-runs.json")))[0]
      .requestId,
    requestId,
  );
});

test(
  "native PDF renderer produces a readable multi-page snapshot without interpreting HTML",
  {
    skip: process.env.REACH_TEST_TOOL_PDF_BINARY
      ? false
      : "Set REACH_TEST_TOOL_PDF_BINARY to a compiled native helper",
  },
  async () => {
    const text =
      "ORDER-123 · $49\n<script>literal content</script>\n" +
      "Line of receipt details\n".repeat(150);
    const encoded = await nativeToolProcess(
      process.env.REACH_TEST_TOOL_PDF_BINARY,
      [],
      JSON.stringify({ text, source: "https://www.walmart.com/orders/123" }),
    );
    const bytes = Buffer.from(encoded, "base64");
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    });
    try {
      const pdf = await task.promise;
      assert.ok(pdf.numPages > 1);
      const page = await pdf.getPage(1);
      const content = (await page.getTextContent()).items
        .map((item) => item.str)
        .join(" ");
      assert.match(content, /ORDER-123/);
      assert.match(content, /<script>literal content<\/script>/);
    } finally {
      await task.destroy();
    }
  },
);
