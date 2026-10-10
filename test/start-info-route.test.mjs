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
