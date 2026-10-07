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
