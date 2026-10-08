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

const passiveFixture = (extra = () => ({})) => {
  const state = { current: 'a', active: true, opened: [], reads: 0, pending: true };
  const cards = createAppCards({
    desktopAutomation: { run: work => work(() => { if (!state.active) throw Object.assign(Error('Control changed'), { status: 409, waiting: true }); }) },
    pending: async (_agent, id) => state.pending ? { id: `app-permission:${id}`, expect: ['synthetic command'], appSessionId: `local_${id}` } : null,
    shown: () => [{ id: state.current, session: `local_${state.current}` }],
    open: async (url, options) => { state.opened.push({ url, options }); state.current = new URL(url).searchParams.get('session').replace(/^local_/, ''); },
    frontmost: async () => false,
    idle: async () => 10,
    wait: async () => {},
    read: async () => { state.reads++; return { found: true, buttons: [{ label: 'Deny' }] }; },
    ...extra(state),
  });
  return { cards, state };
};

test('passive card restoration is background and only restores its own still-current target', async () => {
  for (const move of [false, true]) {
    const { cards, state } = passiveFixture(state => ({ read: async () => {
      state.reads++;
      if (move) state.current = 'third';
      return { found: true, buttons: [{ label: 'Deny' }] };
    } }));
    assert.deepEqual((await cards.card('claude', 'b')).buttons, ['Deny']);
    assert.equal(state.current, move ? 'third' : 'a');
    assert.equal(state.opened.length, move ? 1 : 2);
    assert.ok(state.opened.every(item => item.options.background === true));
  }
});

test('passive card ownership loss blocks delayed restoration and further native reads', async () => {
  for (const phase of ['switch', 'read']) {
    const { cards, state } = passiveFixture(state => ({
      wait: async () => { if (phase === 'switch') state.active = false; },
      read: async () => { state.reads++; state.active = false; return { found: true, buttons: [{ label: 'Deny' }] }; },
    }));
    await assert.rejects(cards.card('claude', 'b'), e => e.waiting === true);
    assert.equal(state.opened.length, 1);
    assert.equal(state.reads, phase === 'switch' ? 0 : 1);
  }
});

test('passive card never switches on unknown idle or a chat changed during the idle lookup', async () => {
  for (const seconds of [null, NaN, Infinity, -1, '90']) {
    const { cards, state } = passiveFixture(() => ({ idle: async () => seconds }));
    await assert.rejects(cards.card('claude', 'b'), e => e.inApp === true);
    assert.deepEqual(state.opened, []);
  }
  const { cards, state } = passiveFixture(state => ({ idle: async () => { state.current = 'third'; return 600; } }));
  await assert.rejects(cards.card('claude', 'b'), /changed chats/);
  assert.deepEqual(state.opened, []);
});

test('passive card revalidates the pending request after switching before it reads', async () => {
  const { cards, state } = passiveFixture(state => ({ wait: async () => { state.pending = false; } }));
  await assert.rejects(cards.card('claude', 'b'), /already answered/);
  assert.equal(state.reads, 0);
  assert.equal(state.opened.length, 1);
});
