import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { nodeRuntimeFiles } from "../server/node-runtime-files.mjs";

const rpath = value => `Load command 1\n          cmd LC_RPATH\n      cmdsize 48\n         path ${value} (offset 12)\n`;
function fixture(binaries, aliases = {}) {
  const seen = [];
  return { seen, run: () => nodeRuntimeFiles("/runtime/bin/node", {
    realpath: value => aliases[value] || value,
    exists: value => !!binaries[aliases[value] || value],
    inspect: (file, flag) => {
      seen.push([file, flag]);
      assert.ok(binaries[file], `unexpected library ${file}`);
      return flag === "-l" ? (binaries[file].rpaths || []).map(rpath).join("") : file + ":\n" + binaries[file].deps.map(value => `\t${value} (compatibility version 0.0.0, current version 0.0.0)`).join("\n");
    },
  }) };
}

test("runtime isolation follows Mach-O runpaths, loader paths and inherited executable paths without directory grants", () => {
  const f = fixture({
    "/runtime/bin/node": { rpaths: ["@loader_path", "@loader_path/../lib", "@executable_path/../vendor"], deps: ["@rpath/libnode.dylib", "/usr/lib/libSystem.B.dylib"] },
    "/runtime/lib/libnode.dylib": { rpaths: ["@loader_path/plugins"], deps: ["@rpath/libnode.dylib", "@rpath/nested/helper.dylib", "@loader_path/liblocal.dylib", "@executable_path/../vendor/libglobal.dylib"] },
    "/runtime/lib/plugins/nested/helper.dylib": { deps: ["@rpath/libglobal.dylib"] },
    "/runtime/lib/liblocal.dylib": { deps: [] },
    "/runtime/vendor/libglobal.dylib": { deps: [] },
  });
  const files = f.run();
  assert.deepEqual(files.sort(), ["/runtime/bin/node", "/runtime/lib/liblocal.dylib", "/runtime/lib/libnode.dylib", "/runtime/lib/plugins/nested/helper.dylib", "/runtime/vendor/libglobal.dylib"]);
  assert.equal(f.seen.length, 10, "each exact library is inspected once, including cycles");
  assert.ok(!files.includes("/runtime/lib"));
});

test("runtime aliases include both requested and canonical files, and runpath order is respected", () => {
  const f = fixture({
    "/runtime/bin/node": { rpaths: ["/opt/deps/lib", "/runtime/lib"], deps: ["@rpath/libone.dylib"] },
    "/cellar/deps/lib/libone.dylib": { deps: [] },
    "/runtime/lib/libone.dylib": { deps: [] },
  }, { "/opt/deps/lib": "/cellar/deps/lib", "/opt/deps/lib/libone.dylib": "/cellar/deps/lib/libone.dylib" });
  assert.deepEqual(f.run().sort(), ["/cellar/deps/lib/libone.dylib", "/opt/deps/lib/libone.dylib", "/runtime/bin/node"]);
});

test("unresolvable or unsupported libraries fail closed without exposing host paths", () => {
  for (const deps of [["@rpath/missing.dylib"], ["@unknown/private.dylib"], ["relative.dylib"]]) {
    const f = fixture({ "/runtime/bin/node": { rpaths: ["@loader_path/../lib"], deps } });
    assert.throws(f.run, error => error.status === 503 && !error.message.includes("/runtime") && /Nothing was run/.test(error.message));
  }
  const f = fixture({ "/runtime/bin/node": { rpaths: ["@unsupported"], deps: [] } });
  assert.throws(f.run, { status: 503 });
});

test("a confirmed inspection timeout gets only one extra read-only attempt for the whole graph", () => {
  const seen = [];
  const files = nodeRuntimeFiles("/runtime/bin/node", {
    realpath: value => value,
    exists: () => true,
    inspect(file, flag) {
      seen.push([file, flag]);
      if (seen.length === 1) throw Object.assign(Error("/private/tool-output must stay hidden"), { code: "ETIMEDOUT" });
      return flag === "-l" ? "" : `${file}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)`;
    },
  });
  assert.deepEqual(files, ["/runtime/bin/node"]);
  assert.deepEqual(seen, [["/runtime/bin/node", "-l"], ["/runtime/bin/node", "-l"], ["/runtime/bin/node", "-L"]]);

  let calls = 0;
  assert.throws(() => nodeRuntimeFiles("/runtime/bin/node", {
    realpath: value => value, exists: () => true,
    inspect(file, flag) {
      calls++;
      // First file's transient timeout spends the only retry. A different
      // library timing out must refuse rather than multiplying the budget.
      if (calls === 1 || file.endsWith("helper.dylib")) throw Object.assign(Error("private path"), { code: "ETIMEDOUT" });
      return flag === "-l" ? "" : `${file}:\n\t/runtime/lib/helper.dylib (compatibility version 1.0.0)`;
    },
  }), error => {
    assert.equal(error.status, 503);
    assert.deepEqual(error.runtimeInspection, { phase: "load-commands", code: "ETIMEDOUT", attempts: 1, retryUsed: true });
    assert.doesNotMatch(JSON.stringify(error), /private path|\/runtime/);
    return true;
  });
  assert.equal(calls, 4);
});

test("persistent timeout and other inspection failures refuse with bounded diagnostics and no raw tool data", () => {
  for (const [code, expectedCalls] of [["ETIMEDOUT", 2], ["EACCES", 1], ["ENOENT", 1], ["ENOBUFS", 1], ["/private/forged-code", 1]]) {
    let calls = 0;
    assert.throws(() => nodeRuntimeFiles("/private/runtime/node", {
      realpath: value => value,
      inspect: () => { calls++; throw Object.assign(Error("/private/path and secret"), { code, stderr: "private stderr", stdout: "private stdout" }); },
    }), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "RUNTIME_INSPECTION_FAILED");
      assert.deepEqual(error.runtimeInspection, { phase: "load-commands", code: code.startsWith("/") ? "INSPECT_FAILED" : code,
        attempts: expectedCalls, retryUsed: code === "ETIMEDOUT" });
      assert.doesNotMatch(error.message + JSON.stringify(error), /\/private|secret|stderr|stdout/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, expectedCalls);
  }
});

test("unsupported graph data and unresolved dependencies never use the inspection retry", () => {
  for (const invalid of ["@unsupported/path", "relative.dylib", "@rpath/missing.dylib"]) {
    let calls = 0;
    assert.throws(() => nodeRuntimeFiles("/runtime/bin/node", {
      realpath: value => value, exists: () => false,
      inspect(file, flag) { calls++; return flag === "-l" ? "" : `${file}:\n\t${invalid} (compatibility version 1.0.0)`; },
    }), { status: 503 });
    assert.equal(calls, 2);
  }
  let calls = 0;
  assert.throws(() => nodeRuntimeFiles("/runtime/bin/node", {
    realpath: value => value,
    inspect: () => { calls++; return null; },
  }), { status: 503 });
  assert.equal(calls, 1);
});

// Actual Mach-O files and real directory/file symlinks, compiled for this
// Mac's architecture. The one deliberate subprocess timeout is a test
// control; it does not reproduce the historical Intel runner's unknown cause.
test("actual macOS Mach-O and symlink enumeration survives a controlled OS subprocess timeout without directory grants", {
  skip: process.platform !== "darwin" && "requires actual macOS otool and Mach-O compiler",
  timeout: 30000,
}, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-runtime-graph-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), cellar = path.join(root, "cellar"), lib = path.join(root, "lib");
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  fs.mkdirSync(bin); fs.mkdirSync(cellar); fs.symlinkSync(cellar, lib);
  const source = path.join(root, "fixture.c"), main = path.join(root, "main.c"), library = path.join(cellar, "libfixture.1.dylib");
  fs.writeFileSync(source, "int fixture(void) { return 0; }\n");
  fs.writeFileSync(main, "extern int fixture(void); int main(void) { return fixture(); }\n");
  execFileSync("/usr/bin/xcrun", ["clang", "-arch", "arm64", "-arch", "x86_64", "-dynamiclib", "-install_name", "@rpath/libfixture.dylib", source, "-o", library], { timeout: 10000, stdio: "pipe" });
  fs.symlinkSync("libfixture.1.dylib", path.join(cellar, "libfixture.dylib"));
  const executable = path.join(bin, "runtime");
  execFileSync("/usr/bin/xcrun", ["clang", "-arch", architecture, main, `-L${lib}`, "-lfixture", "-Wl,-rpath,@loader_path/../lib", "-o", executable], { timeout: 10000, stdio: "pipe" });
  let controlledTimeout;
  const seen = [];
  const actualInspect = (file, flag) => execFileSync("/usr/bin/otool", ["-arch", architecture, flag, file],
    { encoding: "utf8", timeout: 5000, maxBuffer: 262144, stdio: "pipe" });
  const files = nodeRuntimeFiles(executable, { inspect(file, flag) {
    seen.push([file, flag]);
    if (seen.length === 1) {
      // A real child is killed by the OS-backed execFileSync deadline. Its
      // code, not elapsed-time guessing or a fabricated error, controls retry.
      try { execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { timeout: 20, stdio: "pipe" }); }
      catch (error) { controlledTimeout = error.code; throw error; }
      assert.fail("the controlled child unexpectedly completed before its deadline");
    }
    return actualInspect(file, flag);
  } });
  assert.equal(controlledTimeout, "ETIMEDOUT");
  assert.deepEqual(files.sort(), [executable, library, path.join(cellar, "libfixture.dylib"), path.join(lib, "libfixture.dylib")].sort());
  assert.ok(files.every(file => fs.statSync(file).isFile()), "every grant names an exact file");
  assert.equal(seen.length, 5, "one timeout plus two actual Mach-O files inspected twice");
  assert.deepEqual(seen[0], seen[1], "only the timed-out read-only inspection is repeated");

  const expected = entry => [entry, library, path.join(cellar, "libfixture.dylib"), path.join(lib, "libfixture.dylib")].sort();
  assert.deepEqual(nodeRuntimeFiles(executable).sort(), expected(executable), "the default inspector accepts the actual host-architecture thin executable");
  const universal = path.join(bin, "universal");
  execFileSync("/usr/bin/xcrun", ["clang", "-arch", "arm64", "-arch", "x86_64", main, `-L${lib}`, "-lfixture", "-Wl,-rpath,@loader_path/../lib", "-o", universal], { timeout: 10000, stdio: "pipe" });
  for (const architecture of ["arm64", "x86_64"])
    assert.deepEqual(nodeRuntimeFiles(universal, { architecture }).sort(), expected(universal), `actual universal Mach-O ${architecture} slice`);
  const otherArchitecture = architecture === "arm64" ? "x86_64" : "arm64";
  const other = path.join(bin, "other-architecture");
  execFileSync("/usr/bin/xcrun", ["clang", "-arch", otherArchitecture, main, `-L${lib}`, "-lfixture", "-Wl,-rpath,@loader_path/../lib", "-o", other], { timeout: 10000, stdio: "pipe" });
  assert.deepEqual(nodeRuntimeFiles(other, { architecture: otherArchitecture }).sort(), expected(other), "actual other-architecture thin Mach-O metadata");

  fs.unlinkSync(path.join(cellar, "libfixture.dylib"));
  assert.throws(() => nodeRuntimeFiles(executable), { status: 503 }, "an actually missing dependency still refuses");

  const malformed = path.join(root, "private-not-mach-o");
  fs.writeFileSync(malformed, "this is not a Mach-O executable\n");
  const checked = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { nodeRuntimeFiles } from ${JSON.stringify(new URL("../server/node-runtime-files.mjs", import.meta.url).href)};
    try { nodeRuntimeFiles(process.argv[1]); process.exitCode = 1; }
    catch (error) { process.stdout.write(JSON.stringify({ status: error.status, message: error.message, inspection: error.runtimeInspection })); }
  `, malformed], { encoding: "utf8", timeout: 10000, stdio: "pipe" });
  assert.equal(checked.status, 0);
  assert.equal(Buffer.byteLength(checked.stderr), 0, "real otool failure output cannot expose host paths before the refusal is redacted");
  const failed = JSON.parse(checked.stdout);
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.inspection, { phase: "load-commands", code: "INVALID_MACHO", attempts: 1, retryUsed: false });
  assert.doesNotMatch(checked.stdout, /private-not-mach-o|reach-runtime-graph-/);

  const mismatched = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { nodeRuntimeFiles } from ${JSON.stringify(new URL("../server/node-runtime-files.mjs", import.meta.url).href)};
    try { nodeRuntimeFiles(process.argv[1], { architecture: process.argv[2] }); process.exitCode = 1; }
    catch (error) { process.stdout.write(JSON.stringify({ status: error.status, inspection: error.runtimeInspection })); }
  `, other, architecture], { encoding: "utf8", timeout: 10000, stdio: "pipe" });
  assert.equal(mismatched.status, 0);
  assert.equal(Buffer.byteLength(mismatched.stderr), 0, "a real otool architecture error must not leak its diagnostic pathname");
  assert.equal(JSON.parse(mismatched.stdout).status, 503);

  // Unlike the non-object and architecture diagnostics above, an actual
  // unreadable file makes otool exit nonzero and write its pathname to stderr.
  fs.chmodSync(malformed, 0);
  let unreadable;
  try {
    unreadable = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { nodeRuntimeFiles } from ${JSON.stringify(new URL("../server/node-runtime-files.mjs", import.meta.url).href)};
      try { nodeRuntimeFiles(process.argv[1]); process.exitCode = 1; }
      catch (error) { process.stdout.write(JSON.stringify({ status: error.status, inspection: error.runtimeInspection })); }
    `, malformed], { encoding: "utf8", timeout: 10000, stdio: "pipe" });
  } finally { fs.chmodSync(malformed, 0o600); }
  assert.equal(unreadable.status, 0);
  assert.equal(Buffer.byteLength(unreadable.stderr), 0, "an actual permission denial must not forward raw otool stderr");
  assert.deepEqual(JSON.parse(unreadable.stdout), { status: 503, inspection: {
    phase: "load-commands", code: "INSPECT_FAILED", attempts: 1, retryUsed: false,
  } });
  assert.doesNotMatch(unreadable.stdout, /private-not-mach-o|reach-runtime-graph-/);
});
