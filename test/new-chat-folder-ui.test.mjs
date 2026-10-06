import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// New chat's folder: besides the folders your chats are in, browse Home to any
// folder. It only offered recent folders, or a path typed by hand.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const tree = {
  "": ["Documents", "Projects", ".config"],
  Projects: ["site", "api"],
  "Projects/site": [],
};
let dom, React, NewChat, started;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
      "/api/device": () => ({
        roots: [
          { id: 0, name: "Home", path: "/Users/me" },
          { id: 1, name: "Computer", path: "/" },
        ],
      }),
      "/api/files": (_init, href) => {
        const at = href.searchParams.get("path") || "";
        assert.equal(href.searchParams.get("root"), "0", "browses Home");
        return {
          items: (tree[at] || []).map((name) => ({
            name,
            path: at ? `${at}/${name}` : name,
            type: "directory",
          })),
        };
      },
      "/api/sessions": (init) => {
        started = JSON.parse(init.body);
        return { threadId: "t1", turnId: null };
      },
    },
  });
  React = dom.React;
  ({ NewChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());

const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const byText = (text) =>
  [...dom.document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);

test("a new chat can start in a folder found by browsing Home", async () => {
  const view = await dom.render(
    React.createElement(NewChat, {
      peer,
      agent: "codex",
      sessions: [{ cwd: "/Users/me/reach" }],
      onStarted: () => {},
    }),
  );
  await settle();
  const folderButton = () => dom.document.querySelector(".chat-folder");
  assert.equal(folderButton().getAttribute("aria-label"), "Folder: /Users/me/reach");
  await click(folderButton());
  await click(byText("Browse…"));
  await dom.waitFor(() => dom.document.querySelector('[aria-label="Open Projects"]'));
  assert.ok(!dom.document.querySelector('[aria-label="Open .config"]'), "hidden folders stay out");
  await click(dom.document.querySelector('[aria-label="Open Projects"]'));
  await dom.waitFor(() => dom.document.querySelector('[aria-label="Open site"]'));
  await click(dom.document.querySelector('[aria-label="Open site"]'));
  await dom.waitFor(() => dom.document.querySelector(".folder-pick-empty")?.textContent === "No folders inside.");
  await click(byText("Use “site”"));
  assert.equal(folderButton().getAttribute("aria-label"), "Folder: /Users/me/Projects/site");
  assert.ok(!dom.document.querySelector(".folder-pick"), "the browser closes");
  // The browsed folder stays among the choices.
  await click(folderButton());
  assert.equal(byText("site")?.getAttribute("aria-pressed"), "true");
  await click(byText("site"));

  const box = dom.document.querySelector("textarea");
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  setValue.call(box, "Fix the header");
  box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  await click(dom.document.querySelector('[aria-label="Start"]'));
  await dom.waitFor(() => started);
  assert.equal(started.cwd, "/Users/me/Projects/site");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
