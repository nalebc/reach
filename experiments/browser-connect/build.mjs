import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const revision = "9128778b6515f32e13d92e7380044fe025f9b08e";
const digest =
  "b398ace06e6ac5321bad967265d6895a8f13a5bafd8b81d3aa39ee9d2d441f85";
const cache = path.join(root, ".cache");
const source = path.join(cache, `tailscale-${revision}`);
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(path.join(root, "public"), { recursive: true });
try {
  await fs.access(path.join(source, "go.mod"));
} catch {
  const response = await fetch(
    `https://codeload.github.com/tailscale/tailscale/tar.gz/${revision}`,
  );
  if (!response.ok) throw Error(`Source download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw Error("Tailscale source checksum mismatch");
  const archive = path.join(cache, "source.tar.gz");
  await fs.writeFile(archive, bytes);
  execFileSync("tar", ["-xzf", archive, "-C", cache]);
}
const wasm = path.join(source, "cmd/tsconnect/wasm");
const entry = path.join(wasm, "wasm_js.go");
let code = await fs.readFile(entry, "utf8");
if (!code.includes('"reachRequest"')) {
  const marker = '\t\t"fetch": js.FuncOf';
  if (!code.includes(marker))
    throw Error("Pinned Tailscale adapter location changed");
  code = code.replace(
    marker,
    '\t\t"reachRequest": js.FuncOf(jsIPN.reachRequest),\n\t\t"reachSocketOpen": js.FuncOf(jsIPN.reachSocketOpen),\n\t\t"reachSocketSend": js.FuncOf(jsIPN.reachSocketSend),\n\t\t"reachSocketClose": js.FuncOf(jsIPN.reachSocketClose),\n' +
      marker,
  );
  await fs.writeFile(entry, code);
}
for (const name of [
  "reach_policy.go",
  "reach_transport_js.go",
  "reach_policy_test.go",
])
  await fs.copyFile(path.join(root, "native", name), path.join(wasm, name));
const run = (args, env = {}) =>
  execFileSync("go", args, {
    cwd: source,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
run([
  "test",
  "./cmd/tsconnect/wasm/reach_policy.go",
  "./cmd/tsconnect/wasm/reach_policy_test.go",
]);
run(
  [
    "build",
    "-trimpath",
    "-ldflags=-s -w",
    "-o",
    path.join(root, "public/main.wasm"),
    "./cmd/tsconnect/wasm",
  ],
  { GOOS: "js", GOARCH: "wasm" },
);
const goroot = execFileSync("go", ["env", "GOROOT"], {
  cwd: source,
  encoding: "utf8",
}).trim();
await fs.copyFile(
  path.join(goroot, "lib/wasm/wasm_exec.js"),
  path.join(root, "public/wasm_exec.js"),
);
await fs.copyFile(
  path.join(source, "LICENSE"),
  path.join(root, "public/TAILSCALE-LICENSE.txt"),
);
console.log(
  "Built embedded browser node at pinned Tailscale revision",
  revision,
);
