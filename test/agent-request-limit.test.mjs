import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";

test("access requests are limited per visitor and a missing body is a 400", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-req-limit-"));
  const reach = await createReach({
    roots: [tmp],
    dataDir: path.join(tmp, "private"),
    port: 0,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const ask = (ip) =>
    fetch(`${url}/api/agents/requests`, { method: "POST", headers: { "x-forwarded-for": ip } });
  for (let i = 0; i < 5; i++) assert.equal((await ask("100.64.0.1")).status, 400);
  assert.equal((await ask("100.64.0.1")).status, 429);
  assert.equal((await ask("100.64.0.2")).status, 400);
});
