import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import express from "express";
import { compressJson, serveBuild } from "../server/delivery.mjs";

// Raw HTTP, so nothing decompresses or adds Accept-Encoding behind our back.
const get = (port, route, headers = {}, method = "GET") =>
  new Promise((resolve, reject) =>
    http
      .get({ port, path: route, headers, method }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      })
      .on("error", reject),
  );

test("built files are cached for good and served precompressed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-dist-"));
  const dist = path.join(dir, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  const script = "console.log('reach');".repeat(50);
  fs.writeFileSync(path.join(dist, "assets", "app-abc123.js"), script);
  fs.writeFileSync(
    path.join(dist, "assets", "app-abc123.js.br"),
    zlib.brotliCompressSync(script),
  );
  fs.writeFileSync(
    path.join(dist, "assets", "app-abc123.js.gz"),
    zlib.gzipSync(script),
  );
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>page");
  fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
  const app = express();
  serveBuild(app, express, dist);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();
  try {
    const br = await get(port, "/assets/app-abc123.js", {
      "Accept-Encoding": "gzip, deflate, br",
    });
    assert.equal(br.headers["content-encoding"], "br");
    assert.match(br.headers["content-type"], /javascript/);
    assert.equal(
      br.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
    assert.equal(br.headers.vary, "Accept-Encoding");
    assert.equal(zlib.brotliDecompressSync(br.body).toString(), script);
    const gz = await get(port, "/assets/app-abc123.js", {
      "Accept-Encoding": "gzip",
    });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.equal(zlib.gunzipSync(gz.body).toString(), script);
    const plain = await get(port, "/assets/app-abc123.js");
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.body.toString(), script);
    // "brotli-ish" tokens don't count as br.
    const odd = await get(port, "/assets/app-abc123.js", {
      "Accept-Encoding": "xbr",
    });
    assert.equal(odd.headers["content-encoding"], undefined);
    for (const route of ["/", "/files/deep/link"]) {
      const page = await get(port, route);
      assert.equal(page.status, 200);
      assert.equal(page.headers["cache-control"], "no-cache");
      assert.equal(page.body.toString(), "<!doctype html>page");
    }
    for (const route of ["/assets/..%2fsecret.txt", "/assets/../secret.txt"])
      assert.doesNotMatch((await get(port, route)).body.toString(), /secret/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("build delivery works inside a hidden checkout without exposing dotfiles or traversal", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-hidden-dist-"));
  const dist = path.join(dir, ".worktree", "checkout", "dist");
  fs.mkdirSync(path.join(dist, "assets", ".private"), { recursive: true });
  const script = "console.log('hidden checkout asset');";
  const page = "<!doctype html>hidden checkout page";
  const agent = "<!doctype html>agent browser page";
  const secret = "PRIVATE-FIXTURE-MUST-NOT-BE-SERVED";
  fs.writeFileSync(path.join(dist, "index.html"), page);
  fs.writeFileSync(path.join(dist, "agent.html"), agent);
  const asset = path.join(dist, "assets", "app-hidden123.js");
  fs.writeFileSync(asset, script);
  fs.writeFileSync(asset + ".br", zlib.brotliCompressSync(script));
  fs.writeFileSync(asset + ".gz", zlib.gzipSync(script));
  fs.writeFileSync(path.join(dist, ".env"), secret);
  fs.writeFileSync(path.join(dist, "assets", ".private", "private.js"), secret);
  fs.writeFileSync(path.join(dist, "assets", ".private.js"), secret);
  fs.writeFileSync(
    path.join(dist, "assets", ".private.js.br"),
    zlib.brotliCompressSync(secret),
  );
  fs.writeFileSync(
    path.join(dist, "assets", ".private.js.gz"),
    zlib.gzipSync(secret),
  );
  fs.writeFileSync(path.join(dist, "..", "outside.txt"), secret);
  const app = express();
  serveBuild(app, express, dist);
  // Keep expected denial responses deterministic without noisy Express logging.
  app.use((error, req, res, next) =>
    res.status(error.status || 500).end("denied"),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    for (const [encoding, decode] of [
      ["br", (body) => zlib.brotliDecompressSync(body)],
      ["gzip", (body) => zlib.gunzipSync(body)],
      ["identity", (body) => body],
    ]) {
      await t.test(
        `${encoding} asset retains contents, type and cache policy`,
        async () => {
          const response = await get(port, "/assets/app-hidden123.js", {
            "Accept-Encoding": encoding,
          });
          assert.equal(response.status, 200);
          assert.equal(
            response.headers["content-encoding"],
            encoding === "identity" ? undefined : encoding,
          );
          assert.match(response.headers["content-type"], /javascript/);
          assert.equal(
            response.headers["cache-control"],
            "public, max-age=31536000, immutable",
          );
          assert.equal(response.headers.vary, "Accept-Encoding");
          assert.equal(decode(response.body).toString(), script);
        },
      );
    }
    for (const [route, content, cache] of [
      ["/", page, "no-cache"],
      ["/agent-browser", agent, "no-store"],
      ["/files/deep/link", page, "no-cache"],
    ]) {
      await t.test(`${route} serves the intended page`, async () => {
        const response = await get(port, route);
        assert.equal(response.status, 200);
        assert.equal(response.headers["cache-control"], cache);
        assert.equal(response.body.toString(), content);
      });
    }
    await t.test(
      "HEAD returns the same resource metadata without a body",
      async () => {
        for (const [route, content, encoding] of [
          ["/assets/app-hidden123.js", script, "identity"],
          ["/assets/app-hidden123.js", script, "br"],
          ["/agent-browser", agent, "identity"],
          ["/files/deep/link", page, "identity"],
        ]) {
          const response = await get(
            port,
            route,
            { "Accept-Encoding": encoding },
            "HEAD",
          );
          assert.equal(response.status, 200, route);
          assert.equal(
            response.headers["content-encoding"],
            encoding === "identity" ? undefined : encoding,
          );
          assert.equal(
            Number(response.headers["content-length"]),
            encoding === "br"
              ? zlib.brotliCompressSync(content).length
              : Buffer.byteLength(content),
          );
          assert.equal(response.body.length, 0);
        }
      },
    );
    await t.test(
      "dotfiles and traversal cannot reveal private bytes",
      async () => {
        for (const route of [
          "/.env",
          "/%2eenv",
          "/assets/.private.js",
          "/assets/%2eprivate.js",
          "/assets/.private.js.br",
          "/assets/.private/private.js",
          "/assets/%2eprivate/private.js",
          "/assets/..%2f.env",
          "/assets/../../outside.txt",
          "/assets/%2e%2e/%2e%2e/outside.txt",
          "/assets/..%5c..%5coutside.txt",
        ]) {
          for (const encoding of ["identity", "br", "gzip"]) {
            const response = await get(port, route, {
              "Accept-Encoding": encoding,
            });
            // Denials may retain encoding headers. Compare raw and valid compressed
            // bodies so a successful compressed disclosure cannot evade the check.
            let body = response.body;
            if (
              response.status === 200 &&
              response.headers["content-encoding"] === "br"
            )
              body = zlib.brotliDecompressSync(body);
            if (
              response.status === 200 &&
              response.headers["content-encoding"] === "gzip"
            )
              body = zlib.gunzipSync(body);
            assert.ok(
              !body.toString().includes(secret),
              `${route} (${encoding}) disclosed private bytes`,
            );
          }
        }
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("large API responses are compressed; small ones and old clients are not", async () => {
  const app = express();
  app.use(compressJson());
  const big = {
    items: Array.from({ length: 300 }, (_, i) => ({ name: `file-${i}.jpg` })),
  };
  app.get("/big", (req, res) => res.json(big));
  app.get("/small", (req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();
  try {
    const br = await get(port, "/big", { "Accept-Encoding": "gzip, br" });
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(Number(br.headers["content-length"]), br.body.length);
    assert.ok(br.body.length < JSON.stringify(big).length / 5);
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.body)), big);
    const gz = await get(port, "/big", { "Accept-Encoding": "gzip" });
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body)), big);
    const plain = await get(port, "/big");
    assert.deepEqual(JSON.parse(plain.body), big);
    const small = await get(port, "/small", { "Accept-Encoding": "br" });
    assert.equal(small.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(small.body), { ok: true });
  } finally {
    server.close();
  }
});
