import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startDom } from "./dom/harness.mjs";

// The faces of invited agents and people (src/mascots.ts, Mascot.tsx).
let dom, React, MASCOTS, mascotIndex, mascotRects, Mascot, AgentAvatar, accessOf;
before(async () => {
  dom = await startDom();
  React = dom.React;
  ({ MASCOTS, mascotIndex, mascotRects } = await dom.load("/src/mascots.ts"));
  ({ Mascot } = await dom.load("/src/Mascot.tsx"));
  ({ AgentAvatar } = await dom.load("/src/agent-ui.tsx"));
  ({ accessOf } = await dom.load("/src/access-list.ts"));
});
after(async () => dom?.close());

test("twenty distinct mascots, each a full 16×16 grid with every color named", () => {
  assert.equal(MASCOTS.length, 20);
  assert.equal(new Set(MASCOTS.map((m) => m.name)).size, 20);
  assert.equal(new Set(MASCOTS.map((m) => m.bg)).size, 20);
  for (const m of MASCOTS) {
    assert.equal(m.art.length, 16, m.name);
    for (const row of m.art) {
      assert.equal(row.length, 16, `${m.name}: ${row}`);
      for (const key of row) if (key !== ".") assert.ok(m.colors[key], `${m.name} has no color for ${key}`);
    }
    // Runs cover exactly the painted pixels.
    const painted = m.art.join("").replaceAll(".", "").length;
    assert.equal(mascotRects(m).reduce((n, r) => n + r.w, 0), painted, m.name);
  }
});

test("an id always gets the same mascot, and every mascot gets picked", () => {
  const id = "0f8e7c2a-5b1d-4c3e-9a7f-1e2d3c4b5a69";
  assert.equal(mascotIndex(id), mascotIndex(id));
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const index = mascotIndex(randomUUID());
    assert.ok(Number.isInteger(index) && index >= 0 && index < MASCOTS.length);
    seen.add(index);
  }
  assert.equal(seen.size, MASCOTS.length);
});

test("an agent with an id wears its mascot; without one, its initial", async () => {
  const id = "agent-1";
  let view = await dom.render(React.createElement(AgentAvatar, { name: "Muse", id, size: 48 }));
  const svg = view.container.querySelector(".ag-avatar.has-mascot svg.mascot");
  assert.ok(svg);
  assert.equal(svg.querySelector("rect").getAttribute("fill"), MASCOTS[mascotIndex(id)].bg);
  view = await dom.render(React.createElement(AgentAvatar, { name: "Muse", size: 48 }));
  assert.equal(view.container.querySelector("svg.mascot"), null);
  assert.equal(view.container.textContent, "M");
  // Done keeps its check.
  view = await dom.render(React.createElement(AgentAvatar, { name: "Muse", id, done: true }));
  assert.ok(view.container.querySelector(".ag-avatar.is-done"));
  assert.equal(view.container.querySelector("svg.mascot"), null);
  view = await dom.render(React.createElement(Mascot, { id }));
  assert.equal(view.container.querySelector("svg").getAttribute("aria-hidden"), "true");
});

test("the mascot the computer drew wins over the pick from the id", async () => {
  const id = "agent-1";
  const other = (mascotIndex(id) + 7) % MASCOTS.length;
  const bg = async (props) =>
    (await dom.render(React.createElement(Mascot, props))).container.querySelector("rect").getAttribute("fill");
  assert.equal(await bg({ id, drawn: other }), MASCOTS[other].bg);
  assert.equal(await bg({ id, drawn: 0 }), MASCOTS[0].bg);
  // Not one of the twenty (a newer computer's face): the pick from the id.
  assert.equal(await bg({ id, drawn: MASCOTS.length }), MASCOTS[mascotIndex(id)].bg);
  assert.equal(await bg({ id, drawn: 1.5 }), MASCOTS[mascotIndex(id)].bg);
  const view = await dom.render(React.createElement(AgentAvatar, { name: "Muse", id, drawn: other }));
  assert.equal(view.container.querySelector("rect").getAttribute("fill"), MASCOTS[other].bg);
});

test("a device here now is matched to the access it uses", () => {
  const clients = [
    { id: "a", kind: "agent", expiresAt: 100 },
    { id: "p", kind: "guest", expiresAt: 200 },
  ];
  assert.equal(accessOf([{ kind: "agent", expiresAt: 100 }], clients)?.id, "a");
  assert.equal(accessOf([{ kind: "invited", expiresAt: 200 }], clients)?.id, "p");
  // Your own paired devices, or an access no longer listed: no face.
  assert.equal(accessOf([{ kind: "paired", expiresAt: 100 }], clients), undefined);
  assert.equal(accessOf([{ kind: "agent", expiresAt: 200 }], clients), undefined);
  assert.equal(accessOf(undefined, clients), undefined);
  // Two sharing a kind and an end: the name decides, else no face at all.
  const twins = [...clients, { id: "b", name: "Muse", kind: "agent", expiresAt: 100 }];
  clients[0].name = "Grok";
  assert.equal(accessOf([{ kind: "agent", expiresAt: 100 }], twins, "Muse")?.id, "b");
  assert.equal(accessOf([{ kind: "agent", expiresAt: 100 }], twins, "Grok")?.id, "a");
  assert.equal(accessOf([{ kind: "agent", expiresAt: 100 }], twins, "Studio iPad"), undefined);
});
