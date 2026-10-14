import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readDocumentText, rtfText, docxText, odtText } from "../server/document-text.mjs";
import { zipFixture } from "./helpers/archive-fixtures.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

test("document text is read-only, shared-folder bound and never editable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-doctext-"));
  const shared = path.join(dir, "shared"),
    other = path.join(dir, "other");
  fs.mkdirSync(shared);
  fs.mkdirSync(other);
  for (const name of ["Contract.docx", "Notes.rtf", "Draft.pages"])
    fs.writeFileSync(path.join(shared, name), "document bytes");
  fs.writeFileSync(path.join(other, "Secret.docx"), "secret");
  fs.writeFileSync(path.join(dir, "Outside.docx"), "outside");
  const read = [];
  const reach = await createReach({
    roots: [shared, other],
    dataDir: path.join(dir, "private"),
    documentText: async (file) => {
      read.push(path.basename(file));
      return `text of ${path.basename(file)}`;
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const guest = reach.auth.redeemGuest(
    reach.auth.inviteGuest({ name: "guest", roots: [0], ttlSeconds: 60 })
      .invitation,
  );
  const get = (token, root, file) =>
    fetch(
      `${url}/api/files/document-text?${new URLSearchParams({ root: String(root), path: file })}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  try {
    const response = await get(owner.token, 0, "Contract.docx");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "text of Contract.docx" });
    // Guests read inside their own folders only.
    assert.equal((await get(guest.token, 0, "Notes.rtf")).status, 200);
    assert.equal((await get(guest.token, 1, "Secret.docx")).status, 400);
    assert.equal((await get(owner.token, 0, "../Outside.docx")).status, 403);
    // Only formats the computer can convert; folders and missing files fail.
    assert.equal((await get(owner.token, 0, "Draft.pages")).status, 415);
    assert.equal((await get(owner.token, 0, "Missing.docx")).status, 404);
    assert.deepEqual(read, ["Contract.docx", "Notes.rtf"]);
  } finally {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("document conversion fails safely", async () => {
  const run = async () => {
    throw Object.assign(Error("too long"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });
  };
  await assert.rejects(
    readDocumentText("/x/Long.docx", { run, platform: "darwin" }),
    (e) => e.status === 413,
  );
  await assert.rejects(
    readDocumentText("/x/Broken.docx", {
      run: async () => {
        throw Error("textutil failed");
      },
      platform: "darwin",
    }),
    (e) => e.status === 415,
  );
  // Off a Mac, Word 97–2003's .doc is a download (the rest are read below).
  await assert.rejects(
    readDocumentText("/x/Doc.doc", { run, platform: "win32" }),
    (e) => e.status === 501,
  );
  await assert.rejects(
    readDocumentText("/x/Script.sh", { platform: "darwin" }),
    (e) => e.status === 415,
  );
});

test("document conversions share a process-wide cap and release it after success or failure", async () => {
  const pending = [];
  const run = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const convert = () => readDocumentText("/fixture/Shared.docx", { run, platform: "darwin" });
  const first = convert(), second = convert();
  const third = convert().then(value => ({ value }), error => ({ error }));
  let fourth, fifth;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 2, "a burst must not start an unbounded number of native converters");
    assert.equal((await third).error?.status, 429);
    pending[0].resolve({ stdout: "first" });
    assert.equal(await first, "first");
    fourth = convert();
    assert.equal(pending.length, 3, "a successful conversion releases one slot");
    pending[1].reject(Error("converter failed"));
    await assert.rejects(second, error => error.status === 415);
    fifth = convert();
    assert.equal(pending.length, 4, "a failed conversion releases its slot");
  } finally {
    for (const item of pending) item.resolve({ stdout: "done" });
    await Promise.allSettled([first, second, third, fourth, fifth]);
  }
});

test(
  "Word, RTF and OpenDocument files become plain text on a Mac",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-textutil-"));
    try {
      const source = path.join(dir, "note.txt");
      fs.writeFileSync(source, "Café Nørd ✓\nSecond line\n");
      for (const format of ["docx", "rtf", "odt"]) {
        const file = path.join(dir, `note.${format}`);
        execFileSync("/usr/bin/textutil", [
          "-convert",
          format,
          source,
          "-output",
          file,
        ]);
        assert.match(await readDocumentText(file), /Café Nørd ✓\nSecond line/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// Parity audit #37: a computer without textutil (Windows, Linux) reads Word,
// OpenDocument and RTF itself, within the same limits.
const W = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
test("Windows: a Word document's text, a paragraph a line, with its tabs, breaks and escaped characters", async () => {
  const docx = zipFixture([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", deflate: true, data: W('<w:p><w:r><w:t>Caf&#233; &amp; </w:t></w:r><w:r><w:t xml:space="preserve">friends</w:t></w:r></w:p><w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>&lt;C&gt;</w:t></w:r></w:p><w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>') },
  ]);
  const text = await readDocumentText("/x/Contract.docx", { platform: "win32", read: async () => docx });
  assert.equal(text, "Café & friends\nA\tB\n<C>\n\n");
});

test("Windows: an OpenDocument's paragraphs and headings, its runs of spaces and line breaks", async () => {
  const odt = zipFixture([
    { name: "mimetype", data: "application/vnd.oasis.opendocument.text" },
    { name: "content.xml", deflate: true, data: '<office:document-content xmlns:office="o" xmlns:text="t"><office:automatic-styles><style:style>not text</style:style></office:automatic-styles><office:body><office:text><text:h>Title</text:h><text:p>One<text:s text:c="3"/>two<text:tab/>three<text:line-break/><text:span>four</text:span></text:p></office:text></office:body></office:document-content>' },
  ]);
  assert.equal(await readDocumentText("/x/draft.odt", { platform: "win32", read: async () => odt }), "Title\nOne   two\tthree\nfour\n");
});

test("Windows: RTF's text in its code page and Unicode, never its fonts, colours or field codes", async () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\uc1{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}{\*\generator Word;}\f0 Dear Ana,\par Caf\'e9 \u8212\'97 caf\'e9{\field{\*\fldinst HYPERLINK "x"}{\fldrslt here}}\tab ok\line \{braces\}}`;
  assert.equal(rtfText(rtf), "Dear Ana,\nCafé — caféhere\tok\n{braces}");
  assert.equal(await readDocumentText("/x/letter.rtf", { platform: "win32", read: async () => Buffer.from(rtf, "latin1") }), "Dear Ana,\nCafé — caféhere\tok\n{braces}");
});

test("Windows: what can't be read says so; Word 97–2003's .doc is a download; too long is too long", async () => {
  await assert.rejects(readDocumentText("/x/old.doc", { platform: "win32", read: async () => assert.fail("not read") }), { status: 501, message: "Download this document to open it." });
  await assert.rejects(readDocumentText("/x/Broken.docx", { platform: "win32", read: async () => Buffer.from("not a zip") }), { status: 415 });
  await assert.rejects(readDocumentText("/x/Empty.docx", { platform: "win32", read: async () => zipFixture([{ name: "other.xml", data: "<x/>" }]) }), { status: 415 });
  const long = zipFixture([{ name: "word/document.xml", deflate: true, data: W(`<w:p><w:r><w:t>${"a".repeat(1024 * 1024 + 10)}</w:t></w:r></w:p>`) }]);
  await assert.rejects(readDocumentText("/x/Long.docx", { platform: "win32", read: async () => long }), { status: 413 });
  assert.equal(docxText(W("<w:p><w:r><w:t>&#xD800;bad&#1114112;</w:t></w:r></w:p>")), "bad\n", "no lone surrogates or impossible code points");
  assert.equal(odtText("<office:body><text:p>a</text:p></office:body><text:p>outside</text:p>"), "a\n");
});
