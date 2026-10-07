import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom,
  React,
  Files,
  pdfState,
  resetPdf,
  files = [],
  text = "",
  respond,
  calls,
  created,
  revoked,
  workers;
let sequence = 0;
const pdf = "%PDF-1.4\n% harmless preview fixture\n%%EOF\n";
const originalCreate = URL.createObjectURL,
  originalRevoke = URL.revokeObjectURL;
const originalWorker = globalThis.Worker;
before(async () => {
  dom = await startDom({
    fakes: { "pdfjs-dist": "test/dom/fakes/pdfjs.mjs" },
    routes: {
      "/api/files": () => ({ items: files }),
      "/api/files/icons": () => ({ icons: {} }),
      "/api/files/text": () => ({ text }),
      "/api/files/content": async (init, url) => {
        calls.push({ init, path: url.searchParams.get("path") });
        return respond(init, url);
      },
    },
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  globalThis.Worker = class {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.terminated = false;
      workers.push(this);
    }
    terminate() {
      this.terminated = true;
    }
  };
  URL.createObjectURL = (blob) => {
    const url = `blob:https://reach.test/preview-${++sequence}`;
    created.push({ url, blob });
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  React = dom.React;
  ({ state: pdfState, reset: resetPdf } = await dom.load(
    "/test/dom/fakes/pdfjs.mjs",
  ));
  ({ default: Files } = await dom.load("/src/Files.tsx"));
});
after(async () => {
  await dom?.close();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  if (originalWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = originalWorker;
});

async function show(
  name,
  {
    size = 80,
    token = `fixture-${++sequence}`,
    path = name,
    answer,
    pdfFailure,
    pageSize,
  } = {},
) {
  files = [
    { name, path, type: "file", size, modified: "2026-10-07T00:00:00.000Z" },
  ];
  calls = [];
  created = [];
  revoked = [];
  workers = [];
  resetPdf();
  pdfState.failure = pdfFailure;
  if (pageSize) pdfState.size = pageSize;
  respond =
    answer ||
    (() => new Response(pdf, { headers: { "Content-Type": "text/html" } }));
  const peer = {
    id: "viewer-fixture",
    name: "Fixture computer",
    url: "https://viewer.test",
    token,
  };
  const view = await dom.render(
    React.createElement(Files, {
      peer,
      peers: [peer],
      device: {
        name: peer.name,
        platform: "linux",
        roots: [{ id: 0, name: "Fixture files" }],
        capabilities: { files: true },
      },
      onSession() {},
      toast() {},
    }),
  );
  await dom.waitFor(() => view.container.querySelector(".file-main"));
  dom.update(() => view.container.querySelector(".file-main").click());
  await dom.waitFor(() => view.container.querySelector("dialog"));
  return view;
}
const close = async (view) => {
  dom.update(() =>
    view.container.querySelector('[aria-label="Close preview"]').click(),
  );
  await settle();
};

test("Markdown renders formatted text safely and toggles exact source", async () => {
  text =
    "# Notes\n\n**Useful** and `code`.\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert) [web](https://example.com/)\n";
  const view = await show("Notes.MD");
  await dom.waitFor(() =>
    view.container.querySelector(".file-viewer-markdown"),
  );
  assert.equal(
    view.container.querySelector(".file-viewer-markdown h1").textContent,
    "Notes",
  );
  assert.equal(
    view.container.querySelector(".file-viewer-markdown strong").textContent,
    "Useful",
  );
  assert.equal(
    view.container.querySelectorAll(
      ".file-viewer-markdown script, .file-viewer-markdown img",
    ).length,
    0,
  );
  assert.match(
    view.container.querySelector(".file-viewer-markdown").textContent,
    /<img src=x onerror=alert\(1\)>/,
  );
  const links = [...view.container.querySelectorAll(".file-viewer-markdown a")];
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://example.com/");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  dom.update(() =>
    view.container.querySelector('[aria-label="Show source"]').click(),
  );
  await dom.waitFor(() => view.container.querySelector(".file-code-source"));
  assert.equal(
    view.container.querySelector(".file-code-source").textContent,
    text,
  );
  assert.equal(
    view.container
      .querySelector('[aria-label="Show formatted"]')
      .getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(
    view.container
      .querySelector('[aria-label="Show source"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  dom.update(() =>
    view.container.querySelector('[aria-label="Show formatted"]').click(),
  );
  await dom.waitFor(() =>
    view.container.querySelector(".file-viewer-markdown"),
  );
  assert.ok(view.container.querySelector(".file-viewer-markdown"));
  assert.equal(
    calls.length,
    0,
    "Markdown does not download binary preview bytes",
  );
  await view.unmount();
});

test("Markdown files show nested lists, tasks, quotes, tables and fenced code", async () => {
  text =
    "# Project\n\n> A *useful* note\n\n- Parent\n  - Child\n\n- [x] Done\n- [ ] Next\n\n| Name | Value |\n| --- | ---: |\n| **Total** | 42 |\n\n```js\nconst answer = 42;\n```\n\n![remote](https://example.com/track.png)";
  const view = await show("README.markdown");
  const markdown = await dom.waitFor(() =>
    view.container.querySelector(".file-viewer-markdown"),
  );
  assert.equal(markdown.querySelector("blockquote em").textContent, "useful");
  assert.equal(markdown.querySelector("ul ul li").textContent, "Child");
  assert.equal(
    markdown.querySelectorAll('input[type="checkbox"]:disabled').length,
    2,
  );
  assert.equal(markdown.querySelector('input[type="checkbox"]').checked, true);
  assert.equal(markdown.querySelector("tbody strong").textContent, "Total");
  assert.equal(
    markdown.querySelector("pre .hljs-keyword").textContent,
    "const",
  );
  assert.equal(markdown.querySelector("img"), null);
  await view.unmount();
});

test("code files keep exact source, highlight syntax and separate line numbers", async () => {
  text =
    'const value = "<script>alert(1)</script>";\n// a note\nconsole.log(value);\n';
  const view = await show("app.ts");
  const source = await dom.waitFor(() =>
    view.container.querySelector(".file-code-source"),
  );
  assert.equal(source.textContent, text);
  assert.equal(source.querySelector(".hljs-keyword").textContent, "const");
  assert.equal(source.querySelector(".hljs-comment").textContent, "// a note");
  assert.equal(view.container.querySelector("script"), null);
  assert.equal(
    view.container.querySelector(".file-code-gutter").textContent,
    "1\n2\n3\n4",
  );
  assert.equal(
    view.container
      .querySelector(".file-code-gutter")
      .getAttribute("aria-hidden"),
    "true",
  );
  dom.update(() =>
    view.container.querySelector('[aria-label="Wrap lines"]').click(),
  );
  assert.ok(view.container.querySelector(".file-code.is-wrapped"));
  assert.equal(source.textContent, text);
  await view.unmount();
});

test("large code previews preserve source without expensive syntax parsing", async () => {
  text = `// ${"x".repeat(210_000)}`;
  const view = await show("large.js", { size: text.length });
  const source = await dom.waitFor(() =>
    view.container.querySelector(".file-code-source"),
  );
  assert.equal(source.textContent, text);
  assert.equal(source.querySelector("span"), null);
  await view.unmount();
});

test("PDF preview renders bounded data-only canvas pages and terminates its worker", async () => {
  const view = await show("Quarterly.pdf");
  await dom.waitFor(() =>
    view.container.querySelector(
      'canvas[data-rendered-page="1"]:not([hidden])',
    ),
  );
  assert.equal(view.container.querySelector("iframe, object, embed"), null);
  assert.equal(
    created.length,
    0,
    "PDF bytes never become a navigable document URL",
  );
  assert.equal(Buffer.from(pdfState.options[0].data).toString(), pdf);
  assert.equal(pdfState.options[0].url, undefined);
  assert.equal(pdfState.options[0].useWorkerFetch, false);
  assert.equal(pdfState.options[0].useWasm, false);
  assert.equal(pdfState.options[0].enableXfa, false);
  assert.equal(workers[0].options.type, "module");
  assert.ok(pdfState.pages[0].width * pdfState.pages[0].height <= 8_000_000);
  assert.equal(pdfState.pages[0].annotationMode, 0);
  assert.equal(calls.length, 1);
  dom.update(() =>
    view.container.querySelector('[aria-label="Next PDF page"]').click(),
  );
  await dom.waitFor(() =>
    view.container.querySelector(
      'canvas[data-rendered-page="2"]:not([hidden])',
    ),
  );
  assert.match(
    view.container.querySelector(".file-pdf-pages").textContent,
    /Page 2 of 2/,
  );
  assert.equal(
    view.container.querySelector('[aria-label="Next PDF page"]').disabled,
    true,
  );
  await close(view);
  assert.equal(workers[0].terminated, true);
  assert.ok(pdfState.destroyed > 0);
  dom.update(() => view.container.querySelector(".file-main").click());
  await dom.waitFor(() =>
    view.container.querySelector(
      'canvas[data-rendered-page="1"]:not([hidden])',
    ),
  );
  assert.equal(
    calls.length,
    1,
    "same credential may reuse its downloaded preview",
  );
  assert.equal(created.length, 0);
  await view.unmount();
  assert.ok(workers.every((worker) => worker.terminated));
});

test("preview cache cannot carry file bytes across credentials", async () => {
  const first = await show("Shared.pdf", { token: "credential-one" });
  await dom.waitFor(() =>
    first.container.querySelector(
      'canvas[data-rendered-page="1"]:not([hidden])',
    ),
  );
  await first.unmount();
  const second = await show("Shared.pdf", { token: "credential-two" });
  await dom.waitFor(() =>
    second.container.querySelector(
      'canvas[data-rendered-page="1"]:not([hidden])',
    ),
  );
  assert.equal(
    calls.length,
    1,
    "new credential must perform its own authorized fetch",
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer credential-two");
  await second.unmount();
});

test("a renamed HTML file is never embedded as a PDF", async () => {
  const view = await show("Forged.pdf", {
    answer: () => new Response("<script>alert(1)</script>"),
  });
  await dom.waitFor(() =>
    view.container.textContent.includes("This file is not a PDF"),
  );
  assert.equal(view.container.querySelector("iframe"), null);
  assert.equal(created.length, 0);
  assert.ok(view.container.querySelector('[aria-label="Download Forged.pdf"]'));
  await view.unmount();
});

test("oversized PDF rejects both listed size and a response larger than its listing", async () => {
  const large = await show("Large.pdf", { size: 50 * 1024 * 1024 + 1 });
  await dom.waitFor(() =>
    large.container.textContent.includes("too large to preview"),
  );
  assert.equal(calls.length, 0);
  await large.unmount();
  const changed = await show("Growing.pdf", {
    size: 10,
    answer: () =>
      new Response(pdf, {
        headers: { "Content-Length": String(50 * 1024 * 1024 + 1) },
      }),
  });
  await dom.waitFor(() =>
    changed.container.textContent.includes("too large to preview"),
  );
  assert.equal(created.length, 0);
  assert.equal(changed.container.querySelector("iframe"), null);
  await changed.unmount();
});

test("closing while PDF bytes arrive creates no late object URL", async () => {
  let finish;
  const view = await show("Slow.pdf", {
    answer: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await dom.waitFor(() => finish);
  await close(view);
  assert.equal(calls[0].init.signal.aborted, true);
  finish(new Response(pdf));
  await settle(60);
  assert.equal(created.length, 0);
  assert.equal(revoked.length, 0);
  assert.equal(view.container.querySelector("dialog"), null);
  await view.unmount();
});

test("image previews still use image MIME and release their object URL", async () => {
  const view = await show("Small.png", {
    answer: () => new Response(new Uint8Array([137, 80, 78, 71])),
  });
  await dom.waitFor(() =>
    view.container.querySelector(".file-viewer-body > img"),
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].blob.type, "image/png");
  await view.unmount();
  assert.deepEqual(revoked, [created[0].url]);
  assert.deepEqual(dom.errors, []);
});

test("PDF renderer failure keeps Download available and terminates its worker", async () => {
  const view = await show("Broken.pdf", {
    pdfFailure: new Error("Invalid PDF structure"),
  });
  await dom.waitFor(() => view.container.querySelector('[role="alert"]'));
  assert.match(view.container.textContent, /could not be previewed/);
  assert.ok(view.container.querySelector('[aria-label="Download Broken.pdf"]'));
  assert.equal(view.container.querySelector("canvas, iframe"), null);
  assert.ok(workers.every((worker) => worker.terminated));
  await view.unmount();
});

test("extreme PDF page dimensions cannot allocate an unbounded canvas", async () => {
  const view = await show("Tall.pdf", { pageSize: [100, 100000] });
  const canvas = await dom.waitFor(() =>
    view.container.querySelector(
      'canvas[data-rendered-page="1"]:not([hidden])',
    ),
  );
  assert.ok(canvas.width <= 4096 && canvas.height <= 4096);
  assert.ok(canvas.width * canvas.height <= 8_000_000);
  await view.unmount();
});

test("PDF auxiliary assets reject document-controlled paths and unknown kinds", async () => {
  const { PdfBinaryDataFactory } = await dom.load("/src/pdf-assets.ts");
  const assets = new PdfBinaryDataFactory();
  for (const request of [
    { kind: "standardFontDataUrl", filename: "../../api/device" },
    { kind: "cMapUrl", filename: "https://example.com/tracker" },
    { kind: "wasmUrl", filename: "quickjs-eval.wasm" },
  ])
    await assert.rejects(
      assets.fetch(request),
      /unsupported font or character map/,
    );
  assert.deepEqual(dom.errors, []);
});
