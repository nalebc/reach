import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import { checkBrowserLink, readPublicStart } from "../scripts/browser-link.mjs";

const origin = "https://pc.example.ts.net";
const config = { product: "Reach", instance: "this-reach", tailnet: { wasm: "client.wasm", exec: "exec.js" } };

test("a working private hostname cannot count as a public browser link", async () => {
  let reads = 0;
  for (const state of ["missing", "unknown"]) {
    const result = await checkBrowserLink(origin, "this-reach", {
      resolve: async () => ({ state, addresses: [] }),
      read: async () => { reads++; return config; },
    });
    assert.equal(result.ready, false);
    assert.match(result.reason, /public/);
  }
  assert.equal(reads, 0, "never uses the host's private MagicDNS answer");
  assert.equal((await checkBrowserLink(origin + ":8444", "this-reach")).ready, false);
});

test("browser readiness requires the public route, matching Reach and browser client", async () => {
  const asked = [];
  const deps = {
    resolve: async host => { assert.equal(host, "pc.example.ts.net"); return { state: "published", addresses: ["192.0.2.1", "192.0.2.2"] }; },
    read: async (url, ip) => { asked.push([url.href, ip]); if (ip.endsWith(".1")) throw Error("relay starting"); return config; },
  };
  assert.deepEqual(await checkBrowserLink(origin, "this-reach", deps), { ready: true });
  assert.deepEqual(asked, [[origin + "/reach-start.json", "192.0.2.1"], [origin + "/reach-start.json", "192.0.2.2"]]);
  for (const answer of [null, { ...config, instance: "another-reach" }, { ...config, product: "other" }])
    assert.equal((await checkBrowserLink(origin, "this-reach", { ...deps, read: async () => answer })).ready, false);
  const missing = await checkBrowserLink(origin, "this-reach", { ...deps, read: async () => ({ ...config, tailnet: null }) });
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /browser sign-in client is missing/);
});

test("the HTTPS probe pins public DNS while retaining hostname and certificate verification", async () => {
  const url = new URL("/reach-start.json", origin);
  const get = (seen, options, done) => {
    assert.equal(seen, url);
    assert.equal(options.servername, "pc.example.ts.net");
    assert.equal(options.agent, false);
    assert.notEqual(options.rejectUnauthorized, false);
    options.lookup(seen.hostname, {}, (error, ip, family) => {
      assert.equal(error, null); assert.equal(ip, "192.0.2.1"); assert.equal(family, 4);
    });
    options.lookup(seen.hostname, { all: true }, (error, answers) => {
      assert.equal(error, null); assert.deepEqual(answers, [{ address: "192.0.2.1", family: 4 }]);
    });
    const req = new EventEmitter();
    req.destroy = error => { req.emit("error", error); req.emit("close"); };
    queueMicrotask(() => {
      const res = Readable.from([Buffer.from(JSON.stringify(config))]);
      res.statusCode = 200;
      done(res);
      res.on("end", () => req.emit("close"));
    });
    return req;
  };
  assert.deepEqual(await readPublicStart(url, "192.0.2.1", { get }), config);
});

test("failed certificates and stalled public relays cannot pass readiness", async () => {
  const get = (_url, _options, _done) => {
    const req = new EventEmitter();
    req.destroy = error => { req.emit("error", error); req.emit("close"); };
    // Keep the test alive while the probe's unref'ed deadline runs.
    const held = setTimeout(() => {}, 1000);
    req.on("close", () => clearTimeout(held));
    return req;
  };
  await assert.rejects(readPublicStart(new URL(origin), "192.0.2.1", { get, timeoutMs: 5 }), /did not answer/);
  assert.equal((await checkBrowserLink(origin, "this-reach", {
    resolve: async () => ({ state: "published", addresses: ["192.0.2.1"] }),
    read: async () => { throw Error("CERT_HAS_EXPIRED"); },
  })).ready, false);
});

test("Windows CI runs the native service boundary as well as the shared browser and private-port checks", async () => {
  const { suites } = await import("../.github/scripts/run-tests.mjs");
  for (const name of ["browser-link", "tailscale-port", "public-dns", "public-start", "tailnet-transport", "setup", "windows-sign-in"])
    assert.ok(suites.windows.includes(name), name);
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /Windows browser ingress against a LocalSystem service[\s\S]*test\/windows-tailscaled-peer\.test\.mjs[\s\S]*REACH_TEST_WINDOWS_PEER: "1"/);
});
