import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

// Exercise the same TypeScript shipped to the browser, without a DOM runner.
async function sourceModule(path) {
  const sourceUrl = new URL(path, import.meta.url);
  const source = await fs.readFile(sourceUrl, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  // Data URLs cannot resolve relative imports; use the real shared helper.
  const resolvedOutput = outputText.replaceAll(
    JSON.stringify("../server/agent-transport.mjs"),
    JSON.stringify(new URL("../server/agent-transport.mjs", sourceUrl).href),
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(resolvedOutput).toString("base64")}`
  );
}
const {
  makeShareFile,
  canShareFile,
  shareBrowserFile,
  shareCancelled,
  shareName,
} = await sourceModule("../src/sharing.ts");
const { fileBlob } = await sourceModule("../src/api.ts");
const peer = { url: "https://fixture.invalid", token: "fixture-only" };
function mockNavigator(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  });
}

test("sharing preserves file bytes, Unicode name, and MIME type", async () => {
  const file = makeShareFile(
    new Blob(["%PDF-fixture"], { type: "application/octet-stream" }),
    "Résumé.PDF",
  );
  assert.equal(file.name, "Résumé.PDF");
  assert.equal(file.type, "application/pdf");
  assert.equal(await file.text(), "%PDF-fixture");
  assert.equal(
    makeShareFile(new Blob(["x"], { type: "custom/test" }), "x.txt").type,
    "custom/test",
  );
  assert.equal(
    shareName("../../secret\\name\u0000.txt"),
    ".._.._secret_name_.txt",
  );
  assert.equal(shareName(".."), "file");
});

test("share is invoked synchronously with only file bytes, without a private URL or token", async (t) => {
  const file = makeShareFile(new Blob(["safe fixture"]), "notes.txt");
  let payload;
  mockNavigator(t, {
    share(data) {
      payload = data;
      return Promise.resolve();
    },
  });
  const pending = shareBrowserFile(file);
  assert.deepEqual(Object.keys(payload), ["files"]);
  assert.equal(payload.files[0], file);
  await pending;
});

test("unsupported types and denied policies offer fallback; cancellation remains distinguishable", (t) => {
  const file = makeShareFile(new Blob(["fixture"]), "notes.txt");
  mockNavigator(t, { share: () => Promise.resolve(), canShare: () => true });
  assert.equal(canShareFile(file), true);
  navigator.canShare = () => false;
  assert.equal(canShareFile(file), false);
  navigator.canShare = () => {
    throw new Error("policy denied");
  };
  assert.equal(canShareFile(file), false);
  assert.equal(
    shareCancelled(new DOMException("Canceled", "AbortError")),
    true,
  );
  assert.equal(shareCancelled(new Error("Share canceled")), true);
  assert.equal(
    shareCancelled(new DOMException("No permission", "NotAllowedError")),
    false,
  );
});

test("file preparation keeps auth on the request and disallows redirects", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).searchParams.get("path"), "Documents/a & b.txt");
    assert.equal(options.headers.Authorization, "Bearer fixture-only");
    assert.equal(options.redirect, "error");
    assert.equal(options.signal, controller.signal);
    return new Response("fixture", {
      headers: { "content-type": "text/plain" },
    });
  });
  const blob = await fileBlob(peer, "Documents/a & b.txt", 0, {
    signal: controller.signal,
    maxBytes: 100,
  });
  assert.equal(await blob.text(), "fixture");
  assert.equal(blob.type, "text/plain");
});

for (const declared of [true, false]) {
  test(`share preparation cancels oversized ${declared ? "declared" : "streamed"} files`, async (t) => {
    let canceled = false;
    const stream = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(11));
      },
      cancel() {
        canceled = true;
      },
    });
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(stream, {
          headers: declared ? { "content-length": "11" } : {},
        }),
    );
    await assert.rejects(
      fileBlob(peer, "fixture.txt", 0, { maxBytes: 10 }),
      /too large/,
    );
    assert.equal(canceled, true);
  });
}

test("denied file access never becomes a shareable payload", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Access revoked" }, { status: 401 }),
  );
  await assert.rejects(
    fileBlob(peer, "fixture.txt", 0, { maxBytes: 100 }),
    /Access revoked/,
  );
});
