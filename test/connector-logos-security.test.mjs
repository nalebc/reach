import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnectorLogos, privateAddress, iconAddresses } from "../server/agent-sessions/connector-logos.mjs";
import { logoRequests } from "./helpers/connector-logo-request.mjs";
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-logo-boundary-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test("logo address validation rejects mapped/compatible IPv6, private, reserved and malformed addresses", () => {
  for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:1", "0:0:0:0:0:ffff:127.0.0.1", "::7f00:1", "::1", "::", "fe80::1", "fc00::1", "fd7a:115c:a1e0::1", "ff02::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "not-an-ip", null]) assert.equal(privateAddress(ip), true, String(ip));
  for (const ip of ["93.184.216.34", "140.82.112.3", "2606:4700:4700::1111"]) assert.equal(privateAddress(ip), false, ip);
  assert.deepEqual(iconAddresses("https://user:secret@example.com/mcp"), []);
});

test("the actual request lookup pins validated DNS results, with no second resolution", async t => {
  let lookups = 0;
  const wire = logoRequests(() => ({ chunks: [Buffer.from("safe")] }));
  const logos = createConnectorLogos({ dir: await directory(t), request: wire.request, lookup: async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }] });
  assert.equal(await logos.logo(["https://changing.example/logo"]), "data:image/png;base64,c2FmZQ==");
  assert.equal(lookups, 1);
  assert.deepEqual(wire.connected.map(x => x.address), ["93.184.216.34"]);
  assert.equal(wire.calls[0].options.agent, false, "no pooled connection can bypass the checked lookup");
  assert.equal(wire.calls[0].options.rejectUnauthorized, undefined, "normal HTTPS certificate validation stays enabled");
  assert.equal(wire.calls[0].url, "https://changing.example/logo", "hostname is retained for HTTPS identity validation");
});

test("every redirect revalidates and pins its destination, including DNS and literal private targets", async t => {
  const wire = logoRequests(url => ({ status: 302, headers: { location: url.pathname.includes("literal") ? "https://[::ffff:7f00:1]/logo" : "https://private.example/logo" } }));
  const logos = createConnectorLogos({ dir: await directory(t), request: wire.request, lookup: async host => [{ address: host === "private.example" ? "::ffff:7f00:1" : "93.184.216.34", family: host === "private.example" ? 6 : 4 }] });
  for (const suffix of ["literal", "dns"]) assert.equal(await logos.logo([`https://public.example/${suffix}`]), null);
  assert.equal(wire.connected.length, 2, "only each initial public destination connected");
  assert.ok(wire.responses.every(res => res.destroyed), "redirect bodies are discarded immediately");
  const mixed = logoRequests(() => assert.fail("mixed public/private resolution must not connect"));
  const blocked = createConnectorLogos({ dir: await directory(t), request: mixed.request, lookup: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }] });
  assert.equal(await blocked.logo(["https://mixed.example/logo"]), null);
  assert.equal(mixed.connected.length, 0);
});

test("chunked oversized bodies are stopped at the streaming cap and slots become reusable", async t => {
  let bytesObserved = 0;
  const wire = logoRequests(url => ({ chunks: url.pathname === "/good" ? [Buffer.from("ok")] : (function* () { for (let i = 0; i < 100; i++) { bytesObserved += 64 * 1024; yield Buffer.alloc(64 * 1024); } })() }));
  const logos = createConnectorLogos({ dir: await directory(t), request: wire.request, lookup: publicLookup });
  assert.equal(await logos.logo(["https://public.example/oversized"]), null);
  assert.ok(bytesObserved < 1024 * 1024, `stream was not consumed whole: ${bytesObserved}`);
  assert.ok(wire.responses[0].destroyed && wire.calls[0].req.destroyed);
  assert.equal(await logos.logo(["https://public.example/good"]), "data:image/png;base64,b2s=");
});

test("header limits, compressed bodies and stalled bodies release their requests", async t => {
  const wire = logoRequests(url => ({ hold: true, headers: url.pathname === "/big" ? { "content-type": "image/png", "content-length": "999999999" } : url.pathname === "/gzip" ? { "content-type": "image/png", "content-encoding": "gzip" } : { "content-type": "image/png" } }));
  const logos = createConnectorLogos({ dir: await directory(t), request: wire.request, lookup: publicLookup, timeoutMs: 25 });
  for (const p of ["big", "gzip", "stall"]) assert.equal(await logos.logo([`https://public.example/${p}`]), null);
  assert.ok(wire.calls.every(c => c.req.destroyed));
  assert.ok(wire.responses.every(res => res.destroyed));
});

test("unresolved DNS is bounded and late resolution cannot open a socket", async t => {
  let release;
  const wire = logoRequests(() => assert.fail("timed-out DNS must never connect"));
  const logos = createConnectorLogos({ dir: await directory(t), request: wire.request, lookup: () => new Promise(resolve => { release = resolve; }), timeoutMs: 20 });
  assert.equal(await logos.logo(["https://pending.example/logo"]), null);
  release([{ address: "93.184.216.34" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.connected.length, 0);
  assert.equal(wire.calls[0].req.destroyed, true);
});

test("many logo requests are bounded to four concurrent operations and cache successful results", async t => {
  const wire = logoRequests(url => url.pathname === "/hold" ? { hold: true } : { chunks: [Buffer.from("ok")] });
  const logos = createConnectorLogos({ dir: await directory(t), request: wire.request, lookup: publicLookup, timeoutMs: 30 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => logos.logo([`https://host${i}.example/hold`])));
  assert.equal(wire.calls.length, 4);
  assert.ok(wire.calls.every(c => c.req.destroyed));
  const good = await logos.logo(["https://safe.example/good"]);
  assert.equal(good, "data:image/png;base64,b2s=");
  assert.equal(await logos.logo(["https://safe.example/good"]), good);
  assert.equal(wire.calls.length, 5);
});
