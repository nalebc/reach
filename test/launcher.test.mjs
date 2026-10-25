import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { parseOptions } from "../scripts/launcher-options.mjs";
import { assertUnusedPort, ownsServeRoute } from "../scripts/tailscale.mjs";
import { createReach } from "../server/index.mjs";

test("launcher refuses public sharing, occupied Serve ports, and Funnel routes", () => {
  assert.deepEqual(parseOptions([]), {
    local: false,
    folders: [],
    port: 0,
    httpsPort: 8443,
    help: false,
    stayAwake: "always",
  });
  assert.equal(parseOptions(["--local", "--port", "1234"]).port, 1234);
  assert.equal(parseOptions(["--background"]).background, true);
  assert.equal(parseOptions(["--stop-background"]).stopBackground, true);
  assert.throws(() => parseOptions(["--background", "--stop-background"]));
  for (const args of [
    ["--port", "0"],
    ["--port", "65536"],
    ["--port", "3x"],
    ["--folder"],
    ["--unknown"],
  ])
    assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(["--https-port", "9443"]).httpsPort, 9443);
  assert.throws(() => parseOptions(["--https-port", "0"]));
  assert.throws(() => parseOptions(["--public"]));
  const config = {
    TCP: { 8444: { HTTPS: true } },
    Web: {
      "computer.example.ts.net:8444": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:1234" } },
      },
    },
  };
  assert.throws(() => assertUnusedPort(config, 8444), /already in use/);
  assert.throws(
    () =>
      assertUnusedPort(
        { AllowFunnel: { "computer.example.ts.net:8444": true } },
        8444,
      ),
    /Funnel/,
  );
  assert.throws(
    () => assertUnusedPort({ Foreground: { session: config } }, 8444),
    /already in use/,
  );
  assertUnusedPort(config, 9443);
  const origin = "https://computer.example.ts.net:8444";
  assert.equal(ownsServeRoute(config, origin, "http://127.0.0.1:1234"), true);
  assert.equal(ownsServeRoute(config, origin, "http://127.0.0.1:9999"), false);
  assert.equal(
    ownsServeRoute(
      { Foreground: { session: config } },
      origin,
      "http://127.0.0.1:1234",
    ),
    true,
  );
  assert.throws(
    () =>
      ownsServeRoute(
        { ...config, AllowFunnel: { "computer.example.ts.net:8444": true } },
        origin,
        "http://127.0.0.1:1234",
      ),
    /Funnel/,
  );
});

test("public sharing accepts only its configured hostname and keeps launcher state private", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-host-"));
  const privateDir = path.join(root, ".reach");
  await fs.mkdir(privateDir);
  await fs.writeFile(path.join(privateDir, "setup.log"), "private");
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(privateDir, "quick"),
    privatePaths: [privateDir],
    publicOrigin: "https://computer.example.ts.net",
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const call = (route, headers) =>
    new Promise((resolve, reject) => {
      const req = http.get(url + route, { headers }, (res) => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode }));
      });
      req.once("error", reject);
    });
  try {
    for (const host of ["other.example.ts.net", "evil.example"]) {
      assert.equal((await call("/api/health", { Host: host })).status, 403);
    }
    const headers = { Host: "computer.example.ts.net" };
    assert.equal((await call("/api/device", headers)).status, 401);
    const auth = reach.auth.issue("test", ["files"]);
    headers.Authorization = `Bearer ${auth.token}`;
    assert.equal(
      (await call("/api/files/text?root=0&path=.reach/setup.log", headers))
        .status,
      403,
    );
    assert.equal((await call("/api/health", headers)).status, 200);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "launcher starts locally, refreshes one-use pairing, and closes its listener on stop",
  { timeout: 20000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-launcher-"));
    const entry = pathToFileURL(path.resolve("scripts/launch.mjs")).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { launch } from ${JSON.stringify(entry)}; await launch({ local: true, folders: [${JSON.stringify(root)}], port: 0 }, ${JSON.stringify(root)});`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const exit = once(child, "exit");
    const waitFor = async (check) => {
      const deadline = Date.now() + 12000;
      while (!check()) {
        // What the launcher said (on Windows it refuses folders others can
        // change, and says which): the failure names its own cause.
        if (child.exitCode !== null || Date.now() > deadline)
          throw Error(`Launcher did not become ready (exit ${child.exitCode ?? "none"}):\n${output.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    try {
      await waitFor(() => output.includes("Press Enter"));
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
      const first = output.match(/Pairing code: (\d{4}) (\d{4})/);
      const pair = (code) =>
        fetch(url + "/api/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, name: "test phone" }),
        });
      assert.equal((await pair(first[1] + first[2])).status, 200);
      assert.equal((await pair(first[1] + first[2])).status, 401);
      child.stdin.write("\n");
      await waitFor(() => [...output.matchAll(/Pairing code:/g)].length === 2);
      const second = [...output.matchAll(/Pairing code: (\d{4}) (\d{4})/g)][1];
      assert.equal((await pair(second[1] + second[2])).status, 200);
      child.kill("SIGINT");
      await exit;
      await assert.rejects(fetch(url + "/api/health"));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exit;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
