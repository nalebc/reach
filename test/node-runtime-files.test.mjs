import test from "node:test";
import assert from "node:assert/strict";
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
