import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const CATALOG = [
  { id: "github", name: "GitHub", description: "Repositories, issues and pull requests", url: "https://api.githubcopilot.com/mcp/", auth: "token", tokenUrl: "https://github.com/settings/personal-access-tokens/new" },
  { id: "linear", name: "Linear", description: "Issues, projects and cycles", url: "https://mcp.linear.app/mcp", auth: "oauth" },
  { id: "notion", name: "Notion", description: "Pages and databases", url: "https://mcp.notion.com/mcp", auth: "oauth" },
];
// Each agent as the computer reports it.
const state = () => ({
  claude: {
    agent: "claude", installed: true, signIn: true, manageUrl: "https://claude.ai/settings/connectors", catalog: CATALOG,
    native: [{ id: "claude.ai Gmail", name: "Gmail", state: "connected", detail: "gmailmcp.googleapis.com", logo: null }],
    servers: [{ name: "github", url: "api.githubcopilot.com/mcp/", remote: true, state: "connected", logo: null }],
  },
  codex: {
    agent: "codex", installed: true, signIn: true, manageUrl: "https://chatgpt.com/apps", catalog: CATALOG,
    native: [
      { id: "connector_gh", name: "GitHub", state: "connected", enabled: true, connectUrl: "https://chatgpt.com/apps/github/x", logo: null },
      { id: "connector_li", name: "Linear", state: "available", enabled: true, connectUrl: "https://chatgpt.com/apps/linear/y", logo: null },
    ],
    servers: [{ name: "acme", url: "mcp.acme.dev/mcp", remote: true, state: "connected", logo: "data:image/png;base64,iVBORw0KGgo=" }],
  },
  gemini: {
    agent: "gemini", installed: true, signIn: false, manageUrl: null, catalog: CATALOG, native: [],
    servers: [{ name: "linear", url: "mcp.linear.app/mcp", remote: true, state: "needs-auth", logo: null }],
  },
});
let dom, Connectors, agents, calls;
before(async () => {
  dom = await startDom({
    routes: {
      "/api/sessions/connectors": async (init, url) => {
        calls.push([init.method || "GET", url.search, init.body ? JSON.parse(init.body) : null]);
        if (init.method === "POST") {
          const body = JSON.parse(init.body);
          for (const a of body.agents) agents[a].servers.push({ name: body.name, url: "mcp.notion.com/mcp", remote: true, state: a === "gemini" ? "added" : "needs-auth", logo: null });
          return { name: body.name, results: body.agents.map((agent) => ({ agent, ok: true })) };
        }
        if (init.method === "DELETE") {
          const agent = url.searchParams.get("agent");
          agents[agent].servers = agents[agent].servers.filter((s) => s.name !== url.searchParams.get("name"));
          return { agent, name: url.searchParams.get("name") };
        }
        const agent = url.searchParams.get("agent");
        if (url.searchParams.get("q")) return { ...agents.codex, native: [{ id: "asdk_1", name: "Planner", description: "Plans", state: "available", connectUrl: "https://chatgpt.com/apps/planner/z", logo: null }] };
        return agents[agent];
      },
      "/api/sessions/connectors/login": async (init) => {
        calls.push([`${init.method || "GET"} login`, null, init.body ? JSON.parse(init.body) : null]);
        return { state: "link", url: "https://mcp.notion.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb", error: null };
      },
    },
  });
  dom.window.confirm = () => true;
  ({ default: Connectors } = await dom.load("/src/Connectors.tsx"));
});
after(() => dom?.close());
const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const row = (root, name) => [...root.querySelectorAll(".cn-item")].find((li) => li.querySelector(".cn-text strong")?.textContent === name);
async function show() {
  agents = state();
  calls = [];
  const view = await dom.render(dom.React.createElement(Connectors, { peer, logos: {} }));
  await dom.waitFor(() => view.container.querySelectorAll(".cn-item").length > 4);
  return view;
}

test("one list of services, each with its logo, who has it, and one thing to do", async () => {
  const view = await show();
  const c = view.container;
  const connected = c.querySelector('[aria-label="Connected"]');
  assert.deepEqual([...connected.querySelectorAll(".cn-text strong")].map((s) => s.textContent), ["acme", "GitHub", "Gmail", "Linear"]);
  // Brand marks shipped with Reach; a fetched logo; never a remote image.
  assert.equal(row(c, "GitHub").querySelector(".cn-logo svg path") !== null, true);
  assert.equal(row(c, "Gmail").querySelector(".cn-logo svg") !== null, true);
  assert.match(row(c, "acme").querySelector(".cn-logo img").getAttribute("src"), /^data:image\/png/);
  assert.equal([...c.querySelectorAll("img")].some((i) => /^https?:/.test(i.getAttribute("src"))), false);
  // Who has it, in words.
  assert.equal(row(c, "GitHub").querySelector(".cn-text small").textContent.trim(), "Claude Code and Codex");
  assert.equal(row(c, "Gmail").querySelector(".cn-text small").textContent.trim(), "Claude Code");
  assert.equal(row(c, "Linear").querySelector(".cn-text small").textContent.trim(), "Sign in for Gemini CLI");
  // Gemini signs in itself: no button here, its own command in the details.
  assert.equal(button(row(c, "Linear"), "Sign in"), undefined);
  dom.update(() => row(c, "Linear").querySelector(".cn-row-main").click());
  await settle();
  assert.match(row(c, "Linear").textContent, /run gemini, then \/mcp auth linear/);
  // Not added anywhere yet: Connect.
  const add = c.querySelector('[aria-label="Add a service"]');
  assert.deepEqual([...add.querySelectorAll(".cn-text strong")].map((s) => s.textContent), ["Notion", "Another service"]);
  assert.ok(button(row(c, "Notion"), "Connect"));
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("Connect adds a service to every agent at once, then signs each in, one after the other", async () => {
  const view = await show();
  const c = view.container;
  dom.update(() => button(row(c, "Notion"), "Connect").click());
  await settle();
  assert.match(row(c, "Notion").querySelector(".cn-form").textContent, /For Claude Code, Codex and Gemini CLI\./);
  dom.update(() => row(c, "Notion").querySelector('.cn-form button[type="submit"]').click());
  await dom.waitFor(() => c.querySelector(".cn-steps"));
  const posted = calls.find(([m]) => m === "POST");
  assert.deepEqual(posted[2], { agents: ["claude", "codex", "gemini"], name: "notion", url: "https://mcp.notion.com/mcp" });
  // Claude Code first (Gemini signs in itself), its sign-in started at once.
  const steps = [...c.querySelectorAll(".cn-steps > li")];
  assert.deepEqual(steps.map((s) => s.className), ["now", ""]);
  await dom.waitFor(() => calls.some(([m, , body]) => m === "POST login" && body.agent === "claude"));
  await dom.waitFor(() => c.querySelector(".cn-signin a.cn-btn"));
  assert.equal(c.querySelector(".cn-signin a.cn-btn").getAttribute("href").startsWith("https://mcp.notion.com/authorize"), true);
  // Skipped: Codex is next.
  dom.update(() => button(c.querySelector(".cn-steps li.now"), "Skip").click());
  await dom.waitFor(() => calls.some(([m, , body]) => m === "POST login" && body.agent === "codex"));
  assert.match(c.querySelector(".cn-flash").textContent, /Notion added for Claude Code, Codex and Gemini CLI\./);
  await view.unmount();
});

test("search narrows the list and finds ChatGPT apps for Codex; Remove from all removes it everywhere", async () => {
  const view = await show();
  const c = view.container;
  const input = c.querySelector('input[aria-label="Search services"]');
  dom.update(() => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    set.call(input, "pla");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await dom.waitFor(() => c.querySelector(".cn-apps"));
  assert.match(c.querySelector(".cn-apps").textContent, /Planner/);
  assert.equal(c.querySelector('.cn-apps a.cn-btn').getAttribute("href"), "https://chatgpt.com/apps/planner/z");
  dom.update(() => c.querySelector('[aria-label="Clear search"]').click());
  await settle();
  dom.update(() => row(c, "acme").querySelector(".cn-row-main").click());
  await settle();
  dom.update(() => button(row(c, "acme"), "Remove from all").click());
  await dom.waitFor(() => calls.some(([m, q]) => m === "DELETE" && q.includes("name=acme")));
  await dom.waitFor(() => !row(c, "acme"));
  await view.unmount();
});
