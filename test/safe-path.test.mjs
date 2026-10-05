import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safePath, safePathAsync } from "../server/core.mjs";

test("the non-blocking path check enforces exactly the same rules", async () => {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-safe-")),
  );
  const root = path.join(dir, "shared");
  fs.mkdirSync(path.join(root, "inside"), { recursive: true });
  fs.writeFileSync(path.join(root, "inside", "a.txt"), "a");
  fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
  fs.symlinkSync(path.join(dir, "secret.txt"), path.join(root, "escape.txt"));
  fs.symlinkSync(path.join(root, "inside"), path.join(root, "alias"));
  const outcome = (fn) => {
    try {
      const value = fn();
      return value instanceof Promise
        ? value.then(
            (v) => ["ok", v],
            (e) => ["error", e.status],
          )
        : ["ok", value];
    } catch (e) {
      return ["error", e.status];
    }
  };
  try {
    for (const [rootIndex, relative] of [
      [0, ""],
      [0, "inside/a.txt"],
      [0, "alias/a.txt"],
      [0, "escape.txt"],
      [0, "../secret.txt"],
      [0, "missing/file.txt"],
      [0, "/etc/passwd"],
      [0, "bad\0name"],
      [5, ""],
    ]) {
      const sync = outcome(() => safePath([root], rootIndex, relative));
      const async = await outcome(() =>
        safePathAsync([root], rootIndex, relative),
      );
      assert.deepEqual(async, sync, `${rootIndex}:${relative}`);
    }
    assert.deepEqual(
      await outcome(() => safePathAsync([root], 0, "escape.txt")),
      ["error", 403],
    );
    assert.deepEqual(await outcome(() => safePathAsync([root], 0, "missing")), [
      "error",
      404,
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
