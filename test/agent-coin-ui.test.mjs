import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// The chat menu's mark (its "Continue in…" the other apps): the user found the
// three logos melted into one drop awful (2026-10-05) and chose a coin that
// flips through the other agents' real app icons, one at a time.
let dom, React, AgentCoin;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: AgentCoin } = await dom.load("/src/AgentCoin.tsx"));
});
after(async () => dom?.close());

const logos = { claude: "data:image/png;base64,Q0w=", codex: "data:image/png;base64,Q1g=" };

test("the coin shows each other agent's real icon in turn, one face each", async () => {
  const view = await dom.render(React.createElement(AgentCoin, { agents: ["claude", "codex", "openclaw"], logos, size: 26 }));
  const coin = dom.document.querySelector(".agent-coin");
  assert.equal(coin.getAttribute("aria-hidden"), "true");
  assert.ok(coin.classList.contains("n3"));
  const faces = [...coin.querySelectorAll(".agent-coin-face")];
  assert.deepEqual(
    faces.map((f) => f.querySelector("img")?.getAttribute("src")),
    // OpenClaw's own mark when it has no app icon on the Mac.
    [logos.claude, logos.codex, faces[2].querySelector("img")?.getAttribute("src")],
  );
  assert.ok(faces[2].querySelector("img, .agent-logo.glyph"), "never an empty face");
  // One after another: each face's turn starts 3.5 s after the one before.
  assert.deepEqual(faces.map((f) => f.style.animationDelay), ["0s", "3.5s", "7s"]);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("an agent without its app's icon still shows its own mark, and at most four turn", async () => {
  const view = await dom.render(
    React.createElement(AgentCoin, { agents: ["gemini", "claude", "codex", "openclaw", "cursor"], logos: {}, size: 26 }),
  );
  const coin = dom.document.querySelector(".agent-coin");
  assert.ok(coin.classList.contains("n4"));
  const faces = [...coin.querySelectorAll(".agent-coin-face")];
  assert.equal(faces.length, 4);
  for (const face of faces) assert.ok(face.querySelector("img, .agent-logo.glyph"), "never an empty face");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
