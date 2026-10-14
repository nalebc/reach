// A UI fixture with sample data only: the OpenClaw space (chats, a chat,
// Scheduled, Customize) and its setup. Nothing reaches a computer or OpenClaw.
// ?view=setup or install: not set up yet (key, install). ?view=wizard: guided setup,
// answered in this page's memory (&step=N opens at that step).
import React from "react";
import { createRoot } from "react-dom/client";
import OpenClawSpace from "../../src/OpenClawSpace";
import { ClawWizard } from "../../src/OpenClawWizard";
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
// Guided setup, as Reach's server hands OpenClaw's steps to the phone
// (server/openclaw-wizard.mjs): text scrubbed, options by index only.
const params = new URLSearchParams(location.search);
const view = params.get("view") || "";
const SECURITY = [
  "OpenClaw is an open-source assistant that learns and grows with you, by the OpenClaw Foundation (a non-profit).",
  "By default, OpenClaw is a personal agent for one operator.",
  "This bot can read files and run actions if tools are enabled.",
  "A bad prompt can trick it into doing unsafe things.",
  "",
  "OpenClaw is not designed to safely separate multiple users by default.",
  "If multiple users can message one tool-enabled agent, they can all influence how it uses its tools.",
  "",
  "If you're not comfortable managing access controls and security hardening, don't run OpenClaw without help.",
  "Ask someone experienced to help before enabling tools or exposing it to the internet.",
  "",
  "Recommended safer setup",
  "- Use pairing or allowlists; require mentions in group chats.",
  "- Shared inboxes: use separate gateways and credentials; separate OS users or hosts provide stronger isolation.",
  "- Use a sandbox and give tools only the permissions they need.",
  "- Shared inboxes: isolate DM sessions (session.dmScope: per-channel-peer) and keep tool access minimal.",
  "- Keep secrets outside the agent's reachable filesystem.",
  "- Use the strongest available model for bots with tools or shared/public inboxes.",
  "",
  "Run regularly",
  "openclaw security audit --deep",
  "openclaw security audit --fix",
  "",
  "Learn more at https://docs.openclaw.ai",
].join("\n");
const option = (label: string, hint = "") => ({ label, hint });
const STEPS = [
  { type: "note", title: "Security disclaimer", message: SECURITY },
  { type: "confirm", title: "", message: "I understand this is personal-by-default and shared/multi-user use requires lock-down. Continue?", selected: [1] },
  { type: "select", title: "", message: "Setup mode", selected: [0], options: [
    option("QuickStart (recommended)", "Recommended local setup. Change details later with openclaw configure."),
    option("Manual", "Configure port, network, Tailscale, and auth options."),
  ] },
  { type: "select", title: "", message: "Model/auth provider", selected: [1], options: [
    option("OpenAI", "Codex OAuth + API key"), option("Anthropic", "Claude API key"), option("OpenRouter", "API key"),
    option("Google", "Gemini API key + OAuth"), option("xAI (Grok)", "API key"), option("Mistral", "API key"),
    option("Moonshot AI (Kimi K2)", "Kimi K2 + Kimi Coding"), option("Z.AI (GLM 4.6)", "API key"), option("MiniMax", "M2 recommended"),
    option("Qwen", "OAuth"), option("Vercel AI Gateway", "API key"), option("GitHub Copilot", "GitHub device login"),
    option("Ollama", "Local models"), option("Skip for now"),
  ] },
  { type: "text", title: "", message: "Enter Anthropic API key", sensitive: true, placeholder: "sk-ant-…" },
  { type: "select", title: "", message: "Default model", selected: [0], options: [
    option("Keep current (anthropic/claude-sonnet-4-5)"), option("anthropic/claude-opus-4-1", "Claude Opus 4.1"),
    option("anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5"), option("anthropic/claude-haiku-4-5", "Claude Haiku 4.5"),
    option("Enter model manually"),
  ] },
  { type: "multiselect", title: "", message: "Select channels (QuickStart)", selected: [0], options: [
    option("WhatsApp", "QR link"), option("Telegram", "Bot API"), option("Discord", "Bot API"), option("Slack", "Socket Mode"),
    option("Signal", "signal-cli"), option("iMessage", "BlueBubbles"), option("Google Chat", "Chat API"),
    option("Microsoft Teams", "Bot Framework"), option("Matrix", "plugin"),
  ] },
  { type: "progress", title: "Gateway service", message: "Installing Gateway service…" },
  { type: "note", title: "Done", message: "OpenClaw is ready.\nDashboard: http://127.0.0.1:18789\nChat with it here in Reach, or on the apps you linked." },
].map((s, i) => ({ id: `step-${i + 1}`, title: "", sensitive: false, placeholder: "", options: [] as { label: string; hint: string }[], selected: [] as number[], ...s }))
  .map((s) => ({ ...s, options: s.options.map((o, index) => ({ index, ...o })) }));
let at = params.has("step") ? Number(params.get("step")) - 1 : -1;
let wizardStatus = at >= 0 ? "running" : params.get("status") || "idle";
// OpenClaw's progress never reaches the phone as a step: Reach shows it
// while it waits for the next one (busy). &device=1: a sign-in by code.
const progressOf = (s: (typeof STEPS)[number]) =>
  params.has("device")
    ? { title: "GitHub Copilot", message: "Enter this one-time code on GitHub's sign-in page.\nCode expires in 15 minutes.\nNever enter it on a page you didn't open yourself.", code: "WDJB-MJHT", link: "https://github.com/login/device" }
    : { title: s.title, message: s.message, code: "", link: "" };
const wizardState = () => {
  const step = wizardStatus === "running" ? STEPS[at] || null : null;
  const working = step?.type === "progress";
  return {
    supported: true,
    busy: working,
    status: wizardStatus,
    problem: params.get("problem") || "",
    progress: working && step ? progressOf(step) : null,
    step: working ? null : step,
  };
};
const advance = () => {
  at++;
  if (at >= STEPS.length) wizardStatus = "done";
  // Progress passes on its own, as OpenClaw finishes it.
  if (STEPS[at]?.type === "progress") setTimeout(advance, 2500);
};
const wizard: Record<string, (body: Record<string, unknown>) => unknown> = {
  start: () => { at = 0; wizardStatus = "running"; return wizardState(); },
  answer: () => { advance(); return wizardState(); },
  refresh: () => wizardState(),
  cancel: () => { wizardStatus = "cancelled"; at = -1; return wizardState(); },
};
// ?view=setup: installed, never set up. ?view=install: not installed.
if (view === "setup" || view === "install") {
  routes["/api/sessions/openclaw/overview"] = () => ({ connected: false, sessions: [], approvals: [], notSetUp: true });
  routes["/api/sessions/openclaw/onboard/status"] = () => ({ installed: view === "setup", configured: false, supported: true, providers: ["openrouter", "anthropic", "openai", "google"], setup: null });
}
routes["/api/sessions/openclaw/wizard"] = wizardState;

// A capture in a background tab still shows data (the page skips reads while hidden).
Object.defineProperty(document, "hidden", { get: () => false });
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const action = /\/api\/sessions\/openclaw\/wizard\/(\w+)$/.exec(url.pathname)?.[1];
  // Guided setup's answers stay in this page.
  if (init.method === "POST" && action && wizard[action])
    return Response.json(wizard[action](JSON.parse(String(init.body || "{}"))));
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
    {view === "wizard" ? (
      <ClawWizard peer={peer} onClose={noop} />
    ) : (
      <OpenClawSpace peer={peer} apps={apps} logos={{}} onAppChange={noop} appPending={{}} onReviewDevice={noop} onNew={noop} />
    )}
  </main>,
);
