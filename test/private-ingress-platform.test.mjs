import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listenPrivateIngress } from "../server/tailscale-auth.mjs";

test("Windows refuses private POSIX ingress before creating a listener or directory", { skip: process.platform !== "win32" }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-no-posix-ingress-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let dispatched = false;
  await assert.rejects(listenPrivateIngress({
    socketPath: path.join(dir, "not-created", "socket"),
    app: () => { dispatched = true; },
    resolveIdentity: () => { dispatched = true; },
  }), /Private Tailscale ingress requires POSIX socket ownership and permissions/);
  assert.equal(dispatched, false);
  assert.deepEqual(await fs.readdir(dir), []);
});
