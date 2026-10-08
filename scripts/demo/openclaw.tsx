// A UI fixture with sample data only: the OpenClaw space (chats, a chat,
// Scheduled, Customize). Nothing reaches a computer or OpenClaw.
import React from "react";
import { createRoot } from "react-dom/client";
import OpenClawSpace from "../../src/OpenClawSpace";
import "../../src/styles.css";
import "../../src/atmosphere.css";
import "../../src/workspace.css";
import "../../src/app-style.css";
import "../../src/chat-list.css";
import "../../src/chat-hub.css";
import "../../src/chat-workspace.css";

const peer = { id: "preview", name: "Home Mac", url: location.origin, token: "sample-only", platform: "darwin" };
const now = Date.now();
const sessions = [
  { key: "agent:main:reach-1", title: "Plan the Lisbon trip", agentId: "main", channel: "webchat", writable: true, updatedAt: now - 120000, model: "anthropic/claude-sonnet-4-5", status: "idle" },
  { key: "agent:main:reach-2", title: "Draft the launch email", agentId: "main", channel: "webchat", writable: true, updatedAt: now - 3600000, model: "anthropic/claude-sonnet-4-5", status: "running" },
  { key: "agent:main:whatsapp:a", title: "Weekend plans", agentId: "main", channel: "whatsapp", updatedAt: now - 7200000, model: "openai/gpt-4o", status: "idle" },
  { key: "agent:main:telegram:b", title: "Grocery list", agentId: "main", channel: "telegram", updatedAt: now - 86400000, model: "openai/gpt-4o", status: "idle" },
  { key: "agent:work:discord:c", title: "Release notes", agentId: "work", channel: "discord", updatedAt: now - 2 * 86400000, model: "openai/gpt-4o", status: "idle" },
];
const jobs = [
  { id: "j1", name: "Morning briefing", agentId: "main", enabled: true, schedule: "0 8 * * *", nextRunAt: now + 5 * 3600000, lastRunAt: now - 19 * 3600000, status: "ok", error: "", delivery: "whatsapp" },
  { id: "j2", name: "Inbox check", agentId: "main", enabled: true, schedule: "0 */3 * * *", nextRunAt: now + 3600000, lastRunAt: now - 2 * 3600000, status: "ok", error: "", delivery: "webchat" },
  { id: "j3", name: "Weekly report", agentId: "work", enabled: false, schedule: "0 9 * * 1", nextRunAt: 0, lastRunAt: now - 6 * 86400000, status: "ok", error: "", delivery: "discord" },
];
const routes: Record<string, (url: URL) => unknown> = {
  "/api/sessions/openclaw/overview": () => ({ connected: true, sessions, approvals: [] }),
  "/api/sessions/openclaw/history": (url) => ({
    session: sessions.find((s) => s.key === url.searchParams.get("key")),
    items: [
      { id: "u1", role: "user", text: "Find me a 3-day plan for Lisbon in November, nothing too touristy.", tool: false },
      { id: "a1", role: "assistant", text: "Here's a relaxed plan:\n\n**Day 1 · Alfama & Graça**\n- Morning walk up to Miradouro da Senhora do Monte\n- Lunch at a tasca in Graça\n\n**Day 2 · Belém by bike**\n- Ride the river path, skip the monastery queue\n\n**Day 3 · LX Factory & Campo de Ourique**\n\nWant me to book anything?", tool: false },
      { id: "u2", role: "user", text: "Yes, find a dinner spot for day 2.", tool: false },
    ],
    streaming: "", error: "", approvals: [], mayHaveOlder: false,
  }),
  "/api/sessions/openclaw/automations": () => ({ jobs, canEdit: true, canAdd: true, canRun: true, canRemove: true, hasMore: false }),
  "/api/sessions/openclaw/channels": () => ({
    canLinkWhatsApp: true,
    channels: [
      { channel: "whatsapp", accountId: "personal", name: "Personal", status: "connected", error: "" },
      { channel: "telegram", accountId: "bot", name: "@home_claw_bot", status: "connected", error: "" },
      { channel: "discord", accountId: "work", name: "Work server", status: "disconnected", error: "Token expired" },
    ],
  }),
  "/api/sessions/openclaw/health": () => ({
    status: "ok", gateway: { supported: true, answered: true, ms: 42, version: "2026.10.1" }, uptime: { supported: true, ms: 9e6 },
    channels: { supported: true, failing: [] }, memory: { supported: true, bytes: 3.2e8 }, storage: { supported: true, dbBytes: 4e7, walBytes: 1e6, warn: false },
  }),
  "/api/sessions/openclaw/spend": () => ({ supported: true, scope: "all", today: 0.42, month: 12.3, days30: 14.1, partial: false, agents: null, limits: [], budget: 30 }),
  "/api/sessions/openclaw/spend/chat": () => ({ supported: true, cost: 0.18 }),
  "/api/sessions/openclaw/agents": () => ({ supported: true, agents: [
    { id: "main", name: "Personal assistant", emoji: "🦞", isDefault: true, model: "anthropic/claude-sonnet-4-5", running: 1, waiting: 0, subagents: [], recent: [] },
    { id: "work", name: "Work", emoji: "💼", isDefault: false, model: "openai/gpt-4o", running: 0, waiting: 0, subagents: [], recent: [] },
  ] }),
  "/api/sessions/openclaw/agents/rules": () => ({
    supported: true, canEdit: true, hash: "preview",
    all: { security: "allowlist", ask: "on-miss", allowlist: [{ pattern: "/opt/homebrew/bin/rg" }, { pattern: "/Users/sample/Projects/research/tools/summarize-documents" }] },
    agents: {},
  }),
  "/api/sessions/openclaw/skills": () => ({ supported: true, canToggle: true, canInstall: true, canSetup: true, skills: [
    { name: "weather", key: "weather", emoji: "🌤️", source: "bundled", bundled: true, state: "ready", blocked: false, missing: { bins: [], env: [], config: [], os: [] }, install: [] },
    { name: "github", key: "github", emoji: "🐙", source: "bundled", bundled: true, state: "ready", blocked: false, missing: { bins: [], env: [], config: [], os: [] }, install: [] },
    { name: "summarize", key: "summarize", emoji: "📄", source: "bundled", bundled: true, state: "off", blocked: false, missing: { bins: [], env: [], config: [], os: [] }, install: [] },
    { name: "memo", key: "memo", emoji: "📒", source: "bundled", bundled: true, state: "setup", blocked: false, missing: { bins: ["memo"], env: [], config: [], os: [] }, install: [{ id: "brew", kind: "brew", label: "Install memo" }] },
    { name: "notion", key: "notion", emoji: "📝", source: "bundled", bundled: true, state: "setup", blocked: false, missing: { bins: [], env: ["NOTION_API_KEY"], config: [], os: [] }, install: [], keyName: "NOTION_API_KEY" },
  ] }),
  "/api/sessions/openclaw/skills/check": () => ({
    check: "preview-only", name: "memo", emoji: "📒", source: "bundled", bundled: true,
    publisher: "Sample publisher", kind: "brew", package: "sample/tap/memo",
    packageFrom: "Homebrew", command: "brew install sample/tap/memo", scripts: [],
    access: { bins: ["memo"], env: [], config: [] }, warnings: ["internet"], level: "calm",
  }),
  "/api/sessions/openclaw/catalog": () => ({ defaultAgentId: "main", agents: [{ id: "main", name: "Personal assistant" }, { id: "work", name: "Work" }], models: [{ id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true }], canEdit: true, errors: [] }),
  "/api/sessions/logos": () => ({ version: "demo", logos: {} }),
};
// A capture in a background tab still shows data (the page skips reads while hidden).
Object.defineProperty(document, "hidden", { get: () => false });
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (init.method === "POST") return Response.json({ error: "Sample data only." }, { status: 403 });
  // Waits for changes: never answer (the page asks again on its own).
  if (url.pathname.endsWith("/changes")) return new Promise<Response>(() => {});
  const route = routes[url.pathname];
  return Response.json(route ? route(url) : {});
};
const apps = [
  { agent: "codex", name: "Codex", supported: true },
  { agent: "claude", name: "Claude Code", supported: true },
  { agent: "openclaw", name: "OpenClaw", supported: true },
];
const noop = () => {};
createRoot(document.getElementById("root")!).render(
  <main className="page-sessions">
    <OpenClawSpace peer={peer} apps={apps} logos={{}} onAppChange={noop} appPending={{}} onReviewDevice={noop} onNew={noop} />
  </main>,
);
