import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

let dom, shareNativeFiles, shareNativeFile, state, reset;
before(async () => {
  const fake = "test/dom/fakes/native-sharing.mjs";
  dom = await startDom({ fakes: {
    "@capacitor/core": fake, "@capacitor/app": fake,
    "@capacitor/filesystem": fake, "@capacitor/share": fake,
  } });
  ({ state, reset } = await dom.load("/test/dom/fakes/native-sharing.mjs"));
  ({ shareNativeFiles, shareNativeFile } = await dom.load("/src/native.ts"));
});
after(async () => dom?.close());
const blob = (text) => new dom.window.Blob([text], { type: "text/plain" });

test("native multi-share keeps duplicate names separate and removes the iOS cache after sharing", async () => {
  reset();
  await shareNativeFiles([{ blob: blob("one"), name: "same.txt" }, { blob: blob("two"), name: "same.txt" }]);
  assert.equal(state.shares.length, 1);
  assert.deepEqual(Object.keys(state.shares[0]), ["files"]);
  assert.equal(state.shares[0].files.length, 2);
  assert.notEqual(state.shares[0].files[0], state.shares[0].files[1]);
  assert.match(state.writes[0].path, /\/0\/same.txt$/);
  assert.match(state.writes[1].path, /\/1\/same.txt$/);
  assert.deepEqual(state.writes.map((r) => Buffer.from(r.data, "base64").toString()), ["one", "two"]);
  assert.equal(state.removed.length, 1);
  assert.ok(state.writes.every((r) => r.path.startsWith(state.removed[0].path + "/")));
  assert.equal(state.removed[0].recursive, true);
});

test("partial iOS preparation failure removes earlier files and never opens a partial share", async () => {
  reset(); state.failWrite = 2;
  await assert.rejects(shareNativeFiles([{ blob: blob("one"), name: "one.txt" }, { blob: blob("two"), name: "two.txt" }]), /Cache write failed/);
  assert.equal(state.shares.length, 0);
  assert.equal(state.removed.length, 1);
  assert.ok(state.writes[0].path.startsWith(state.removed[0].path + "/"));
});

test("Android retains shared cache files for the receiving app and single-file sharing remains compatible", async () => {
  reset("android");
  await shareNativeFile(blob("single"), "single.txt");
  assert.equal(state.shares[0].files.length, 1);
  assert.equal(state.removed.length, 0);
});
