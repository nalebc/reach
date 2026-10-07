import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildNative, developerTools, resetDeveloperTools } from "../server/native-build.mjs";

// Reach's Mac helpers: never a "install developer tools" dialog at start,
// one build at a time per helper, and no pile of old builds.
const dir = () => fs.mkdtemp(path.join(os.tmpdir(), "reach-native-"));
const toolsAt = (developer) => async (command, args) => {
  if (command === "/usr/bin/xcode-select") {
    if (!developer) throw Object.assign(new Error("unable to get active developer directory"), { code: 2 });
    return { stdout: `${developer}\n` };
  }
  throw new Error(`unexpected ${command}`);
};

test("without developer tools, nothing that could open macOS's install dialog runs", { skip: process.platform !== "darwin" }, async () => {
  resetDeveloperTools();
  const calls = [];
  const run = async (command, args) => {
    calls.push(command);
    return toolsAt(null)(command, args);
  };
  const file = path.join(await dir(), "reach-thing-0123456789ab");
  await assert.rejects(buildNative(file, ["swiftc", "x.swift"], { run, missing: "Install the tools." }), /Install the tools/);
  assert.deepEqual(calls, ["/usr/bin/xcode-select"], "xcrun never ran");
  resetDeveloperTools();
});

test("two asks for the same helper at once build it once; the result appears whole", { skip: process.platform !== "darwin" }, async () => {
  resetDeveloperTools();
  const folder = await dir();
  const file = path.join(folder, "reach-thing-0123456789ab");
  let compiles = 0;
  const run = async (command, args) => {
    if (command === "/usr/bin/xcode-select") return { stdout: `${os.tmpdir()}\n` };
    compiles++;
    const out = args[args.indexOf("-o") + 1];
    assert.match(path.basename(out), /\.tmp$/, "written to a temporary file first");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.writeFile(out, "binary");
    return { stdout: "" };
  };
  const [a, b] = await Promise.all([buildNative(file, ["swiftc", "x.swift"], { run }), buildNative(file, ["swiftc", "x.swift"], { run })]);
  assert.equal(a, file);
  assert.equal(b, file);
  assert.equal(compiles, 1);
  assert.equal(await fs.readFile(file, "utf8"), "binary");
  assert.deepEqual((await fs.readdir(folder)).filter((n) => n.endsWith(".tmp")), []);
  resetDeveloperTools();
});

test("a new build of a helper removes its older builds, never another helper's", { skip: process.platform !== "darwin" }, async () => {
  resetDeveloperTools();
  const folder = await dir();
  for (const name of ["reach-mac-prompts-aaaaaaaaaaaa", "reach-mac-prompts-bbbbbbbbbbbb", "reach-mac-answer-cccccccccccc", "reach-input-v2"])
    await fs.writeFile(path.join(folder, name), "old");
  const run = async (command, args) => {
    if (command === "/usr/bin/xcode-select") return { stdout: `${os.tmpdir()}\n` };
    await fs.writeFile(args[args.indexOf("-o") + 1], "new");
    return { stdout: "" };
  };
  await buildNative(path.join(folder, "reach-mac-prompts-dddddddddddd"), ["swiftc", "x.swift"], { run });
  assert.deepEqual((await fs.readdir(folder)).sort(), ["reach-input-v2", "reach-mac-answer-cccccccccccc", "reach-mac-prompts-dddddddddddd"]);
  resetDeveloperTools();
});

test("this Mac's developer tools are found without asking anything", { skip: process.platform !== "darwin" }, async () => {
  resetDeveloperTools();
  assert.equal(typeof (await developerTools()), "boolean");
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const mac = { skip: process.platform !== "darwin" };

test("one owner quitting does not cancel the shared native build another owner still needs", mac, async (t) => {
  resetDeveloperTools();
  t.after(resetDeveloperTools);
  const folder = await dir();
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "reach-shared-0123456789ab");
  const started = deferred(), finish = deferred();
  let compiles = 0, compiling;
  const run = async (command, args, { signal }) => {
    if (command === "/usr/bin/xcode-select") return { stdout: folder };
    compiles++;
    compiling = signal;
    started.resolve();
    await finish.promise;
    signal.throwIfAborted();
    await fs.writeFile(args.at(-1), "shared binary");
    return { stdout: "" };
  };
  const owner = new AbortController();
  const first = buildNative(file, ["swiftc", "shared.swift"], { run, signal: owner.signal });
  const other = buildNative(file, ["swiftc", "shared.swift"], { run });
  await started.promise;
  owner.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(compiling.aborted, false, "the other caller still owns its build");
  finish.resolve();
  assert.equal(await other, file);
  assert.equal(compiles, 1);
  assert.equal(await fs.readFile(file, "utf8"), "shared binary");
});

test("the final native-build owner quitting aborts its compiler and removes partial output", mac, async (t) => {
  resetDeveloperTools();
  t.after(resetDeveloperTools);
  const folder = await dir();
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "reach-stopped-0123456789ab");
  const started = deferred(), stopped = deferred();
  let compiling;
  const run = async (command, args, { signal }) => {
    if (command === "/usr/bin/xcode-select") return { stdout: folder };
    compiling = signal;
    await fs.writeFile(args.at(-1), "partial output");
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { stopped.resolve(); reject(signal.reason); }, { once: true });
      started.resolve();
    });
  };
  const firstOwner = new AbortController(), secondOwner = new AbortController();
  const first = buildNative(file, ["swiftc", "stopped.swift"], { run, signal: firstOwner.signal });
  const second = buildNative(file, ["swiftc", "stopped.swift"], { run, signal: secondOwner.signal });
  await started.promise;
  firstOwner.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(compiling.aborted, false);
  secondOwner.abort();
  await assert.rejects(second, { name: "AbortError" });
  await stopped.promise;
  assert.equal(compiling.aborted, true);
  // The caller's wait cancels immediately; the compiler cleanup settles next.
  for (let i = 0; (await fs.readdir(folder)).length && i < 100; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await fs.readdir(folder), []);
});

test("shutdown during developer-tool discovery cancels it without starting a compiler or caching failure", mac, async (t) => {
  resetDeveloperTools();
  t.after(resetDeveloperTools);
  const folder = await dir();
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const started = deferred();
  const owner = new AbortController();
  const commands = [];
  let discovery;
  const run = (command, args, { signal }) => {
    commands.push(command);
    discovery = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.resolve();
    });
  };
  const pending = buildNative(path.join(folder, "helper"), ["swiftc", "helper.swift"], { run, signal: owner.signal });
  await started.promise;
  owner.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(discovery.aborted, true);
  assert.deepEqual(commands, ["/usr/bin/xcode-select"]);
  assert.equal(await developerTools({ run: toolsAt(folder) }), true, "an aborted lookup is not a cached missing-tools result");
});

test("a cancelled compile cannot publish late output or interfere with a fresh retry", mac, async (t) => {
  resetDeveloperTools();
  t.after(resetDeveloperTools);
  const folder = await dir();
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "reach-retry-0123456789ab");
  const started = deferred(), late = deferred(), released = deferred();
  const owner = new AbortController();
  let compiles = 0;
  const run = async (command, args) => {
    if (command === "/usr/bin/xcode-select") return { stdout: folder };
    const order = ++compiles;
    if (order === 1) { started.resolve(); await late.promise; }
    await fs.writeFile(args.at(-1), order === 1 ? "stale" : "fresh");
    if (order === 1) released.resolve();
    return { stdout: "" };
  };
  const cancelled = buildNative(file, ["swiftc", "retry.swift"], { run, signal: owner.signal });
  await started.promise;
  owner.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(await buildNative(file, ["swiftc", "retry.swift"], { run }), file);
  late.resolve();
  await released.promise;
  for (let i = 0; (await fs.readdir(folder)).some(name => name.endsWith(".tmp")) && i < 100; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await fs.readFile(file, "utf8"), "fresh");
  assert.deepEqual(await fs.readdir(folder), [path.basename(file)]);
});

test("an already closed owner cannot receive a cached helper or start a new compiler", async (t) => {
  const folder = await dir();
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "cached");
  await fs.writeFile(file, "binary");
  const owner = new AbortController();
  owner.abort();
  const run = () => assert.fail("a closed owner must not run native tools");
  await assert.rejects(buildNative(file, [], { run, signal: owner.signal }), { name: "AbortError" });
  await assert.rejects(buildNative(path.join(folder, "missing"), [], { run, signal: owner.signal }), { name: "AbortError" });
});
