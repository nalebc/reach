import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import {
  createPublicStart,
  readTailnetManifest,
  PUBLIC_CSP,
} from "../server/public-start.mjs";

// What the public internet (Tailscale Funnel) gets: fixed files, nothing
// else. These tests pin exactly what it will and won't serve. (Reach's own
// listener hands it the internet's requests: test/one-address.test.mjs.)
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-public-"));
  const dist = path.join(dir, "dist");
  const tailnet = path.join(dir, "tailnet");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.mkdirSync(tailnet);
  fs.writeFileSync(path.join(dist, "start.html"), "<!doctype html>start");
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>app");
  fs.writeFileSync(path.join(dist, "agent.html"), "<!doctype html>browser agent");
  fs.writeFileSync(path.join(dist, "favicon.svg"), "<svg/>");
  fs.writeFileSync(path.join(dist, "sw.js"), "// notifications only");
  fs.writeFileSync(path.join(dist, "agent.mjs"), "// reach for agents");
  fs.writeFileSync(path.join(dist, "assets", "start-abc.js"), "console.log(1)");
  fs.writeFileSync(path.join(dist, "assets", "start-abc.js.br"), "BR");
  fs.writeFileSync(path.join(tailnet, "reach-tailnet.1234.wasm"), "WASM");
  fs.writeFileSync(path.join(tailnet, "reach-tailnet.1234.wasm.br"), "WBR");
  fs.writeFileSync(path.join(tailnet, "wasm_exec.5678.js"), "go()");
  fs.writeFileSync(
    path.join(tailnet, "tailnet.json"),
    JSON.stringify({
      wasm: "reach-tailnet.1234.wasm",
      exec: "wasm_exec.5678.js",
      source: "x",
    }),
  );
  fs.writeFileSync(path.join(dir, "secret.txt"), "private");
  return { dir, dist, tailnet };
}

async function serve(t, privateOrigin = "https://mac.tail1.ts.net:8443") {
  const f = fixture();
  const server = createPublicStart({
    dist: f.dist,
    tailnetDir: f.tailnet,
    privateOrigin,
    name: "Mac",
    instance: "inst-1",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  });
  const { port } = server.address();
  // Raw HTTP so paths reach the server exactly as written.
  const raw = (line, headers = {}) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("end", () => resolve(data));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
      const all = { Host: "mac.tail1.ts.net", Connection: "close", ...headers };
      socket.write(
        `${line} HTTP/1.1\r\n${Object.entries(all)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
    });
  const get = async (pathname, headers) => {
    const text = await raw(`GET ${pathname}`, headers);
    const [head, ...rest] = text.split("\r\n\r\n");
    const status = Number(head.split(" ")[1]);
    const h = Object.fromEntries(
      head
        .split("\r\n")
        .slice(1)
        .map((l) => [
          l.split(":")[0].toLowerCase(),
          l.slice(l.indexOf(":") + 1).trim(),
        ]),
    );
    return { status, headers: h, body: rest.join("\r\n\r\n") };
  };
  return { get, raw, f };
}

test("automatic private ports remain reachable from the browser entry's security policy", async (t) => {
  const { get } = await serve(t, "https://mac.tail1.ts.net:8444");
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.ok(page.headers["content-security-policy"].includes("https://mac.tail1.ts.net:8444"));
  assert.ok(page.headers["content-security-policy"].includes("wss://mac.tail1.ts.net:8444"));
  assert.ok(!page.headers["content-security-policy"].includes("https://*.ts.net:*"));
});

test("serves the start page, its config and the browser client, nothing else", async (t) => {
  const served = await serve(t);
  const { get } = served;
  for (const p of ["/", "/guest", "/?pair=1"]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.body, "<!doctype html>start");
    assert.equal(r.headers["cache-control"], "no-cache");
    assert.equal(r.headers["content-security-policy"], PUBLIC_CSP);
    assert.equal(r.headers["x-frame-options"], "DENY");
  }
  // /agent: an agent's link. A browser gets the start page (which says
  // what the link is for) with the steps in it; a program gets the steps
  // (test/agent-link-steps.test.mjs).
  const page = await get("/agent", { Accept: "text/html" });
  assert.equal(page.status, 200);
  assert.match(page.body, /^<!doctype html>start<section id="agent-steps"/);
  assert.equal(page.headers["content-security-policy"], PUBLIC_CSP);
  const steps = await get("/agent");
  assert.equal(steps.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(steps.body, /^Reach: connect an AI agent to this /);
  assert.match(PUBLIC_CSP, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(PUBLIC_CSP, /frame-ancestors 'none'/);
  const browserAgent = await get("/agent-browser");
  assert.equal(browserAgent.status, 200);
  assert.equal(browserAgent.body, "<!doctype html>browser agent");
  assert.equal(browserAgent.headers["cache-control"], "no-store");
  const config = await get("/reach-start.json");
  assert.equal(config.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(config.body), {
    product: "Reach",
    origin: "https://mac.tail1.ts.net:8443",
    name: "Mac",
    instance: "inst-1",
    since: 0,
    tailnet: { wasm: "reach-tailnet.1234.wasm", exec: "wasm_exec.5678.js" },
  });
  const wasm = await get("/tailnet/reach-tailnet.1234.wasm", {
    "Accept-Encoding": "gzip, br",
  });
  assert.equal(wasm.status, 200);
  assert.equal(wasm.body, "WBR");
  assert.equal(wasm.headers["content-encoding"], "br");
  assert.equal(wasm.headers["content-type"], "application/wasm");
  assert.equal(
    wasm.headers["cache-control"],
    "public, max-age=31536000, immutable",
  );
  const plain = await get("/assets/start-abc.js");
  assert.equal(plain.body, "console.log(1)");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal((await get("/favicon.svg")).status, 200);
  const worker = await get("/sw.js");
  assert.equal(worker.status, 200);
  assert.equal(worker.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(worker.headers["cache-control"], "no-cache");
  // What an invited agent downloads and runs: always the current one.
  const agent = await get("/agent.mjs");
  assert.equal(agent.status, 200);
  assert.equal(agent.body, "// reach for agents");
  assert.equal(agent.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(agent.headers["cache-control"], "no-cache");
  // A runtime it served, by its hash (a line from `keep` names one), and
  // nothing else under that folder (connections audit, Oct 10).
  const kept = "ab".repeat(32);
  const { dist } = served.f;
  fs.mkdirSync(path.join(dist, "agent-runtimes"), { recursive: true });
  fs.writeFileSync(path.join(dist, "agent-runtimes", `${kept}.mjs`), "// kept");
  const byHash = await get(`/agent-runtimes/${kept}.mjs`);
  assert.equal(byHash.status, 200);
  assert.equal(byHash.body, "// kept");
  for (const p of [`/agent-runtimes/${"cd".repeat(32)}.mjs`, "/agent-runtimes/", `/agent-runtimes/${kept}`, "/agent-runtimes/../agent.mjs", `/agent-runtimes/${kept.toUpperCase()}.mjs`])
    assert.equal((await get(p)).status, 404, p);
});

test("refuses the API, WebSockets, other methods, other hosts and path tricks", async (t) => {
  const { get, raw } = await serve(t);
  for (const p of [
    "/api/health",
    "/api/auth/method",
    "/ws/screen",
    "/index.html",
    "/assets/../secret.txt",
    "/assets/%2e%2e%2fsecret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/tailnet/../tailnet.json",
    "/tailnet/tailnet.json/",
    "/assets/",
    "/../secret.txt",
    "//etc/passwd",
  ]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /private|app/, p);
  }
  assert.equal((await get("/", { Host: "evil.example" })).status, 421);
  assert.equal(Number((await raw("POST /")).split(" ")[1]), 405);
  assert.equal(Number((await raw("PUT /reach-start.json")).split(" ")[1]), 405);
  const upgrade = await raw("GET /ws/screen", {
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  });
  assert.doesNotMatch(upgrade, /101 Switching/);
  // Funnel-marked requests get the same public files and nothing more.
  const funnel = await get("/api/health", { "Tailscale-Funnel-Request": "?1" });
  assert.equal(funnel.status, 404);
  assert.equal(
    (await get("/", { "Tailscale-Funnel-Request": "?1" })).status,
    200,
  );
});

test("the browser client manifest must name existing, plain files", () => {
  const f = fixture();
  try {
    assert.deepEqual(readTailnetManifest(f.tailnet), {
      wasm: "reach-tailnet.1234.wasm",
      exec: "wasm_exec.5678.js",
    });
    fs.writeFileSync(
      path.join(f.tailnet, "tailnet.json"),
      JSON.stringify({ wasm: "../secret.txt", exec: "wasm_exec.5678.js" }),
    );
    assert.equal(readTailnetManifest(f.tailnet), null);
    fs.writeFileSync(
      path.join(f.tailnet, "tailnet.json"),
      JSON.stringify({ wasm: "missing.wasm", exec: "wasm_exec.5678.js" }),
    );
    assert.equal(readTailnetManifest(f.tailnet), null);
    assert.equal(readTailnetManifest(path.join(f.dir, "nope")), null);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("without a built client the config says so (phones are told to get the app)", async (t) => {
  const f = fixture();
  fs.rmSync(path.join(f.tailnet, "tailnet.json"));
  const server = createPublicStart({
    dist: f.dist,
    tailnetDir: f.tailnet,
    privateOrigin: "https://mac.tail1.ts.net:8443",
    name: "Mac",
    instance: "i",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  });
  const r = await fetch(
    `http://127.0.0.1:${server.address().port}/reach-start.json`,
  );
  assert.equal((await r.json()).tailnet, null);
});
