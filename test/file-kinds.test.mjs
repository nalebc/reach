import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
const source = await fs.readFile(
  new URL("../src/file-kinds.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const {
  fileKind,
  friendlyDate,
  kindLabel,
  previewMode,
  imageType,
  parentPath,
  baseName,
  whenMissing,
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("files are grouped by what they are, from the name alone", () => {
  const kind = (name, type = "file") => fileKind({ name, type });
  assert.equal(kind("Designs", "directory"), "folder");
  assert.equal(kind("photo.final.JPG"), "image");
  assert.equal(kind("clip.mov"), "video");
  assert.equal(kind("ep42.mp3"), "audio");
  assert.equal(kind("Quarterly report.pdf"), "pdf");
  assert.equal(kind("backup.tar.gz"), "archive");
  assert.equal(kind("server.ts"), "code");
  assert.equal(kind("budget.xlsx"), "sheet");
  assert.equal(kind("Pitch deck.key"), "slides");
  assert.equal(kind("contract.docx"), "doc");
  assert.equal(kind("notes.md"), "text");
  assert.equal(kind("Figma.dmg"), "package");
  // Extensionless names: known text files, dotfiles, and everything else.
  assert.equal(kind("README"), "text");
  assert.equal(kind(".zshrc"), "text");
  assert.equal(kind("unknown-binary"), "file");
  assert.equal(kind("archive.xyz"), "file");
  // A folder named like a file is still a folder.
  assert.equal(kind("photos.png", "directory"), "folder");
  assert.equal(kindLabel("pdf"), "PDF document");
});

test("modified dates read naturally and never break on bad input", () => {
  const now = new Date(2026, 9, 4, 12, 0, 0);
  const at = (...parts) => new Date(...parts).toISOString();
  assert.equal(friendlyDate(at(2026, 9, 4, 11, 59, 30), now), "Just now");
  assert.match(friendlyDate(at(2026, 9, 4, 9, 41), now), /9:41/);
  assert.equal(friendlyDate(at(2026, 9, 3, 23, 0), now), "Yesterday");
  assert.equal(
    friendlyDate(at(2026, 9, 1, 8, 0), now),
    new Date(2026, 9, 1).toLocaleDateString(undefined, { weekday: "short" }),
  );
  assert.doesNotMatch(friendlyDate(at(2026, 4, 2), now), /2026/);
  assert.match(friendlyDate(at(2024, 2, 3), now), /2024/);
  assert.equal(friendlyDate("not a date", now), "");
});

test("the viewer only fetches what it can show or copy", () => {
  const mode = (name, type = "file") => previewMode({ name, type });
  assert.equal(mode("photo.JPG"), "image");
  assert.equal(imageType("logo.svg"), "image/svg+xml");
  // Text, code, spreadsheets saved as text, and unknown files read as text.
  for (const name of [
    "notes.md",
    "data.json",
    "server.ts",
    "export.csv",
    "list.tsv",
    "README",
    "blob",
  ])
    assert.equal(mode(name), "text", name);
  // Word, RTF and OpenDocument text comes from the computer.
  for (const name of ["Contract.docx", "old.doc", "letter.rtf", "draft.odt"])
    assert.equal(mode(name), "document", name);
  // Everything else is a download: nothing is fetched to preview it.
  for (const name of [
    "Quarterly.pdf",
    "clip.mov",
    "photo.heic",
    "deck.key",
    "notes.pages",
    "app.dmg",
  ])
    assert.equal(mode(name), null, name);
  assert.equal(mode("Designs", "directory"), null);
});

test("a folder that disappears sends Files to the nearest one that exists", () => {
  assert.equal(parentPath("Downloads/Installers"), "Downloads");
  assert.equal(parentPath("Downloads"), "");
  assert.equal(parentPath(""), "");
  assert.equal(baseName("Downloads/Installers"), "Installers");
  const status = (code) => Object.assign(Error("x"), { status: code });
  // Moved, deleted, or replaced by a file: climb one level at a time.
  assert.equal(whenMissing(status(404), "a/b"), "parent");
  assert.equal(whenMissing(status(400), "a/b"), "parent");
  // The shared folder itself is gone or no longer shared.
  assert.equal(whenMissing(status(404), ""), "first-root");
  assert.equal(whenMissing(status(400), ""), "first-root");
  // Offline, expired access, server trouble: stay put and say so.
  for (const code of [undefined, 401, 403, 500, 502])
    assert.equal(whenMissing(status(code), "a/b"), "stay", String(code));
  assert.equal(whenMissing(new TypeError("Failed to fetch"), "a"), "stay");
});
