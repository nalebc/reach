import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, replaceText, settle } from "./dom/harness.mjs";

let dom, NewChat, supportsAuto = true, started;
const peer = { id: "mac", name: "Mac", token: "fixture", platform: "darwin" };
before(async () => {
  dom = await startDom({ routes: {
    "/api/sessions/models": () => ({
      models: [{ id: "fixture-model", name: "Fixture model", isDefault: true, autoMode: supportsAuto, efforts: [], defaultEffort: null }],
      modes: [{ id: "manual", label: "Manual" }, { id: "auto", label: "Auto" }],
    }),
    "/api/sessions": init => {
      started = JSON.parse(init.body);
      return { threadId: "fixture-chat", turnId: null };
    },
  } });
  ({ NewChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());

for (const [name, autoMode, chooseDefault, expected] of [
  ["a new Claude chat retains Auto when the model supports it", true, false, "auto"],
  ["an explicit Claude Default choice reaches the server instead of becoming Auto", true, true, "default"],
  ["a Claude model without Auto sends its Default fallback explicitly", false, false, "default"],
]) test(name, async t => {
  supportsAuto = autoMode;
  started = undefined;
  dom.window.sessionStorage.clear();
  const view = await dom.render(dom.React.createElement(NewChat, {
    peer: { ...peer, url: `https://${chooseDefault ? "explicit" : autoMode ? "auto" : "fallback"}.test` },
    agent: "claude", sessions: [], folder: "/work", onStarted() {},
  }));
  t.after(() => view.unmount());
  await dom.waitFor(() => dom.document.querySelector(".chat-model")?.getAttribute("aria-label")?.includes("Fixture model"));
  const permissions = () => dom.document.querySelector(".as-mode-pick");
  if (chooseDefault) {
    await dom.waitFor(() => permissions()?.getAttribute("aria-label") === "Permissions: Auto");
    permissions().click();
    const choice = await dom.waitFor(() => [...dom.document.querySelectorAll(".as-mode-menu button")]
      .find(button => button.textContent.trim() === "Default"));
    choice.click();
  }
  await dom.waitFor(() => permissions()?.getAttribute("aria-label") === `Permissions: ${expected === "auto" ? "Auto" : "Default"}`);
  await replaceText(dom.document.querySelector("textarea"), "Check the chosen permissions");
  dom.document.querySelector('[aria-label="Start"]').click();
  await dom.waitFor(() => started);
  assert.equal(started.agent, "claude");
  assert.equal(started.mode, expected);
  assert.equal(started.model, "fixture-model");
  await settle();
  assert.deepEqual(dom.errors, []);
});
