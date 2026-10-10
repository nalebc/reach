import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
const source = await fs.readFile(
  new URL("../src/connection-link.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { parsePairLink } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
test("QR links support private address-only approval and preserve legacy explicit pairing", () => {
  const origin = "https://computer.example.ts.net:8443";
  assert.deepEqual(parsePairLink(origin), {
    url: origin,
    code: "",
    name: "your computer",
  });
  assert.deepEqual(
    parsePairLink(`reach://connect?u=${encodeURIComponent(origin)}&n=Mac`),
    { url: origin, code: "", name: "Mac" },
  );
  assert.equal(
    parsePairLink(`reach://pair?u=${encodeURIComponent(origin)}&c=12345678`)
      .code,
    "12345678",
  );
  for (const bad of [
    "http://computer.example.ts.net",
    "https://public.example",
    "https://computer.example.ts.net.evil.test",
    origin + "/admin",
    origin + "?secret=test",
    origin + "#secret",
    "https://user:password@computer.example.ts.net",
    "reach://connect?u=https://public.example",
    `reach://pair?u=${encodeURIComponent(origin)}&c=1234`,
    "reach://pair?u=https://evil.example&c=12345678&n=My%20Mac",
    "javascript:alert(1)",
  ])
    assert.equal(parsePairLink(bad), null, bad);
});
