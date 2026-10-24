import { JSDOM } from "jsdom";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolPageOperation } from "../../server/tool-page-runtime.mjs";
import { toolBrowsersFor } from "../../server/tool-protocol.mjs";

// These models write private tool state just as the bootstrapped server does.
// Windows ignores mode 0600, and the runner's TEMP may inherit broad ACLs.
// Create only an owned private stage; never repair TEMP or the checkout.
// Other fixture users opt in explicitly, so importing this module adds no hooks.
export function toolPrivateStateParent(test) {
  let directory = process.platform === "win32" ? null : os.tmpdir();
  let stage;
  test.before(async () => {
    if (process.platform !== "win32") return;
    const [{ accountSid }, { createWindowsPrivateStage }] = await Promise.all([
      import("../../server/windows-private-folder.mjs"),
      import("../../server/windows-private-stage.mjs"),
    ]);
    const system = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
    const { stdout } = await promisify(execFile)(path.win32.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 10000 });
    stage = await createWindowsPrivateStage({ sid: accountSid(stdout) });
    directory = stage.dir;
  });
  test.after(async () => {
    if (stage) await fs.rm(stage.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return () => {
    if (!directory) throw Error("The tool fixture's private state stage is not ready.");
    return directory;
  };
}

export const toolApps = [
  {
    id: "/Applications/Google Chrome.app",
    name: "Google Chrome",
    bundleId: "com.google.Chrome",
    running: true,
  },
  {
    id: "/Applications/Safari.app",
    name: "Safari",
    bundleId: "com.apple.Safari",
    running: true,
  },
];
export const toolAppsFor = (platform) => platform === "win32" ? [
  { id: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, name: "Google Chrome", bundleId: "exe:chrome.exe", running: true },
  { id: String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`, name: "Microsoft Edge", bundleId: "exe:msedge.exe", running: true },
] : toolApps;

// The native browser transport is mocked; page operations use the real interpreter.
export function toolBrowserFixture({ platform = "darwin" } = {}) {
  const browsers = new Map(Object.keys(toolBrowsersFor(platform)).map(name => [name, []])),
    calls = [],
    counters = { clicks: 0, drafts: 0, attachments: 0 };
  let next = 1;
  const driver = {
    calls,
    counters,
    browsers,
    before: null,
    after: null,
    add(browser, url) {
      const tab = {
        window: browser === "Chrome" ? 1 : 2,
        tab: next++,
        index: browsers.get(browser).length + 1,
        url,
        title: "fixture",
      };
      tab.dom = new JSDOM("<html><body></body></html>", {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
      });
      const w = tab.dom.window;
      w.HTMLElement.prototype.getClientRects = () => [
        { width: 10, height: 10 },
      ];
      Object.defineProperty(w.HTMLElement.prototype, "isContentEditable", {
        get() {
          return (
            this.getAttribute("contenteditable") === "true" ||
            this.parentElement?.isContentEditable === true
          );
        },
      });
      const files = new WeakMap();
      Object.defineProperty(w.HTMLInputElement.prototype, "files", {
        get() {
          return files.get(this) || [];
        },
        set(value) {
          files.set(this, value);
        },
      });
      w.DataTransfer = class {
        constructor() {
          this.files = [];
          this.items = { add: (file) => this.files.push(file) };
        }
      };
      w.fetch = async () =>
        new Response("%PDF-1.4 fixture attachment", {
          headers: { "Content-Type": "application/pdf" },
        });
      browsers.get(browser).push(tab);
      this.load(tab, url);
      return tab;
    },
    load(tab, url) {
      // A site writing its own address back (Gmail: a search's spaces as +).
      url = this.rewrite?.(url) ?? url;
      tab.dom.reconfigure({ url });
      tab.url = url;
      const w = tab.dom.window,
        doc = w.document;
      // By the exact site, never a prefix (CodeQL #143, #144).
      const origin = URL.canParse(url) ? new URL(url).origin : "";
      if (origin === "https://mail.google.com") {
        const query = decodeURIComponent(
          new URL(url).hash.replace(/^#search\//, "").replace(/\+/g, " "),
        );
        doc.body.innerHTML =
          '<input aria-label="Search mail"><div role="button" aria-label="Compose">Compose</div><main><table><tbody><tr role="row"><td class="yW">sender@example.test</td><td class="bog">Invoice October</td></tr></tbody></table></main>';
        doc.querySelector("input").value = query;
        doc.querySelector("tr").onclick = () => {
          counters.clicks++;
          doc.querySelector("main").innerHTML =
            '<h2 class="hP">Invoice October</h2><a download="invoice.pdf" href="https://mail.google.com/download/invoice.pdf">Download</a>';
        };
        doc.querySelector("[role=button]").onclick = () => {
          counters.clicks++;
          counters.drafts++;
          const draft = doc.createElement("div");
          draft.setAttribute("role", "dialog");
          draft.innerHTML =
            '<input name="to"><input name="subjectbox"><div role="textbox" aria-label="Message Body" contenteditable="true"></div><input type="file" hidden>';
          doc.body.append(draft);
          draft.querySelector("[type=file]").onchange = (event) => {
            counters.attachments++;
            const name = doc.createElement("span");
            name.className = "vI";
            name.textContent = event.target.files[0].name;
            draft.append(name);
            const saved = doc.createElement("span");
            saved.setAttribute("role", "status");
            saved.setAttribute("aria-label", "Saved to Drafts");
            saved.textContent = "Saved to Drafts";
            draft.append(saved);
          };
        };
      } else if (origin === "https://www.walmart.com") {
        doc.body.innerHTML =
          '<h1>Purchase history</h1><section data-testid="order-card"><span data-testid="order-id">ORDER-123</span><p>Blue chair</p><a href="https://www.walmart.com/orders/123">View details</a><button>Track shipment</button></section>';
        doc.querySelector("a").onclick = (event) => {
          event.preventDefault();
          counters.clicks++;
          tab.dom.reconfigure({ url: "https://www.walmart.com/orders/123" });
          tab.url = w.location.href;
          doc.body.innerHTML =
            '<article data-testid="order-details"><span data-testid="order-id">ORDER-123</span> · Blue chair · $49 · Paid</article>';
        };
        doc.querySelector("button").onclick = () => {
          counters.clicks++;
          const status = doc.createElement("section");
          status.dataset.testid = "tracking-details";
          status.innerHTML =
            '<span data-testid="order-id">ORDER-123</span> · Delivered October 7';
          doc.body.append(status);
        };
      } else {
        doc.body.innerHTML =
          '<main><h1>Example Domain</h1><button>Do task</button><input aria-label="Note"><p id="result">Ready</p></main>';
        doc.querySelector("button").onclick = () => {
          counters.clicks++;
          doc.querySelector("#result").textContent = "Done";
        };
      }
    },
    find(browser, target) {
      const tab = browsers
        .get(browser)
        .find((tab) => tab.window === target.window && tab.tab === target.tab);
      if (!tab)
        throw Object.assign(Error("The selected tab is gone."), {
          code: "stale",
        });
      return tab;
    },
    info(tab) {
      return Object.fromEntries(
        ["window", "tab", "index", "url", "title"].map((key) => [
          key,
          tab[key],
        ]),
      );
    },
    async transport(browser, request) {
      calls.push({ browser, ...request });
      await this.before?.(browser, request);
      let result;
      if (request.op === "preflight") result = { ok: true };
      else if (request.op === "tabs")
        result = browsers.get(browser).map((tab) => this.info(tab));
      else if (request.op === "create")
        result = this.info(this.add(browser, request.url));
      else {
        const tab = this.find(browser, request.target);
        if (
          request.expectedURL !== undefined &&
          request.expectedURL !== tab.url
        )
          throw Object.assign(Error("The target tab changed."), {
            code: "stale",
          });
        if (request.op === "navigate") this.load(tab, request.url);
        result = this.info(tab);
        if (request.op === "close")
          browsers.set(browser, browsers.get(browser).filter((item) => item !== tab));
      }
      await this.after?.(browser, request, result);
      return result;
    },
    async page(browser, target, request) {
      calls.push({ browser, ...request });
      await this.before?.(browser, request);
      const tab = this.find(browser, target);
      if (tab.url !== target.url)
        throw Object.assign(Error("The target tab changed."), {
          code: "stale",
        });
      const result = JSON.parse(
        tab.dom.window.eval(
          `(${toolPageOperation.toString()})(${JSON.stringify(request)})`,
        ),
      );
      await this.after?.(browser, request, result);
      return result;
    },
    close() {
      for (const tabs of browsers.values())
        for (const tab of tabs) tab.dom.window.close();
    },
  };
  return driver;
}

export const exampleTool = (id = "example_task") => ({
  protocol: "reach.tool.v1",
  id,
  title: "Do example task",
  description: "Click the one matching button and check its result.",
  origins: ["https://example.com"],
  inputs: {},
  steps: [
    { op: "navigate", url: "https://example.com/" },
    { op: "assert", target: { role: "button", name: "Do task" } },
    { op: "click", target: { role: "button", name: "Do task" } },
    { op: "assert", target: { css: "#result", text: "Done" } },
    { op: "read", target: { css: "#result" }, as: "result" },
  ],
});
