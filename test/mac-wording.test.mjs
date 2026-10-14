import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The phone said "Mac" to Windows owners in about twenty places (Oct 12
// parity audit, docs/parity/AUDIT.md #25): words a page shows on every
// computer take computerWord (src/pause.ts), "Mac", "Windows PC" or
// "computer". "Mac" stays only where the feature itself is the Mac's
// (macOS permission prompts, Terminal and iTerm2 tabs, agent presets until
// Windows has them). This ratchet keeps it that way: no page may say "Mac"
// more often than it does today, and a page that doesn't may not start.
const ALLOWED = {
  "AgentPage.tsx": 4, // agent presets (workstream E)
  "AgentScreen.tsx": 21, // the agent's own screen (workstreams B, E)
  "AgentSession.tsx": 3, // macOS permission prompts
  "AgentShortcuts.tsx": 1, // Mac Shortcuts
  "App.tsx": 1, // a macOS setting opened
  "AppThread.tsx": 4, // apps on phones (Mac only)
  "Apps.tsx": 2, // hidden from the menus
  "BrowserInvite.tsx": 6, // workstream E
  "BrowserWorkspace.tsx": 2, // agent presets (workstream E)
  "DesktopTerminals.tsx": 10, // Terminal and iTerm2 tabs (workstream T)
  "HomeLive.tsx": 3, // the default word; a Mac tab's badge (a PC's says PC)
  "MacPrompts.tsx": 6, // macOS permission prompts
  "MoveChat.tsx": 2, // default word
  "NeedsYou.tsx": 11, // macOS permission prompts
  "Screen.tsx": 5, // macOS permission prompts
  "ServiceAgentTools.tsx": 1, // saved browser tools (workstream G)
  "ToolBrowserSetup.tsx": 4, // saved browser tools (workstream G)
  "agent-admissions.tsx": 1, // agent presets (workstream E)
  "api.ts": 1, // computerWord's own words
  "passkeys.ts": 1,
  "pause.ts": 1, // computerWord itself
};
const src = new URL("../src/", import.meta.url);
const said = (text) =>
  (text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n")
    .match(/\bMac\b(?!OS)/g) || []).length;

test("pages shown on every computer say computerWord, not Mac; Mac-only features keep it", () => {
  const over = [];
  for (const name of fs.readdirSync(src).filter((f) => /\.tsx?$/.test(f)).sort()) {
    const count = said(fs.readFileSync(path.join(src.pathname, name), "utf8"));
    if (count > (ALLOWED[name] || 0)) over.push(`${name}: ${count} (allowed ${ALLOWED[name] || 0})`);
  }
  assert.deepEqual(over, [], "Use computerWord(peer.platform) from src/pause.ts for words every computer shows");
});
