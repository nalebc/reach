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
  // Chat's agent picker draws each agent by its own logo, never Codex's for
  // all (Home had the "+" sheet that did; it left Home with the Tools rework).
  assert.match(src("ChatList.tsx"), /<AgentLogo agent=\{app\.agent\} name=\{app\.name\}/);
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
  // Home shows the computer, not chats (Oct 25: its agent list went with the
  // Tools rework); it keeps no names of its own that could drift.
  assert.doesNotMatch(src("HomeLive.tsx"), /gemini: "Gemini CLI"|codex: "Codex"/);
  assert.match(src("ChatList.tsx"), /\{ agent: "claude", name: "Claude Code", supported: true \}/);
});

test("OpenClaw's send button has its colors outside a chat page (it was transparent)", () => {
  const css = src("openclaw.css");
  assert.match(css, /\.claw-app,[^{]*\{[^}]*--claw-white: #f3f3f3;[^}]*--claw-white-ink: #0d0d0d;/);
  assert.match(css, /\.claw-send \{[^}]*background: var\(--claw-white\);[^}]*color: var\(--claw-white-ink\);/);
  const chat = src("OpenClawSpace.tsx");
  assert.match(chat, /className="claw-conversation claw-app"/);
  assert.match(chat, /className=\{`claw-send\$\{text\.trim\(\) \? " ready" : ""\}`\}/);
});
