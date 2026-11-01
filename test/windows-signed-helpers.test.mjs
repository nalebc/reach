import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { windowsHelperKinds, windowsHelperSource } from "../server/desktop-native.mjs";
import { signedHelper, shippedEntry, validManifest, authenticodeSignatures, resetSignedHelpers } from "../server/windows-signed-helpers.mjs";

// Synthetic bytes and signature verdicts only. This does not sign a program,
// run a Windows helper, or select this preparatory verifier in production.
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  resetSignedHelpers();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-signed-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const shipped = path.join(root, "shipped"), dir = path.join(root, "private");
  await fs.mkdir(shipped);
  const bytes = Buffer.from("synthetic signed helper; never executable");
  const plan = { kind: "example", target: "exe", sourceSha256: hash("sources") };
  const entry = { ...plan, file: "reach-example.exe", sha256: hash(bytes), unsignedSha256: hash("unsigned"), signer: "SignPath Foundation" };
  const manifest = { schema: 1, product: "Reach", version: "0.0.0", commit: "local", helpers: [entry] };
  await fs.writeFile(path.join(shipped, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(shipped, entry.file), bytes);
  let checks = 0;
  const options = { shipped, dir, version: "0.0.0", warn() {}, signatures: async files => {
    checks++;
    return new Map(files.map(file => [file, { status: "Valid", subject: "CN=SignPath Foundation, O=Fixture" }]));
  } };
  return { shipped, dir, plan, manifest, entry, bytes, options, checks: () => checks };
}

test("only the same version, helper target and source digest select a shipped entry", async t => {
  const h = await fixture(t);
  assert.deepEqual(shippedEntry(h.plan, h.options), h.entry);
  for (const changed of [{ kind: "other" }, { target: "winexe" }, { sourceSha256: hash("changed") }])
    assert.equal(shippedEntry({ ...h.plan, ...changed }, h.options), null);
  assert.equal(shippedEntry(h.plan, { ...h.options, version: "0.0.1" }), null);
  for (const changed of [{ file: "../other.exe" }, { sha256: h.entry.unsignedSha256 }, { kind: "../example" }])
    assert.equal(validManifest({ ...h.manifest, helpers: [{ ...h.entry, ...changed }] }), null);
});

test("verified bytes are copied and rechecked; replacing shipped bytes invalidates a cached verdict", async t => {
  const h = await fixture(t);
  const first = await signedHelper(h.plan, h.options);
  assert.equal(first.sha256, h.entry.sha256);
  assert.deepEqual(await fs.readFile(first.file), h.bytes);
  await fs.writeFile(first.file, "replaced destination");
  assert.deepEqual(await signedHelper(h.plan, h.options), first);
  assert.deepEqual(await fs.readFile(first.file), h.bytes);
  assert.equal(h.checks(), 1);
  await fs.writeFile(path.join(h.shipped, h.entry.file), "replaced source");
  assert.equal(await signedHelper(h.plan, h.options), null);
});

test("an invalid or unrelated signature never creates a helper copy", async t => {
  for (const verdict of [{ status: "NotSigned", subject: "CN=SignPath Foundation" }, { status: "Valid", subject: "CN=Other Publisher" }]) {
    const h = await fixture(t);
    assert.equal(await signedHelper(h.plan, { ...h.options,
      signatures: async files => new Map(files.map(file => [file, verdict])),
    }), null);
    await assert.rejects(fs.stat(h.dir), { code: "ENOENT" });
  }
});

test("signature inspection uses the system PowerShell and data arguments without a policy override", async () => {
  const files = [String.raw`C:\Fixture\first.exe`, String.raw`C:\Fixture\second.exe`];
  const result = await authenticodeSignatures(files, { env: { SystemRoot: String.raw`C:\Windows` },
    run: async (command, args, options) => {
      assert.equal(command, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
      assert.ok(!args.includes("-ExecutionPolicy"));
      assert.ok(!args.some(value => files.some(file => value.includes(file))));
      assert.equal(options.env.REACH_SIGNED_FILES, files.join("\n"));
      return { stdout: JSON.stringify(files.map(file => ({ path: file, status: "Valid", subject: "CN=SignPath Foundation" }))) };
    } });
  assert.equal(result.size, 2);
});

test("release source fingerprints cover every shipped C# helper and its auxiliary sources", () => {
  const kinds = windowsHelperKinds();
  assert.ok(kinds.some(helper => helper.kind === "background" && helper.target === "winexe"));
  assert.ok(!kinds.some(helper => helper.kind === "hello"));
  for (const helper of kinds) {
    const source = windowsHelperSource(helper.kind);
    assert.match(source.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(source.target, helper.target);
    assert.ok(source.files.includes(`scripts/native/${helper.kind}.cs`));
    if (helper.kind === "screen-video") assert.ok(source.files.includes("scripts/native/agent-desktop.cs"));
  }
});
