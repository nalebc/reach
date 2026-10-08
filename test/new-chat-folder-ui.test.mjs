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
      sessions: [{ cwd: "/Users/me/reach" }, ...Array.from({ length: 20 }, (_, i) => ({ cwd: `/Users/me/project-${i}` }))],
      onStarted: () => {},
    }),
  );
  await settle();
  const folderButton = () => dom.document.querySelector(".chat-folder");
  assert.equal(folderButton().getAttribute("aria-label"), "Folder: /Users/me/reach");
  // Browsing is directly available, even with many recent folders.
  await click(byText("Browse folders…"));
  await dom.waitFor(() => dom.document.querySelector('[aria-label="Open Projects"]'));
  assert.ok(!dom.document.querySelector('[aria-label="Open .config"]'), "hidden folders stay out");
  await click(dom.document.querySelector('[aria-label="Open Projects"]'));
  await dom.waitFor(() => dom.document.querySelector('[aria-label="Open site"]'));
  await click(dom.document.querySelector('[aria-label="Open site"]'));
  await dom.waitFor(() => dom.document.querySelector(".folder-pick-empty")?.textContent === "No folders inside.");
  assert.equal(folderButton().getAttribute("aria-label"), "Folder: /Users/me/Projects/site");
  assert.ok(!dom.document.querySelector(".folder-pick-use"), "no confirmation is needed");
  // The browsed folder stays among the choices.
  const chosenFolder = dom.document.querySelector('.as-picker button[aria-pressed="true"]');
  assert.equal(chosenFolder?.textContent, "site");
  await click(chosenFolder);

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

test("folder navigation selects immediately, including parent breadcrumbs", async () => {
  started = null;
  const view = await dom.render(
    React.createElement(NewChat, {
      peer,
      agent: "codex",
      sessions: [{ cwd: "/Users/me/reach" }],
      onStarted: () => {},
    }),
  );
  await settle();
  const box = dom.document.querySelector("textarea");
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, "Hey");
  box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  const send = () => dom.document.querySelector('[aria-label="Start"]');
  assert.equal(send().disabled, false);
  await click(byText("Browse folders…"));
  await dom.waitFor(() => dom.document.querySelector('[aria-label="Open Projects"]'));
  await click(dom.document.querySelector('[aria-label="Open Projects"]'));
  await dom.waitFor(() => dom.document.querySelector('[aria-label="Open site"]'));
  await click(dom.document.querySelector('[aria-label="Open site"]'));
  assert.equal(send().disabled, false);
  assert.equal(dom.document.querySelector(".chat-folder").title, "/Users/me/Projects/site");
  // Navigating back selects the parent too, without confirmation.
  await click([...dom.document.querySelectorAll(".folder-pick-crumbs button")].find((b) => b.textContent === "Projects"));
  assert.equal(dom.document.querySelector(".chat-folder").title, "/Users/me/Projects");
  // Closing the browser keeps the last folder selected.
  await click(dom.document.querySelector(".chat-folder"));
  assert.equal(send().disabled, false);
  await click(send());
  await dom.waitFor(() => started);
  assert.equal(started.cwd, "/Users/me/Projects");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
