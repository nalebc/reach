import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

// New terminal / New Codex chat (src/NewSessionSheet.tsx), Oct 13: the old
// form ("Start a terminal", a native select of shared folders, a free-text
// Subfolder box, a paragraph) became a small sheet: an optional name, the
// folder as one row with up to three recent folders under it, then Open.
// The folder row turns the sheet into a page of folders (Files' list); the
// pick comes back with the name still typed. A folder that can't be listed
// can still be typed. Same request as ever: { name, root, path }.
let dom, React, NewSessionSheet;
const routes = {};
const posts = [];
before(async () => {
  dom = await startDom({ routes });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ default: NewSessionSheet } = await dom.load("/src/NewSessionSheet.tsx"));
});
after(async () => dom?.close());
afterEach(() => {
  posts.length = 0;
  localStorage.clear();
  for (const key of Object.keys(routes)) delete routes[key];
});

const mac = { id: "mac", url: "https://reach.test", token: "t", name: "Studio", platform: "darwin" };
const device = {
  name: "Studio",
  roots: [
    { id: 0, name: "Home", path: "/Users/me" },
    { id: 1, name: "Work", path: "/Volumes/Work" },
  ],
};
const dir = (path) => ({ name: path.split("/").at(-1), path, type: "directory" });
const tree = {
  "0:": [dir("Documents"), dir(".cache"), { name: "notes.txt", path: "notes.txt", type: "file" }],
  "0:Documents": [dir("Documents/my-project")],
  "0:Documents/my-project": [],
  "1:": [dir("site")],
};
function serve({ fail = [] } = {}) {
  routes["/api/files"] = (init, href) => {
    const key = `${href.searchParams.get("root")}:${href.searchParams.get("path")}`;
    if (fail.includes(key))
      return new Response(JSON.stringify({ error: "Permission denied." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    return { items: tree[key] || [] };
  };
  for (const route of ["/api/terminals", "/api/chats"])
    routes[route] = (init) => {
      posts.push({ route, body: JSON.parse(init.body) });
      return { id: "new-1", name: "Terminal", cwd: "/", status: "running", createdAt: new Date().toISOString() };
    };
}
async function sheet(props = {}) {
  const calls = { closed: 0, created: [] };
  const view = await dom.render(
    React.createElement(NewSessionSheet, {
      kind: "terminal",
      initialRoot: 0,
      initialPath: "",
      peer: mac,
      device,
      close: () => calls.closed++,
      created: (s) => calls.created.push(s),
      ...props,
    }),
  );
  const dialog = () => view.container.querySelector("dialog");
  return { view, calls, dialog };
}
const click = async (el) => {
  assert.ok(el, "element to click");
  el.click();
  await settle();
};
const button = (root, text) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const rows = (d) => [...d.querySelectorAll(".sheet-page .gs-row")].map((r) => r.textContent.trim());
const heading = (d) => d.querySelector("header h2").textContent.trim();
const folder = (d) => d.querySelector(".sheet-folder");

test("New terminal: a name, the folder picked on its page, then Open posts { name, root, path }", async () => {
  serve();
  const { view, calls, dialog } = await sheet();
  const d = dialog();
  assert.equal(d.getAttribute("aria-label"), "New terminal");
  assert.equal(heading(d), "New terminal");
  // No old form: no select, no Subfolder box, no paragraph.
  assert.equal(d.querySelector("select"), null);
  assert.doesNotMatch(d.textContent, /Subfolder|Shared folder|reconnect|Start a terminal/);
  assert.match(d.querySelector(".sheet-computer").textContent, /Studio/);
  assert.equal(folder(d).querySelector(".gs-label span").textContent, "me");
  assert.equal(folder(d).querySelector("small").textContent, "/Users/me");
  await typeInto(d.querySelector('input[aria-label="Name"]'), "Website");

  // The folder page: Home's folders, hidden ones and files left out.
  await click(folder(d));
  assert.ok(d.classList.contains("is-page"));
  await dom.waitFor(() => rows(d).includes("Documents"));
  assert.equal(heading(d), "me");
  assert.deepEqual(rows(d), ["Documents"]);
  await click(d.querySelector(".sheet-page .gs-row"));
  await dom.waitFor(() => rows(d).includes("my-project"));
  assert.equal(heading(d), "Documents");
  await click(d.querySelector(".sheet-page .gs-row"));
  await dom.waitFor(() => rows(d).includes("No folders inside"));
  await click(button(d, "Use “my-project”"));

  // Back on the sheet, the name still typed.
  assert.ok(!d.classList.contains("is-page"));
  assert.equal(folder(d).querySelector(".gs-label span").textContent, "my-project");
  assert.equal(folder(d).querySelector("small").textContent, "/Users/me/Documents/my-project");
  assert.equal(d.querySelector('input[aria-label="Name"]').value, "Website");
  assert.equal(dom.document.activeElement, folder(d), "focus back on the folder row");
  await click(button(d, "Open"));
  await dom.waitFor(() => calls.created.length);
  assert.deepEqual(posts, [
    { route: "/api/terminals", body: { name: "Website", root: 0, path: "Documents/my-project" } },
  ]);
  assert.deepEqual(JSON.parse(localStorage.getItem("reach.recent-folders:mac")), [
    { root: 0, path: "Documents/my-project" },
  ]);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("the page's back walks up, then to the shared folders, then the sheet; Escape there returns to the sheet", async () => {
  serve();
  const { view, calls, dialog } = await sheet({ initialPath: "Documents" });
  const d = dialog();
  await click(folder(d));
  await dom.waitFor(() => rows(d).includes("my-project"));
  assert.equal(heading(d), "Documents");
  const back = () => d.querySelector(".sheet-back");
  assert.equal(back().getAttribute("aria-label"), "Back to me");
  await click(back());
  await dom.waitFor(() => rows(d).includes("Documents"));
  assert.equal(back().getAttribute("aria-label"), "Back to Shared folders");
  await click(back());
  assert.equal(heading(d), "Shared folders");
  assert.deepEqual(rows(d), ["Home/Users/me", "Work/Volumes/Work"]);
  assert.equal(button(d, "Choose a folder").disabled, true, "nothing to use on the list of shared folders");
  // Into another shared folder and use it.
  await click(d.querySelectorAll(".sheet-page .gs-row")[1]);
  await dom.waitFor(() => rows(d).includes("site"));
  await click(button(d, "Use “Work”"));
  assert.equal(folder(d).querySelector("small").textContent, "/Volumes/Work");
  // Escape (the dialog's cancel) on the page goes back to the sheet, not away.
  await click(folder(d));
  d.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }));
  await settle();
  assert.ok(!d.classList.contains("is-page"));
  assert.equal(calls.closed, 0);
  await click(button(d, "Open"));
  await dom.waitFor(() => posts.length);
  assert.deepEqual(posts[0].body, { root: 1, path: "" }, "an empty name isn't sent");
  await view.unmount();
});

test("up to three recent folders sit one tap away: open terminals' folders and the last ones used", async () => {
  serve();
  localStorage.setItem("reach.recent-folders:mac", JSON.stringify([{ root: 1, path: "site" }]));
  const { view, dialog } = await sheet({
    recent: ["/Users/me/Code/reach", "/Users/me/Code/reach", "/elsewhere/not-shared", "/Volumes/Work/site"],
    initialPath: "Documents",
  });
  const d = dialog();
  const chips = () => [...d.querySelectorAll(".sheet-chip")].map((c) => c.textContent);
  // Last used, then open terminals' folders, then Home; each once, never the current one.
  assert.deepEqual(chips(), ["site", "reach", "me"]);
  assert.equal(d.querySelector(".sheet-chip").getAttribute("title"), "/Volumes/Work/site");
  await click(d.querySelectorAll(".sheet-chip")[1]);
  assert.equal(folder(d).querySelector(".gs-label span").textContent, "reach");
  assert.deepEqual(chips(), ["site", "Documents", "me"], "the folder it started in is one tap back");
  await click(button(d, "Open"));
  await dom.waitFor(() => posts.length);
  assert.deepEqual(posts[0].body, { root: 0, path: "Code/reach" });
  await view.unmount();
});

test("a folder that can't be listed: its path is typed instead (New Codex chat)", async () => {
  serve({ fail: ["1:"] });
  const { view, calls, dialog } = await sheet({ kind: "chat", initialRoot: 1 });
  const d = dialog();
  assert.equal(heading(d), "New Codex chat");
  await click(folder(d));
  const field = await dom.waitFor(() => d.querySelector('input[aria-label="Folder path"]'));
  assert.match(d.textContent, /Permission denied\./);
  assert.match(d.textContent, /Can’t list this folder on this Mac\. Type its path instead\./);
  await typeInto(field, "src\\app/");
  await click(button(d, "Use “app”"));
  assert.equal(folder(d).querySelector("small").textContent, "/Volumes/Work/src/app");
  await click(button(d, "Open"));
  await dom.waitFor(() => calls.created.length);
  assert.deepEqual(posts, [{ route: "/api/chats", body: { root: 1, path: "src/app" } }]);
  await view.unmount();
});

test("a path typed the moment its field appears is kept", async () => {
  serve({ fail: ["1:"] });
  const { view, dialog } = await sheet({ kind: "chat", initialRoot: 1 });
  const d = dialog();
  // A quick thumb, or a phone busy as the page drew: the typing lands the
  // moment the field is there, before anything else on the page has run.
  const typed = new Promise((resolve) => {
    const watch = new dom.window.MutationObserver(() => {
      const field = d.querySelector('input[aria-label="Folder path"]');
      if (!field) return;
      watch.disconnect();
      resolve(typeInto(field, "src/app"));
    });
    watch.observe(d, { childList: true, subtree: true });
  });
  await click(folder(d));
  await typed;
  await settle(50);
  assert.equal(d.querySelector('input[aria-label="Folder path"]').value, "src/app");
  assert.ok(button(d, "Use “app”"), "the button names the folder typed");
  await view.unmount();
});

test("closing: the close button, Escape and a tap outside; the sheet, not its close button, holds focus as it opens", async () => {
  serve();
  const { view, calls, dialog } = await sheet();
  const d = dialog();
  assert.equal(dom.document.activeElement, d, "no focus (and no ring) on the close button as it opens");
  assert.ok(d.classList.contains("reach-sheet"));
  d.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }));
  await settle();
  assert.equal(calls.closed, 1, "Escape");
  d.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
  assert.equal(calls.closed, 2, "a tap outside the sheet");
  d.querySelector(".sheet-computer").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
  assert.equal(calls.closed, 2, "a tap inside doesn't close it");
  await click(d.querySelector('header [aria-label="Close panel"]'));
  assert.equal(calls.closed, 3, "the close button");
  await view.unmount();
});

test("the close button's ring shows for keyboard focus only", () => {
  const css = fs.readFileSync(new URL("../src/sheet.css", import.meta.url), "utf8");
  assert.match(css, /\.reach-sheet \.icon-button:focus:not\(:focus-visible\)\s*\{\s*outline: none;/);
  assert.match(css, /\.reach-sheet \.icon-button:focus-visible\s*\{\s*outline: 2px solid var\(--lime\);/);
  // No ring drawn on plain :focus anywhere in the sheet's close button rules.
  assert.doesNotMatch(css, /icon-button:focus\s*\{/);
});

test("on a Windows PC: its word and its own paths", async () => {
  serve();
  const pc = { ...mac, id: "pc", platform: "win32" };
  const { view, dialog } = await sheet({
    kind: "chat",
    peer: pc,
    device: { name: "Desk PC", roots: [{ id: 0, name: "Home", path: "C:\\Users\\me" }] },
    initialPath: "Projects/site",
    recent: ["c:/users/me/Code/reach"],
  });
  const d = dialog();
  assert.match(d.textContent, /Needs Codex signed in on this Windows PC\./);
  assert.doesNotMatch(d.textContent, /\bMac\b/);
  assert.equal(folder(d).querySelector(".gs-label span").textContent, "site");
  assert.equal(folder(d).querySelector("small").textContent, "C:\\Users\\me\\Projects\\site");
  const chip = d.querySelector(".sheet-chip");
  assert.equal(chip.textContent, "reach");
  assert.equal(chip.getAttribute("title"), "C:\\Users\\me\\Code\\reach");
  await view.unmount();
});
