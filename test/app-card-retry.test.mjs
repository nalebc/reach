import test from "node:test";
import assert from "node:assert/strict";
import { createAppCards, pressAppCard } from "../server/agent-sessions/app-cards.mjs";

const native = (reply) => ({ binary: async () => "/unused", run: async () => ({ stdout: JSON.stringify(reply) }) });
test("native approval failures permit retries only when nothing was pressed", async () => {
  await assert.rejects(pressAppCard("claude", "Allow", ["cmd"], native({ error: "not visible", untouched: true })), e => e.retry === true);
  await assert.rejects(pressAppCard("claude", "Allow", ["cmd"], native({ error: "unknown delivery" })), e => e.retry === false);
  for (const reply of [{}, { pressed: "Deny" }])
    await assert.rejects(pressAppCard("claude", "Allow", ["cmd"], native(reply)), /didn't confirm/);
});

test("a missing card can be read again and answered, but an uncertain press cannot", async () => {
  for (const untouched of [true, false]) {
    let pending = { id: "app-permission:test", expect: ["cmd"] };
    let reads = 0, presses = 0;
    const cards = createAppCards({
      pending: async () => pending,
      shown: () => [{ id: "chat" }],
      read: async () => { reads++; return { found: true, buttons: [{ label: "Allow" }] }; },
      press: async () => {
        if (++presses === 1) return pressAppCard("claude", "Allow", ["cmd"], native({ error: "not visible", untouched }));
        pending = null;
      },
    });
    await cards.card("claude", "chat");
    await assert.rejects(cards.answer("claude", "chat", pending.id, { label: "Allow" }), /not visible/);
    if (untouched) {
      assert.deepEqual(await cards.answer("claude", "chat", pending.id, { label: "Allow" }), { answered: true });
      assert.equal(reads, 2);
      assert.equal(presses, 2);
    } else {
      await assert.rejects(cards.answer("claude", "chat", pending.id, { label: "Allow" }), /already attempted/);
      assert.equal(presses, 1);
    }
  }
});
