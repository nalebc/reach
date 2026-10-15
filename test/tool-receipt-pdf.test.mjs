// A saved tool's receipt PDF on Windows (server/tool-receipt-pdf.mjs), read
// back with pdf.js: the same input and checks as the Mac's Core Text helper.
import test from "node:test";
import assert from "node:assert/strict";
import { receiptPdf } from "../server/tool-receipt-pdf.mjs";

const read = async (encoded) => {
  const bytes = Buffer.from(encoded, "base64");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) pages.push((await (await pdf.getPage(n)).getTextContent()).items.map((item) => item.str).join("\n"));
    return pages;
  } finally {
    await task.destroy();
  }
};

test("a receipt snapshot reads back as its text, escaped and paged, heading first", async () => {
  const text = "ORDER-123 · $49 (paid) \\ café — “quoted” €5\n<script>literal content</script>\n" + "Line of receipt details\n".repeat(150) + "x".repeat(200);
  const pages = await read(receiptPdf({ text, source: "https://www.walmart.com/orders/123" }));
  assert.ok(pages.length > 1);
  assert.match(pages[0], /^Receipt snapshot\nSource: https:\/\/www\.walmart\.com\/orders\/123/);
  assert.match(pages[0], /ORDER-123 · \$49 \(paid\) \\ café — “quoted” €5/);
  assert.match(pages[0], /<script>literal content<\/script>/);
  // A word longer than a line is cut, never lost.
  assert.equal(pages.join("\n").match(/x/g).length, 200);
});

test("only an https source, bounded input, and characters outside Windows' Western set become ?", async () => {
  for (const bad of [{ text: "x", source: "http://example.com/" }, { text: "x", source: "file:///C:/x" }, { text: 1, source: "https://example.com/" }, { text: "x".repeat(300000), source: "https://example.com/" }])
    assert.throws(() => receiptPdf(bad), (e) => e.code === "pdf_failed");
  assert.throws(() => receiptPdf({ text: "line\n".repeat(7000), source: "https://example.com/" }), /too long/);
  const [page] = await read(receiptPdf({ text: "漢字 ok", source: "https://example.com/" }));
  assert.match(page, /\?\? ok/);
});
