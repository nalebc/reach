import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Rules for the tests themselves: a test fails only when Reach is wrong.
const root = fileURLToPath(new URL("..", import.meta.url));
const files = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".mjs")).map((f) => path.join(dir, f));
const tests = [...files("test"), ...files("test/journeys"), ...files("test/helpers")]
  .filter((f) => !f.endsWith("close-server.mjs") && !f.endsWith("test-hygiene.test.mjs"));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
// Comments blanked, line numbers kept (a comment naming server.close() isn't a call).
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (c, lead) => lead + " ".repeat(c.length - lead.length));

// A browser keeps connections that never send a request; a plain
// server.close() waits on them until Node's header timeout, while the browser
// holding them is closed by a later cleanup step (Oct 25: terminal-fit-chrome
// passed, then hung 180 s in cleanup on Intel macOS CI). A test that drives a
// browser closes its servers with closeServer (test/helpers/close-server.mjs),
// or cuts that server's connections right before closing it.
export function unsafeServerCloses(source) {
  if (!/headless-chrome\.mjs|helpers\/journey\.mjs|ios-launch\.mjs|simctl/.test(source)) return [];
  const text = code(source);
  const names = [...text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?https?\.create(?:Secure)?Server\b/g)].map((m) => m[1]);
  const found = [];
  for (const name of new Set(names))
    for (const m of text.matchAll(new RegExp(`\\b${name}\\.close\\(`, "g"))) {
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      // Safe: that server's connections cut first, or every socket it
      // accepted (tracked by the test) destroyed first.
      const cut = before.includes(`${name}.closeAllConnections()`) || before.includes(`${name}.closeAllConnections?.()`);
      const destroyed = /for \(const (\w+) of \w+\) \1\.destroy\(\)/.test(before);
      if (!cut && !destroyed) found.push({ name, line: lineOf(text, m.index) });
    }
  return found;
}

test("browser tests never close a server that a browser's idle connections can hold open", () => {
  const offenders = [];
  for (const file of tests)
    for (const hit of unsafeServerCloses(fs.readFileSync(path.join(root, file), "utf8")))
      offenders.push(`${file}:${hit.line} ${hit.name}.close(…) without closeServer or ${hit.name}.closeAllConnections()`);
  assert.deepEqual(offenders, [], "use closeServer(server) from test/helpers/close-server.mjs");
});

test("the server-close rule catches the unsafe form and accepts the safe ones", () => {
  const browser = 'import { launchChrome } from "./helpers/headless-chrome.mjs";\n';
  assert.deepEqual(unsafeServerCloses(`${browser}const server = http.createServer(h);\nt.after(() => new Promise((r) => server.close(r)));`).map((h) => h.name), ["server"]);
  assert.deepEqual(unsafeServerCloses(`${browser}const page = https.createServer(o, h);\npage.close();`).map((h) => h.name), ["page"]);
  assert.deepEqual(unsafeServerCloses(`${browser}const server = http.createServer(h);\nt.after(() => closeServer(server));`), []);
  assert.deepEqual(unsafeServerCloses(`${browser}const server = http.createServer(h);\nserver.closeAllConnections();\nawait new Promise((r) => server.close(r));`), []);
  assert.deepEqual(unsafeServerCloses(`${browser}const proxy = http.createServer(h);\nproxy.closeAllConnections?.();\nproxy.close();`), []);
  assert.deepEqual(unsafeServerCloses(`${browser}const server = http.createServer(h);\nfor (const s of open) s.destroy(); server.close(r);`), []);
  assert.deepEqual(unsafeServerCloses(`${browser}const server = http.createServer(h);\n// server.close() waited here\nclose(server);`), [], "a comment is not a call");
  // Without a browser, Node's own clients leave only idle sockets, which close() ends.
  assert.deepEqual(unsafeServerCloses("const server = http.createServer(h);\nserver.close();"), []);
});
