import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cscCandidates } from "../server/desktop-native.mjs";
import { csharpPolicyProgram, macCases, pureSections, reachUrlCases, windowsCases } from "./helpers/desktop-policy-corpus.mjs";

// The Windows helper's pure policy (scripts/native/agent-desktop.cs, a port of
// agent-desktop.swift's) decides the shared corpus as Swift and JavaScript do
// (docs/parity/B-desktop-helper.md §7.2, §13.2). Its source is read here on
// any computer; the corpus is compiled with the PC's own csc.exe and run on
// Windows only.
const source = fs.readFileSync(new URL("../scripts/native/agent-desktop.cs", import.meta.url), "utf8");
const pure = pureSections(source);
// Its code without its comments (whole-line ones, and those after code).
const code = (text) => text.split("\n").filter((line) => !/^\s*\/\//.test(line)).map((line) => line.replace(/\s\/\/\s.*$/, ""));

test("the corpus's copy of the Reach-address cases is the Swift policy test's own", () => {
  const swiftTest = fs.readFileSync(new URL("./agent-desktop-policy-native.test.mjs", import.meta.url), "utf8");
  const literal = swiftTest.split("const reachUrlCases = ")[1].split("\n];")[0] + "\n]";
  const theirs = new Function(`return ${literal};`)();
  assert.equal(JSON.stringify(theirs), JSON.stringify(reachUrlCases));
  assert.ok(macCases.length > 150 && windowsCases.length > 80, "every case is there");
});

test("the pure sections call nothing of Windows, never System.Uri, and compare only ordinally", () => {
  const lines = code(pure);
  for (const banned of [/DllImport/, /\bextern\b/, /\bMarshal\./, /\bIntPtr\b/, /\bSystem\.Uri\b|\bnew Uri\(|\bUri\./, /\bConsole\./, /\bFile\./])
    assert.ok(!lines.some((line) => banned.test(line)), `${banned}: ${lines.find((line) => banned.test(line))?.trim()}`);
  for (const line of lines) {
    const shown = line.trim().slice(0, 200);
    if (/\.(StartsWith|EndsWith)\(/.test(line)) assert.ok(/StringComparison\.Ordinal/.test(line), shown);
    if (/(?<!Array)\.(?:Last)?IndexOf\((?!'|c\)|value\[i\])/.test(line)) assert.ok(/StringComparison\.Ordinal/.test(line), shown);
    assert.ok(!/\b(?:string|String)\.Compare\(|\.ToLower\(\)|\.ToUpper\(\)/.test(line), shown);
  }
  // Every pattern: the same in any language, and stopped after its time budget.
  for (const [construction] of lines.join("\n").matchAll(/new Regex\([\s\S]*?\);/g))
    assert.ok(/CultureInvariant/.test(construction) && /TimeSpan|Budget/.test(construction), construction.slice(0, 200));
});

test("Windows' additions to the policy leave the Mac's data alone, and an installed program is matched by its path", () => {
  const policy = source.split("// BEGIN PURE DESKTOP POLICY")[1].split("// END PURE DESKTOP POLICY")[0];
  // A Store app by its package, a package family, a publisher, Settings' and
  // Control Panel's ids, the compositor: each guarded so a Mac's ids never meet it.
  assert.match(policy, /PackageName\(id\)/);
  assert.match(policy, /id\.StartsWith\(entry \+ "!"/);
  assert.match(policy, /ProtectedPublishers/);
  assert.match(policy, /"windows\.controlpanel"/);
  assert.match(policy, /"exe:dwm\.exe"/);
  // The rules' reader drops an exe: bundle from the Apps preset's apps.
  assert.match(policy, /bundle\.StartsWith\("exe:", StringComparison\.OrdinalIgnoreCase\)\) app\["bundleId"\] = ""/);
});

const exec = promisify(execFile);
test("compiled Windows desktop policy decides the same corpus", { skip: process.platform !== "win32", timeout: 180000 }, async (t) => {
  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  assert.ok(csc, "Windows' C# compiler");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach windows policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const program = path.join(dir, "checks.cs"), binary = path.join(dir, "checks.exe");
  fs.writeFileSync(program, csharpPolicyProgram(source));
  const framework = path.win32.dirname(csc);
  await exec(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/codepage:65001", "/utf8output", `/out:${binary}`,
    ...["System.dll", "System.Core.dll"].map((name) => `/reference:${path.win32.join(framework, name)}`), program], { windowsHide: true, timeout: 120000, maxBuffer: 4 << 20 })
    .catch((error) => assert.fail(`${error.stdout || ""}${error.stderr || ""}`.split(/\r?\n/).filter((line) => /error CS/.test(line)).slice(0, 20).join("\n") || error.message));
  const { stdout } = await exec(binary, [], { windowsHide: true, timeout: 60000, maxBuffer: 4 << 20 }).catch((error) => error);
  assert.equal(String(stdout).trim(), "OK");
});
