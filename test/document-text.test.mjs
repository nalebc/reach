import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readDocumentText } from "../server/document-text.mjs";
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
  await assert.rejects(
    readDocumentText("/x/Doc.docx", { run, platform: "win32" }),
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
