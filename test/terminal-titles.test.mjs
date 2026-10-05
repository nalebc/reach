import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

// Terminal names as people read them: Mac window titles become the project
// and what runs in it, with agents recognized for their logos.
const { outputText } = ts.transpileModule(
  await fs.readFile(new URL("../src/terminal-titles.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
);
const { describeMacTerminal, describeReachTerminal } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("Mac Terminal titles read as project and what's running, without the size", () => {
  const cases = [
    ["reach — node scripts/bootstrap.mjs — 120×40", { title: "reach", detail: "node scripts/bootstrap.mjs" }],
    ["owner — -zsh — 80×24", { title: "owner", detail: "zsh" }],
    ["spendra-app — Build server — npm run dev — 100×30", { title: "Build server", detail: "npm run dev · spendra-app" }],
    ["My server", { title: "My server", detail: "Terminal" }],
    ["", { title: "Terminal window", detail: "Terminal" }],
  ];
  for (const [name, expected] of cases)
    assert.deepEqual(describeMacTerminal(name, "terminal"), expected, name);
});

test("agents show their task, or their project, under their own name", () => {
  assert.deepEqual(describeMacTerminal("reach — ✳ Fix terminal list — claude — 132×48", "terminal"), {
    agent: "claude",
    title: "Fix terminal list",
    detail: "Claude Code · reach",
  });
  assert.deepEqual(describeMacTerminal("reach — codex — 120×40", "terminal"), {
    agent: "codex",
    title: "reach",
    detail: "Codex",
  });
  assert.deepEqual(describeMacTerminal("claude (node)", "iterm2"), {
    agent: "claude",
    title: "Claude Code",
    detail: "iTerm2",
  });
});

test("iTerm2 panes read as their title and job", () => {
  assert.deepEqual(describeMacTerminal("ssh pi@raspberrypi (ssh)", "iterm2"), {
    title: "ssh pi@raspberrypi",
    detail: "ssh",
  });
  assert.deepEqual(describeMacTerminal("~ (-zsh)", "iterm2"), { title: "~", detail: "zsh" });
});

test("Reach shells show their folder and last line, never a bare prompt", () => {
  const shell = (preview) =>
    describeReachTerminal({ name: "Terminal 1", cwd: "/Users/n/reach", preview });
  assert.deepEqual(shell(["ℹ pass 345", "n@mac reach %"]), {
    title: "Terminal 1",
    detail: "reach · ℹ pass 345",
  });
  assert.equal(shell(["n@mac reach %   "]).detail, "reach");
  assert.equal(shell(null).detail, "reach");
  assert.deepEqual(
    describeReachTerminal({ name: "Claude Code", cwd: "/Users/n/reach", preview: [] }),
    { title: "Claude Code", detail: "reach", agent: "claude" },
  );
});
