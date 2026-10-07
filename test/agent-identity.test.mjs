import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sourceName, agentName } from "../server/notification-items.mjs";

// Oct 6 audit: each agent should read as itself inside Reach's unified look.
const src = (name) => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

test("Gemini wears its own ✦ in the Gemini CLI's gradient, not a generic sparkle", () => {
  const svg = src("assets/gemini.svg");
  for (const color of ["#4796E4", "#847ACE", "#C3677F"]) assert.ok(svg.includes(color), color);
  assert.match(src("agent-logos.tsx"), /BUNDLED: Record<string, string> = \{ openclaw: openClawLogo, gemini: geminiLogo \}/);
  assert.match(src("agent-logos.tsx"), /logos\[agent\] \|\| BUNDLED\[agent\]/);
  // Home draws it too, and the "+" sheet no longer gives every agent Codex's icon.
  assert.match(src("HomeLive.tsx"), /if \(kind === "gemini"\) return <AgentLogo agent="gemini"/);
  assert.match(src("HomeLive.tsx"), /kind=\{kindOf\(agent\)\}/);
});

test("a Gemini chat never says it waits in the Claude app, and its errors aren't Claude's card", () => {
  const session = src("AgentSession.tsx");
  assert.match(session, /: agent === "claude" && info\.live\?\.where !== "terminal"\s*\? "Claude app"\s*: "terminal"/);
  assert.match(session, /if \(agent !== "claude"\)\s*return \(\s*<div className="as-error codex">/);
});

test("every surface names the agents the same way", () => {
  assert.equal(sourceName("claude"), "Claude Code");
  assert.equal(sourceName("gemini"), "Gemini CLI");
  assert.equal(agentName("claude"), "Claude Code");
  assert.match(src("Notifications.tsx"), /claude: "Claude Code",\s*gemini: "Gemini CLI",/);
  assert.match(src("HomeLive.tsx"), /gemini: "Gemini CLI",\s*openclaw: "OpenClaw",/);
  assert.match(src("ChatList.tsx"), /\{ agent: "claude", name: "Claude Code", supported: true \}/);
});

test("OpenClaw's send button has its colors outside a chat page (it was transparent)", () => {
  assert.match(src("openclaw.css"), /\.claw-composer \{[^}]*--as-text: var\(--text-strong, #eef4ef\);[^}]*--as-send-ready: var\(--lime\);/);
  assert.match(src("OpenClawSpace.tsx"), /className=\{`as-send \$\{text\.trim\(\) \? "ready" : ""\}`\}/);
});
