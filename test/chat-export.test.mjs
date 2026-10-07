import test from "node:test";
import assert from "node:assert/strict";
import { chatMarkdown } from "../server/agent-sessions/export.mjs";

// A whole chat as Markdown, as both apps export one.
test("a chat exports as Markdown: who said what, what the agent did in a line each", () => {
  const md = chatMarkdown({
    title: "Fix the login",
    agent: "claude",
    cwd: "/Users/me/site",
    exportedAt: new Date("2026-10-07T12:00:00Z"),
    items: [
      { role: "user", kind: "text", text: "Fix the login\nplease", images: 1 },
      { role: "tool", kind: "command", text: "npm test", status: "failed" },
      { role: "tool", kind: "file-change", text: "src/login.ts" },
      { role: "tool", kind: "agent", text: "Audit auth" },
      { role: "assistant", kind: "text", text: "Fixed it. The token check was **inverted**." },
      { role: "user", kind: "text", text: "/compact", slash: true },
      { role: "system", kind: "output", text: "Compacted ```code``` here" },
    ],
  });
  assert.equal(
    md,
    [
      "# Fix the login",
      "",
      "_Claude · /Users/me/site · 2026-10-07_",
      "",
      "**You**",
      "",
      "> Fix the login",
      "> please",
      "",
      "_1 picture_",
      "",
      "- Ran `npm test` (failed)",
      "- Edited src/login.ts",
      "- Agent: Audit auth",
      "",
      "**Claude**",
      "",
      "Fixed it. The token check was **inverted**.",
      "",
      "**You**",
      "",
      "> `/compact`",
      "",
      "````",
      "Compacted ```code``` here",
      "````",
      "",
    ].join("\n"),
  );
});
