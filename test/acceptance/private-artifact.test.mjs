import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyPrivateAcceptanceArtifact } from "./private-artifact.mjs";

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-artifact-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), destination = path.join(root, "destination");
  fs.mkdirSync(source); fs.mkdirSync(destination);
  return { root, source, destination };
};

test("acceptance artifact copies real nested source and binary bytes into new files", t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, "server")); fs.mkdirSync(path.join(f.source, "node_modules"));
  fs.writeFileSync(path.join(f.source, "server", "index.mjs"), "export const original = true;\n");
  const binary = Buffer.from([0, 255, 3, 128, 10]);
  fs.writeFileSync(path.join(f.source, "node_modules", "native.node"), binary);
  const copied = copyPrivateAcceptanceArtifact({ ...f, members: ["server", "node_modules"] });
  assert.equal(fs.readFileSync(path.join(f.destination, "server", "index.mjs"), "utf8"), "export const original = true;\n");
  assert.deepEqual(fs.readFileSync(path.join(f.destination, "node_modules", "native.node")), binary);
  assert.equal(copied.files, 2); assert.match(copied.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(f.destination, "src")), false);
});

test("acceptance artifact refuses source links, traversal and a preexisting destination without changing outside bytes", t => {
  const f = fixture(t), outside = path.join(f.root, "outside");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "outside bytes\n");
  fs.symlinkSync(outside, path.join(f.source, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => copyPrivateAcceptanceArtifact({ ...f, members: ["linked"] }), /member is a link/);
  assert.throws(() => copyPrivateAcceptanceArtifact({ ...f, members: ["linked/keep"] }), /member is a link/);
  assert.throws(() => copyPrivateAcceptanceArtifact({ ...f, members: ["../outside/keep"] }), /Invalid artifact member/);
  fs.writeFileSync(path.join(f.destination, "existing"), "destination bytes\n");
  assert.throws(() => copyPrivateAcceptanceArtifact({ ...f, members: [] }), /destination is not empty/);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "outside bytes\n");
  assert.equal(fs.readFileSync(path.join(f.destination, "existing"), "utf8"), "destination bytes\n");
});
