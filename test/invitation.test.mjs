import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

const source = await fs.readFile(
  new URL("../src/invitation.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { tailscaleShareUrl } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("guest instructions require a Tailscale machine invitation, not an arbitrary Tailscale page", () => {
  const valid = "https://login.tailscale.com/admin/invite/fixture-AbC_123";
  assert.equal(tailscaleShareUrl(` ${valid} `), valid);
  assert.equal(tailscaleShareUrl(valid + "/"), valid + "/");
  for (const bad of [
    "",
    "not a URL",
    "https://tailscale.com",
    "https://login.tailscale.com/admin/machines",
    "https://login.tailscale.com/admin/invite/",
    "https://evil.tailscale.com/admin/invite/abc",
    "https://login.tailscale.com.evil.test/admin/invite/abc",
    valid.replace("https:", "http:"),
    valid.replace("login.", "user:password@login."),
    valid.replace(".com/", ".com:8443/"),
    valid + "?redirect=https://example.com",
    valid + "#anything",
    valid + "/extra",
  ])
    assert.equal(tailscaleShareUrl(bad), "", bad);
});
