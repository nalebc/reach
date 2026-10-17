import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { serveBuild, setStartInfo } from "../server/delivery.mjs";

// A linked computer asks this one who it is over the tailnet (fleet.mjs):
// the private app must answer JSON, not the interface's index.html.
test("the private app answers /reach-start.json once the launcher knows its address", async (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "reach-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>");
  const app = express();
  serveBuild(app, express, dist);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => {
    server.close();
    setStartInfo(null);
    fs.rmSync(dist, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/reach-start.json`;
  assert.match((await fetch(url)).headers.get("content-type"), /text\/html/, "not set yet: the page");
  setStartInfo(() => ({ product: "Reach", origin: "https://mac.tail.ts.net:8443", name: "Mac", since: 1 }));
  const answer = await fetch(url);
  assert.equal((await answer.json()).product, "Reach");
});


test("a private page can prepare its already-approved browser connection before the native route disappears", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-private-standby-"));
  const dist = path.join(dir, "dist"), tailnet = path.join(dir, "tailnet", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(tailnet, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>private interface");
  const manifest = { wasm: "client-123.wasm", exec: "loader-123.js" };
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const loader = "globalThis.reachStandbyFixture = true;";
  fs.writeFileSync(path.join(tailnet, "tailnet.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(tailnet, manifest.wasm), wasm);
  fs.writeFileSync(path.join(tailnet, manifest.exec), loader);
  fs.writeFileSync(path.join(tailnet, "credentials.json"), "PRIVATE-UNLISTED-FIXTURE");
  let home = "https://mac.tail.ts.net";
  const app = express();
  serveBuild(app, express, dist, { agentStart: () => home });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    setStartInfo(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setStartInfo(() => ({ product: "Reach", origin: "https://mac.tail.ts.net:9443", name: "Mac", instance: "i-private" }));
  const base = `http://127.0.0.1:${server.address().port}`;
  await t.test("metadata names the same-computer home and the actually available client", async () => {
    const response = await fetch(base + "/reach-start.json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const info = await response.json();
    assert.equal(info.home, home);
    assert.deepEqual(info.tailnet, manifest);
    assert.equal(info.instance, "i-private");
  });
  await t.test("the manifest's WASM and loader are usable fixed assets on the private page", async () => {
    const response = await fetch(base + "/tailnet/" + manifest.wasm);
    assert.match(response.headers.get("content-type"), /application\/wasm/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), wasm);
    await WebAssembly.compile(wasm);
    const script = await fetch(base + "/tailnet/" + manifest.exec);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.equal(await script.text(), loader);
    assert.match(script.headers.get("cache-control"), /immutable/);
    const head = await fetch(base + "/tailnet/" + manifest.wasm, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), wasm.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });
  await t.test("unlisted private files are never served as client assets", async () => {
    for (const name of ["credentials.json", "tailnet.json", ".env", "sub/client-123.wasm", "%2fcredentials.json"]) {
      const response = await fetch(base + "/tailnet/" + name);
      assert.equal(response.status, 404, name);
      assert.doesNotMatch(await response.text(), /PRIVATE-UNLISTED-FIXTURE/);
    }
  });
  await t.test("a different computer cannot become the advertised home", async () => {
    home = "https://different.tail.ts.net";
    assert.equal((await (await fetch(base + "/reach-start.json")).json()).home, undefined);
    home = "https://mac.tail.ts.net";
  });
  await t.test("a manifest entry cannot turn a symlink into a client asset", async (t) => {
    const target = path.join(dir, "outside.wasm"), selected = path.join(tailnet, manifest.wasm);
    fs.writeFileSync(target, "PRIVATE-OUTSIDE-FIXTURE");
    fs.unlinkSync(selected);
    try {
      fs.symlinkSync(target, selected, "file");
    } catch (error) {
      fs.writeFileSync(selected, wasm);
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code))
        return t.skip("this Windows account cannot create the symlink fixture");
      throw error;
    }
    try {
      assert.equal((await (await fetch(base + "/reach-start.json")).json()).tailnet, null);
      const response = await fetch(base + "/tailnet/" + manifest.wasm);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /PRIVATE-OUTSIDE-FIXTURE/);
    } finally {
      fs.unlinkSync(selected);
      fs.writeFileSync(selected, wasm);
    }
  });
  await t.test("an absent client is reported as unavailable", async () => {
    fs.unlinkSync(path.join(tailnet, manifest.wasm));
    assert.equal((await (await fetch(base + "/reach-start.json")).json()).tailnet, null);
    assert.equal((await fetch(base + "/tailnet/" + manifest.exec)).status, 404);
  });
});
