import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startDom, settle, replaceText } from "./dom/harness.mjs";

// Editing a text file in Files' preview (src/Files.tsx, src/file-edit.ts):
// what is saved, with which hash and line endings, and what is never written.
// Simulated: jsdom against a stand-in computer whose PUT /api/files/text
// checks the hash as the real one does. A real browser's text box and a real
// computer's disk are in journeys/files.
let dom, React, Files;
let name,
  disk,
  puts,
  listings,
  contents,
  toasts,
  answer,
  sequence = 0;
const hash = (text) =>
  crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

before(async () => {
  dom = await startDom({
    routes: {
      "/api/files": () => {
        listings++;
        return {
          items: [
            {
              name,
              path: name,
              type: "file",
              size: Buffer.byteLength(disk),
              modified: "2026-10-07T00:00:00.000Z",
            },
          ],
        };
      },
      "/api/files/icons": () => ({ icons: {} }),
      "/api/files/document-text": () => ({ text: "A letter\n" }),
      "/api/files/content": () => {
        contents++;
        return new Response(disk);
      },
      "/api/files/text": (init) => {
        if ((init.method || "GET") === "GET")
          return answer?.read?.() ?? { text: disk, sha256: hash(disk) };
        const body = JSON.parse(init.body);
        puts.push(body);
        if (answer?.write) return answer.write(body);
        if (body.sha256 !== hash(disk))
          return json(409, {
            error: "This file changed. Read it again before writing.",
          });
        disk = body.text;
        return { ok: true, sha256: hash(disk) };
      },
    },
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  React = dom.React;
  ({ default: Files } = await dom.load("/src/Files.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  puts = [];
  listings = 0;
  contents = 0;
  toasts = [];
  answer = null;
  globalThis.confirm = () => {
    throw Error("Nothing should ask here.");
  };
});

const $ = (view, selector) => view.container.querySelector(selector);
const labelled = (view, label) => $(view, `[aria-label="${label}"]`);
const button = (view, text) =>
  [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === text,
  );
const tap = (element) => dom.update(() => element.click());
const status = (view) => $(view, ".file-viewer-title small").textContent;

async function open(
  file,
  text,
  { access, token = `editor-${++sequence}` } = {},
) {
  name = file;
  if (text !== undefined) disk = text;
  const peer = {
    id: "editor-fixture",
    name: "Fixture computer",
    url: "https://editor.test",
    token,
  };
  const view = await dom.render(
    React.createElement(Files, {
      peer,
      peers: [peer],
      device: {
        name: peer.name,
        platform: "linux",
        roots: [{ id: 0, name: "Fixture files" }],
        capabilities: { files: true },
        ...(access && { access }),
      },
      onSession() {},
      toast: (message) => toasts.push(message),
    }),
  );
  await openFile(view);
  return view;
}
async function openFile(view) {
  await dom.waitFor(() => $(view, ".file-main"));
  tap($(view, ".file-main"));
  await dom.waitFor(() => $(view, "dialog .file-viewer-body > :not(svg)"));
}
async function startEditing(view) {
  const edit = await dom.waitFor(() => {
    const b = labelled(view, `Edit ${name}`);
    return b && !b.disabled && b;
  });
  tap(edit);
  return dom.waitFor(() => $(view, "textarea.file-editor"));
}
async function save(view) {
  tap(button(view, "Save"));
  await dom.waitFor(
    () => !$(view, "textarea.file-editor") || $(view, ".file-editor-note"),
  );
}

test("a text file is edited in its preview and saved once, with the hash it was read with", async () => {
  const view = await open("list.txt", "Shopping list\nMilk\n");
  const field = await startEditing(view);
  assert.equal(field.value, "Shopping list\nMilk\n");
  assert.equal(button(view, "Save").disabled, true, "nothing to save yet");
  assert.equal(status(view), "Editing");
  for (const label of ["Copy text", "Download list.txt", "Edit list.txt"])
    assert.equal(
      labelled(view, label),
      null,
      `${label} waits until editing ends`,
    );
  await replaceText(field, "Shopping list\nMilk\nEggs\n");
  assert.equal(status(view), "Unsaved changes");
  const listed = listings;
  await save(view);
  assert.equal($(view, "textarea.file-editor"), null);
  assert.deepEqual(puts, [
    {
      text: "Shopping list\nMilk\nEggs\n",
      sha256: hash("Shopping list\nMilk\n"),
    },
  ]);
  assert.equal(disk, "Shopping list\nMilk\nEggs\n");
  assert.equal($(view, ".file-viewer-body pre").textContent, disk);
  assert.ok(toasts.includes("Saved list.txt"));
  assert.equal(status(view), "24 B · Just now");
  // The folder is listed again, with the file's new size and time.
  await dom.waitFor(() => listings > listed);
  // The next edit starts from the saved text and the hash it now has.
  const again = await startEditing(view);
  assert.equal(again.value, disk);
  await replaceText(again, "Eggs\n");
  await save(view);
  assert.equal(puts.length, 2);
  assert.equal(puts[1].sha256, hash("Shopping list\nMilk\nEggs\n"));
  assert.equal(disk, "Eggs\n");
  await view.unmount();
});

test("a Windows file keeps its line endings: the text box's \\n go back as \\r\\n", async () => {
  const view = await open("settings.ini", "[core]\r\n\tname = Reach\r\n");
  const field = await startEditing(view);
  assert.equal(field.value, "[core]\n\tname = Reach\n");
  assert.equal(
    button(view, "Save").disabled,
    true,
    "reading \\r\\n as \\n is no change",
  );
  await replaceText(field, "[core]\n\tname = Reach\n\tcolor = green\n");
  await save(view);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].text, "[core]\r\n\tname = Reach\r\n\tcolor = green\r\n");
  assert.equal(disk, "[core]\r\n\tname = Reach\r\n\tcolor = green\r\n");
  await view.unmount();
});

test("a file that can't go back exactly stays view-only and says why", async () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n", Latin-1
  const cases = [
    {
      file: "latin.txt",
      text: "caf�\n",
      read: () => ({
        text: "caf�\n",
        sha256: crypto.createHash("sha256").update(latin1).digest("hex"),
      }),
      why: /isn’t plain UTF-8 text/,
    },
    {
      file: "mixed.txt",
      text: "one\r\ntwo\nthree\n",
      why: /mixes line endings/,
    },
    { file: "old-mac.txt", text: "one\rtwo\r", why: /mixes line endings/ },
    {
      file: "big.log",
      text: `${"x".repeat(130 * 1024)}\n`,
      why: /up to 128 KB/,
    },
  ];
  for (const { file, text, read, why } of cases) {
    toasts = [];
    answer = read ? { read } : null;
    const view = await open(file, text);
    const edit = await dom.waitFor(() => {
      const b = labelled(view, `Edit ${file}`);
      return b && !b.disabled && b;
    });
    tap(edit);
    await settle();
    assert.equal($(view, "textarea.file-editor"), null, file);
    assert.match(toasts.join("\n"), why, file);
    await view.unmount();
  }
  assert.deepEqual(puts, []);
});

test("only access that can change files offers Edit; documents read as text never do", async () => {
  let view = await open("readme.txt", "Read me\n", {
    access: { kind: "guest", scopes: ["files:read"] },
  });
  await dom.waitFor(
    () => $(view, ".file-viewer-body pre")?.textContent === "Read me\n",
  );
  await settle(50);
  assert.equal(labelled(view, "Edit readme.txt"), null, "read-only access");
  await view.unmount();
  view = await open("readme.txt", "Read me\n", {
    access: { kind: "guest", scopes: ["files:read", "files:write"] },
  });
  await dom.waitFor(() => labelled(view, "Edit readme.txt"));
  await view.unmount();
  view = await open("letter.docx", "binary");
  await dom.waitFor(
    () => $(view, ".file-viewer-body pre")?.textContent === "A letter\n",
  );
  await settle(50);
  assert.equal(
    labelled(view, "Edit letter.docx"),
    null,
    "a Word document's text can't be written back",
  );
  await view.unmount();
});

test("a file changed meanwhile is never written over; the draft stays to copy", async () => {
  let clipboard = null;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => void (clipboard = text) },
  });
  try {
    const view = await open("plan.txt", "v1\n");
    const field = await startEditing(view);
    await replaceText(field, "v1, mine\n");
    disk = "v2, theirs\n"; // changed on the computer meanwhile
    await save(view);
    assert.match(
      $(view, ".file-editor-note").textContent,
      /This file changed on your computer since you started editing/,
    );
    assert.equal(puts.length, 1, "sent once, never again by itself");
    assert.equal(disk, "v2, theirs\n");
    assert.equal($(view, "textarea.file-editor").value, "v1, mine\n");
    tap(button(view, "Copy my text"));
    await dom.waitFor(() => clipboard);
    assert.equal(clipboard, "v1, mine\n");
    // Reload sets the draft aside, once confirmed, for the file as it is now.
    const asked = [];
    globalThis.confirm = (question) => (asked.push(question), true);
    tap(button(view, "Reload"));
    await dom.waitFor(
      () => $(view, ".file-viewer-body pre")?.textContent === "v2, theirs\n",
    );
    assert.deepEqual(asked, ["Discard your changes to plan.txt?"]);
    assert.equal($(view, "textarea.file-editor"), null);
    assert.equal(puts.length, 1);
    await view.unmount();
  } finally {
    delete dom.window.navigator.clipboard;
  }
});

test("a save whose answer was lost isn't sent again by itself, and counts once the file holds it", async () => {
  const view = await open("memo.txt", "draft\n");
  const field = await startEditing(view);
  await replaceText(field, "final\n");
  // Written on the computer, but the answer never reaches the phone.
  answer = {
    write(body) {
      disk = body.text;
      throw new TypeError("Failed to fetch");
    },
  };
  await save(view);
  assert.match(
    $(view, ".file-editor-note").textContent,
    /Couldn't reach your computer/,
  );
  assert.equal(puts.length, 1);
  assert.ok($(view, "textarea.file-editor"), "still editing");
  await settle(100);
  assert.equal(puts.length, 1, "no save is retried by itself");
  // Saving again meets the file it already wrote: saved, not a conflict.
  answer = null;
  await save(view);
  assert.equal(puts.length, 2);
  assert.equal(puts[1].sha256, hash("draft\n"));
  assert.equal($(view, "textarea.file-editor"), null);
  assert.equal(disk, "final\n");
  assert.ok(toasts.includes("Saved memo.txt"));
  await view.unmount();
});

test("unsaved edits ask before closing, and come back when the preview closed another way", async () => {
  const token = `editor-${++sequence}`;
  let view = await open("keep.txt", "keep\n", { token });
  const field = await startEditing(view);
  await replaceText(field, "keep me\n");
  const asked = [];
  globalThis.confirm = (question) => (asked.push(question), false);
  tap(labelled(view, "Close preview"));
  tap(button(view, "Cancel"));
  dom.update(() =>
    $(view, "dialog").dispatchEvent(
      new dom.window.Event("cancel", { cancelable: true }),
    ),
  );
  assert.deepEqual(asked, Array(3).fill("Discard your changes to keep.txt?"));
  assert.equal($(view, "textarea.file-editor")?.value, "keep me\n");
  // A back swipe or another page: the preview goes without asking.
  await view.unmount();
  view = await open("keep.txt", undefined, { token });
  const back = await dom.waitFor(() => $(view, "textarea.file-editor"));
  assert.equal(back.value, "keep me\n");
  assert.ok(toasts.includes("Your unsaved changes are back."));
  // Android's back pressed again: its cancel can't be stopped, and the
  // browser closes the dialog itself. The preview goes, the draft stays.
  toasts = [];
  globalThis.confirm = () => false;
  const dialog = $(view, "dialog");
  // A close the dialog has since reopened from (StrictMode's second mount)
  // isn't one.
  dom.update(() => dialog.dispatchEvent(new dom.window.Event("close")));
  await settle();
  assert.equal($(view, "textarea.file-editor")?.value, "keep me\n");
  dom.update(() => {
    dialog.dispatchEvent(new dom.window.Event("cancel", { cancelable: false }));
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new dom.window.Event("close"));
  });
  await dom.waitFor(() => !$(view, "dialog"));
  await openFile(view);
  const kept = await dom.waitFor(() => $(view, "textarea.file-editor"));
  assert.equal(kept.value, "keep me\n");
  assert.ok(toasts.includes("Your unsaved changes are back."));
  // Discarded on purpose: gone for good.
  globalThis.confirm = () => true;
  tap(labelled(view, "Close preview"));
  await dom.waitFor(() => !$(view, "dialog"));
  await openFile(view);
  await dom.waitFor(
    () => $(view, ".file-viewer-body pre")?.textContent === "keep\n",
  );
  assert.equal($(view, "textarea.file-editor"), null);
  assert.deepEqual(puts, []);
  await view.unmount();
});

test("after a save, Share and Download use a fresh copy, not the one fetched before the edit", async () => {
  const shared = [];
  const navigator = dom.window.navigator;
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (data) => void shared.push(data),
  });
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: () => true,
  });
  const created = [];
  const create = URL.createObjectURL;
  URL.createObjectURL = (blob) => (
    created.push(blob),
    "blob:https://reach.test/saved"
  );
  // saveBlob frees its link a minute later; that wait mustn't hold the run.
  const wait = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => {
    const timer = wait(...args);
    if (args[1] >= 60000) timer.unref?.();
    return timer;
  };
  try {
    const view = await open("note.txt", "old\n");
    // Fetched as the preview opened, ready for a Share tap.
    await dom.waitFor(() => contents === 1);
    await dom.waitFor(
      () =>
        labelled(view, "Share note.txt") &&
        !$(view, "[aria-label='Share note.txt'] .spin"),
    );
    const field = await startEditing(view);
    await replaceText(field, "new\n");
    await save(view);
    await dom.waitFor(() => contents === 2);
    await dom.waitFor(() => !$(view, "[aria-label='Share note.txt'] .spin"));
    tap(labelled(view, "Share note.txt"));
    await dom.waitFor(() => shared.length);
    assert.equal(await shared[0].files[0].text(), "new\n");
    tap(labelled(view, "Download note.txt"));
    await dom.waitFor(() => created.length);
    assert.equal(await created[0].text(), "new\n");
    await view.unmount();
  } finally {
    delete navigator.share;
    delete navigator.canShare;
    URL.createObjectURL = create;
    globalThis.setTimeout = wait;
  }
});
