import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, replaceText } from "./dom/harness.mjs";

let dom, Files, entries, extracts, messages, failure;
let sequence = 0;
before(async () => {
  dom = await startDom({
    routes: {
      "/api/files": () => ({ items: entries }),
      "/api/files/icons": () => ({ icons: {} }),
      "/api/files/extract": (init) => {
        const { root, path } = JSON.parse(init.body);
        extracts.push({ root, path });
        if (path === failure)
          return new Response(JSON.stringify({ error: "Broken archive" }), {
            status: 422,
          });
        const name = path.replace(/\.zip$/, "");
        entries = [...entries, entry(name, "directory")];
        return { name };
      },
    },
  });
  ({ default: Files } = await dom.load("/src/Files.tsx"));
});
after(() => dom?.close());
const entry = (name, type = "file") => ({
  name,
  path: name,
  type,
  size: 32,
  modified: "2026-10-07T00:00:00Z",
});
const click = (view, selector) =>
  dom.update(() => {
    const button = view.container.querySelector(selector);
    assert.ok(button, selector);
    assert.equal(button.disabled, false, selector);
    button.click();
  });
const named = (view, name) =>
  [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === name,
  );
async function show({ grid = false, readOnly = false } = {}) {
  entries = [
    entry("a.zip"),
    entry("b.zip"),
    entry("notes.md"),
    entry("folder", "directory"),
  ];
  extracts = [];
  messages = [];
  failure = "";
  dom.window.localStorage.setItem("reach.files.view", grid ? "grid" : "list");
  const peer = {
    id: "files",
    name: "Computer",
    url: "https://files.test",
    token: `files-${++sequence}`,
  };
  const view = await dom.render(
    dom.React.createElement(Files, {
      peer,
      peers: [peer],
      device: {
        name: peer.name,
        platform: "darwin",
        roots: [{ id: 0, name: "Documents" }],
        capabilities: { files: true },
        ...(readOnly
          ? { access: { kind: "guest", scopes: ["files:read"] } }
          : {}),
      },
      onSession() {},
      toast: (message) => messages.push(message),
    }),
  );
  await dom.waitFor(
    () =>
      view.container.querySelectorAll(grid ? ".file-tile" : ".file-main")
        .length === 4,
  );
  return view;
}

test("Select is visible and multi-selection works in list and grid", async () => {
  for (const grid of [false, true]) {
    const view = await show({ grid });
    assert.equal(
      view.container.querySelector('[aria-label="Select files"]').textContent,
      "Select",
    );
    click(view, '[aria-label="Select files"]');
    const items = view.container.querySelectorAll(
      grid ? ".file-tile" : ".file-main",
    );
    dom.update(() => {
      items[1].click();
      items[2].click();
    });
    assert.equal(
      view.container.querySelector('[aria-label="Selected items"] strong')
        .textContent,
      "2 selected",
    );
    assert.equal(view.container.querySelectorAll(".file-pick.is-on").length, 2);
    assert.equal(view.container.querySelector("dialog"), null);
    dom.update(() => named(view, "Done").click());
    assert.equal(
      view.container.querySelector('[aria-label="Selected items"]'),
      null,
    );
    await view.unmount();
  }
});

test("selection offers unzip for archives mixed with other files and refreshes the folder", async () => {
  const view = await show();
  click(view, '[aria-label="Select files"]');
  dom.update(() => named(view, "Select All").click());
  const unzip = named(view, "Unzip (2)");
  assert.ok(unzip);
  dom.update(() => unzip.click());
  await dom.waitFor(
    () =>
      extracts.length === 2 &&
      view.container.querySelectorAll(".file-main").length === 6,
  );
  assert.deepEqual(extracts, [
    { root: 0, path: "a.zip" },
    { root: 0, path: "b.zip" },
  ]);
  assert.equal(
    view.container.querySelector('[aria-label="Selected items"] strong')
      .textContent,
    "2 selected",
  );
  assert.equal(messages.length, 2);
  await view.unmount();
});

test("one failed unzip leaves that archive selected and still extracts the next", async () => {
  const view = await show();
  failure = "a.zip";
  click(view, '[aria-label="Select files"]');
  const items = [...view.container.querySelectorAll(".file-main")];
  dom.update(() =>
    items
      .filter((b) => /[ab]\.zip/.test(b.textContent))
      .forEach((b) => b.click()),
  );
  dom.update(() => named(view, "Unzip (2)").click());
  await dom.waitFor(() => extracts.length === 2 && messages.length === 2);
  await dom.waitFor(
    () =>
      view.container.querySelector('[aria-label="Selected items"] strong')
        .textContent === "1 selected",
  );
  assert.match(messages[0], /a\.zip.*Broken archive/);
  assert.match(messages[1], /Unzipped into “b”/);
  assert.equal(
    view.container.querySelector('.file-main[aria-pressed="true"] .file-name')
      .textContent,
    "a.zip",
  );
  await view.unmount();
});

test("Select All acts on the filtered files, preserving selections outside the filter", async () => {
  const view = await show();
  click(view, '[aria-label="Search this folder"]');
  click(view, '[aria-label="Select files"]');
  dom.update(() =>
    [...view.container.querySelectorAll(".file-main")]
      .find((b) => b.textContent.includes("notes.md"))
      .click(),
  );
  await replaceText(
    view.container.querySelector('input[type="search"]'),
    ".zip",
  );
  await dom.waitFor(
    () => view.container.querySelectorAll(".file-main").length === 2,
  );
  dom.update(() => named(view, "Select All").click());
  assert.equal(
    view.container.querySelector('[aria-label="Selected items"] strong')
      .textContent,
    "3 selected",
  );
  dom.update(() => named(view, "Deselect All").click());
  assert.equal(
    view.container.querySelector('[aria-label="Selected items"] strong')
      .textContent,
    "1 selected",
  );
  await view.unmount();
});

test("read-only Files still selects multiple items but never offers unzip", async () => {
  const view = await show({ readOnly: true });
  click(view, '[aria-label="Select files"]');
  dom.update(() => named(view, "Select All").click());
  assert.equal(
    view.container.querySelector('[aria-label="Selected items"] strong')
      .textContent,
    "4 selected",
  );
  assert.equal(named(view, "Unzip (2)"), undefined);
  assert.deepEqual(extracts, []);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
