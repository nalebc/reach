import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startDom } from "./dom/harness.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Node's own fetch, kept before the page harness replaces it.
const realFetch = globalThis.fetch;
let dom, reload;
before(async () => {
  dom = await startDom({ mobile: true });
  reload = await dom.load("/src/build-reload.ts");
});
after(() => dom?.close());
// These cases are a browser page Reach's offline copy serves, which may
// reload at once. A page without one (the iPhone and Android apps) has its
// own cases at the end.
const withCopy = { offlineCopy: () => true };

test("a page left open on an old phone interface reloads once Reach serves a new one, never mid-typing", () => {
  const { noteBuild, forgetBuild, busyHere } = reload;
  forgetBuild();
  let reloads = 0;
  const waits = [];
  const options = {
    ...withCopy,
    reload: () => reloads++,
    busy: () => busyHere(dom.document),
    wait: (f) => waits.push(f),
  };
  // The first build seen is this page's; the same again changes nothing.
  noteBuild("old", options);
  noteBuild("old", options);
  noteBuild(undefined, options);
  assert.equal(reloads, 0);
  // A message half written: the reload waits for it.
  const field = dom.document.createElement("textarea");
  field.value = "half a thought";
  dom.document.body.append(field);
  noteBuild("new", options);
  assert.equal(reloads, 0);
  assert.equal(waits.length, 1);
  // Sent (or cleared): the page takes the new interface, once.
  field.value = "";
  waits.shift()();
  assert.equal(reloads, 1);
  noteBuild("newer", options);
  assert.equal(reloads, 1);
  field.remove();
  // A question being answered or a sign-in under way counts as busy too.
  const card = dom.document.createElement("div");
  card.className = "sign-in";
  card.setAttribute("role", "group");
  dom.document.body.append(card);
  assert.equal(busyHere(dom.document), true);
  card.remove();
  assert.equal(busyHere(dom.document), false);
});

test("a restored old Home Screen page updates even when its first presence packet is the new build", async () => {
  reload.forgetBuild();
  let reloads = 0,
    busy = true;
  const waits = [];
  reload.noteBuild("new", {
    ...withCopy,
    reload: () => reloads++,
    busy: () => busy,
    wait: (f) => waits.push(f),
    currentPage: async () => false,
  });
  await Promise.resolve();
  assert.equal(reloads, 0);
  assert.equal(waits.length, 1);
  busy = false;
  waits.shift()();
  assert.equal(reloads, 1);
  reload.noteBuild("newer", { reload: () => reloads++ });
  assert.equal(reloads, 1);
});

test("page comparison detects changed hashed assets and tolerates offline responses", async () => {
  const doc = dom.document.implementation.createHTMLDocument();
  doc.head.innerHTML =
    '<script type="module" src="/assets/main-old.js"></script><link rel="stylesheet" href="/assets/main-old.css">';
  const { currentPageMatches } = reload;
  assert.equal(
    await currentPageMatches(doc, async (url, options) => {
      assert.equal(options.cache, "no-store");
      return new Response(
        '<script type="module" src="/assets/main-new.js"></script><link rel="stylesheet" href="/assets/main-new.css">',
      );
    }),
    false,
  );
  assert.equal(
    await currentPageMatches(
      doc,
      async () => new Response(doc.documentElement.outerHTML),
    ),
    true,
  );
  assert.equal(
    await currentPageMatches(doc, async () => {
      throw Error("offline");
    }),
    null,
  );
  assert.equal(await currentPageMatches(doc, async () => new Response(doc.documentElement.outerHTML,
    { headers: { "X-Reach-Cached-Shell": "old-complete-cohort" } })), null,
  "the saved interface cannot certify that the host still serves this build");
});

test("a saved interface is completed before reload, and failed saves retry without discarding the page", async () => {
  reload.forgetBuild();
  const waits = []; let attempts = 0, reloads = 0;
  const options = { busy: () => false, wait: fn => waits.push(fn), reload: () => reloads++,
    prepare: async () => ++attempts > 1, currentPage: async () => true };
  reload.noteBuild("old", options); await Promise.resolve();
  reload.noteBuild("new", options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reloads, 0); assert.equal(waits.length, 1); assert.equal(attempts, 1);
  waits.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reloads, 1); assert.equal(attempts, 2);
});

test("held preparation rechecks typing and cannot reload a retired update generation", async () => {
  for (const retired of [false, true]) {
    reload.forgetBuild();
    let finish, reloads = 0, busy = false; const waits = [];
    const options = { ...withCopy, busy: () => busy, wait: fn => waits.push(fn), reload: () => reloads++,
      prepare: () => new Promise(resolve => { finish = resolve; }), currentPage: async () => true };
    reload.noteBuild("old", options); await Promise.resolve(); reload.noteBuild("new", options);
    assert.equal(typeof finish, "function"); busy = true;
    if (retired) reload.forgetBuild();
    finish(true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reloads, 0);
    if (retired) assert.equal(waits.length, 0);
    else { assert.equal(waits.length, 1); busy = false; waits.shift()(); assert.equal(reloads, 1); }
  }
});

test("a failed initial page comparison retries on the next same-build presence packet", async () => {
  reload.forgetBuild();
  let checks = 0,
    reloads = 0;
  const options = {
    ...withCopy,
    reload: () => reloads++,
    busy: () => false,
    currentPage: async () => (++checks === 1 ? null : false),
  };
  reload.noteBuild("new", options);
  await Promise.resolve();
  assert.equal(reloads, 0);
  reload.noteBuild("new", options);
  await Promise.resolve();
  assert.equal(reloads, 1);
  assert.equal(checks, 2);
});

test(
  "Reach's live connection says which phone interface it serves",
  { timeout: 15000 },
  async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "reach-build-"));
    const reach = await createReach({
      roots: [dir],
      dataDir: path.join(dir, ".reach"),
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const socket = new WebSocket(
      `ws://127.0.0.1:${reach.server.address().port}/ws/presence`,
    );
    try {
      await once(socket, "open");
      const reply = once(socket, "message");
      socket.send(
        JSON.stringify({
          type: "auth",
          token: reach.auth.issue("My phone", ALL_SCOPES).token,
          kind: "phone",
        }),
      );
      const [value] = await reply;
      const html = new URL("../dist/index.html", import.meta.url);
      const expected = fs.existsSync(html)
        ? crypto
            .createHash("sha256")
            .update(fs.readFileSync(html))
            .digest("base64url")
            .slice(0, 12)
        : undefined;
      assert.equal(JSON.parse(value.toString()).changes?.build, expected);
    } finally {
      socket.close();
      reach.server.close();
      await reach.close?.();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  },
);

test("lazy workspace styles do not make a current public-start page reload forever", async () => {
  const doc = dom.document.implementation.createHTMLDocument();
  doc.head.innerHTML =
    '<script type="module" src="/assets/start-current.js"></script><link rel="stylesheet" href="/assets/start-current.css"><link rel="stylesheet" href="/assets/workspace-lazy.css">';
  const page =
    '<script type="module" src="/assets/start-current.js"></script><link rel="stylesheet" href="/assets/start-current.css">';
  assert.equal(
    await reload.currentPageMatches(doc, async () => new Response(page)),
    true,
  );
  assert.equal(
    await reload.currentPageMatches(
      doc,
      async () =>
        new Response(page.replace("start-current.css", "start-new.css")),
    ),
    false,
  );
});

test("foreground, page restore, online, and periodic checks work without presence packets and clean up", () => {
  const win = new dom.window.EventTarget(),
    doc = new dom.window.EventTarget();
  doc.hidden = false;
  let checks = 0,
    tick,
    cleared = 0;
  const stop = reload.watchInterfaceUpdates({
    doc,
    win,
    check: () => checks++,
    every: (f) => {
      tick = f;
      return 42;
    },
    clear: (id) => {
      assert.equal(id, 42);
      cleared++;
    },
  });
  assert.equal(checks, 1);
  for (const event of ["pageshow", "focus", "online"])
    win.dispatchEvent(new dom.window.Event(event));
  doc.dispatchEvent(new dom.window.Event("visibilitychange"));
  tick();
  assert.equal(checks, 6);
  doc.hidden = true;
  tick();
  win.dispatchEvent(new dom.window.Event("focus"));
  assert.equal(checks, 6);
  stop();
  doc.hidden = false;
  win.dispatchEvent(new dom.window.Event("online"));
  assert.equal(checks, 6);
  assert.equal(cleared, 1);
});

test("automatic checks retry after offline, expose waiting state, and apply only once when idle", async () => {
  reload.forgetBuild();
  let checks = 0,
    applied = 0,
    busy = true;
  const waits = [];
  const options = {
    ...withCopy,
    currentPage: async () => (++checks === 1 ? null : false),
    reload: () => applied++,
    busy: () => busy,
    wait: (f) => waits.push(f),
  };
  reload.checkForUpdates(options);
  await Promise.resolve();
  assert.equal(reload.getUpdateState(), "offline");
  reload.checkForUpdates(options);
  await Promise.resolve();
  assert.equal(reload.getUpdateState(), "waiting");
  assert.equal(applied, 0);
  busy = false;
  waits.shift()();
  assert.equal(applied, 1);
  assert.equal(reload.getUpdateState(), "reloading");
  reload.checkForUpdates(options);
  assert.equal(applied, 1);
});

test("fresh reload preserves the existing origin, path, parameters and pairing fragment", () => {
  const url = new URL(
    reload.freshInterfaceUrl(
      "https://mac.example.ts.net:8443/guest?view=files#pair=12345678",
      42,
    ),
  );
  assert.equal(url.origin, "https://mac.example.ts.net:8443");
  assert.equal(url.pathname, "/guest");
  assert.equal(url.searchParams.get("view"), "files");
  assert.equal(url.searchParams.get("reach-update"), "42");
  assert.equal(url.hash, "#pair=12345678");
});

test("a stalled network check times out so later foreground checks can recover", async () => {
  const doc = dom.document.implementation.createHTMLDocument();
  doc.head.innerHTML =
    '<script type="module" src="/assets/main-old.js"></script>';
  assert.equal(
    await reload.currentPageMatches(
      doc,
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(Error("offline")), {
            once: true,
          });
        }),
      { timeoutMs: 5 },
    ),
    null,
  );
  assert.equal(
    await reload.currentPageMatches(
      doc,
      async () =>
        new Response(
          '<script type="module" src="/assets/main-new.js"></script>',
        ),
    ),
    false,
  );
});

test("a page in use waits for its update: until it's put away or left untouched for a few minutes", () => {
  const { inUse, IDLE_MS } = reload;
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  const now = Date.now();
  assert.equal(inUse(dom.document, now), true, "just scrolled: reading");
  assert.equal(inUse(dom.document, now + IDLE_MS + 1000), false, "untouched for a while");
  assert.equal(inUse({ hidden: true }, now), false, "in the background");
});

// The iPhone and Android apps' web view has no offline copy. A reload started
// as the phone locked or woke, its network not back, failed there and left a
// blank white page until the app was closed and opened again (Oct 26).
const settle = () => new Promise((resolve) => setImmediate(resolve));
test("without an offline copy, a page put away never reloads; in front and free, only once the new page answers", async () => {
  reload.forgetBuild();
  let reloads = 0, away = true, answer = false, asked = 0;
  const waits = [];
  const options = {
    offlineCopy: () => false,
    away: () => away,
    busy: () => false,
    wait: (f) => waits.push(f),
    reload: () => reloads++,
    currentPage: async () => true,
    answers: async () => { asked++; return answer; },
  };
  reload.noteBuild("old", options);
  await Promise.resolve();
  reload.noteBuild("new", options);
  assert.equal(reloads, 0, "put away: no reload");
  assert.equal(asked, 0, "nothing asked of the network while put away");
  assert.equal(waits.length, 1);
  assert.equal(reload.getUpdateState(), "waiting");
  // Being put away again starts nothing more.
  dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(waits.length, 1);
  // In front, but the network isn't back yet: asked, kept, tried again later.
  away = false;
  waits.shift()();
  await settle();
  assert.equal(asked, 1);
  assert.equal(reloads, 0, "no reload into a page that doesn't answer");
  assert.equal(waits.length, 1);
  // It answers: one reload.
  answer = true;
  waits.shift()();
  await settle();
  assert.equal(reloads, 1);
  assert.equal(reload.getUpdateState(), "reloading");
  reload.noteBuild("newer", options);
  assert.equal(reloads, 1);
});

test("without an offline copy, a page put away or taken up while its new page answers keeps the old one for now", async () => {
  for (const change of ["away", "busy"]) {
    reload.forgetBuild();
    let reloads = 0, away = false, busy = false, finish;
    const waits = [];
    const options = {
      offlineCopy: () => false,
      away: () => away,
      busy: () => busy,
      wait: (f) => waits.push(f),
      reload: () => reloads++,
      currentPage: async () => true,
      answers: () => new Promise((resolve) => { finish = resolve; }),
    };
    reload.noteBuild("old", options);
    await Promise.resolve();
    reload.noteBuild("new", options);
    assert.equal(typeof finish, "function", "the new page is asked for while in front and free");
    if (change === "away") away = true;
    else busy = true;
    finish(true);
    await settle();
    assert.equal(reloads, 0, `${change}: no reload`);
    assert.equal(waits.length, 1, `${change}: it waits`);
    away = busy = false;
    waits.shift()();
    await settle();
    finish(true);
    await settle();
    assert.equal(reloads, 1, `${change}: reloads once free and in front`);
  }
});

test("a page with an offline copy still reloads as it's put away", () => {
  reload.forgetBuild();
  let reloads = 0;
  const options = { offlineCopy: () => true, away: () => true, busy: () => false, wait: () => {}, reload: () => reloads++ };
  reload.noteBuild("old", options);
  reload.noteBuild("new", options);
  assert.equal(reloads, 1);
});

test("the new page answers only when the computer serves it: not an error, not the offline copy, not a stalled or closed connection", async (t) => {
  const http = await import("node:http");
  let mode = "ok";
  const asked = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    asked.push(new URL(req.url, "http://x").searchParams.has("reach-update"));
    if (mode === "stall") return;
    if (mode === "error") return res.writeHead(503).end();
    res.writeHead(200, mode === "copy" ? { "X-Reach-Cached-Shell": "1" } : {}).end("<!doctype html>");
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const href = `http://127.0.0.1:${server.address().port}/files#pair=12345678`;
  const close = () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); });
  t.after(() => server.listening && close());
  assert.equal(await reload.pageAnswers(href, realFetch), true, "served");
  assert.deepEqual(asked, [true], "asked for the fresh page, as the reload will be");
  mode = "error";
  assert.equal(await reload.pageAnswers(href, realFetch), false, "an error page");
  mode = "copy";
  assert.equal(await reload.pageAnswers(href, realFetch), false, "the offline copy");
  mode = "stall";
  assert.equal(await reload.pageAnswers(href, realFetch, 200), false, "no reply in time");
  await close();
  assert.equal(await reload.pageAnswers(href, realFetch), false, "nothing listening");
});
