import test from "node:test";
import assert from "node:assert/strict";
import { Terminals } from "../server/terminal.mjs";

test("closing a terminal then shutting down kills its native handle only once and waits for exit", async () => {
  const terminals = new Terminals();
  let kills = 0, finish;
  const ended = new Promise((resolve) => { finish = resolve; });
  terminals.sessions.set("one", { status: "running", proc: { kill: () => kills++ }, ended });
  terminals.close("one");
  let disposed = false;
  const shutdown = terminals.dispose().then(() => { disposed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(kills, 1);
  assert.equal(disposed, false);
  finish();
  await shutdown;
  assert.equal(disposed, true);
});
