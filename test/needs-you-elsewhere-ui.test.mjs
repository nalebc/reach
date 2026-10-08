import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, React, NeedsYouStrip, agentNeeds;
const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const session = {
  agent: "claude",
  id: "chat-1",
  title: "Fix the build",
  cwd: "/repo",
  branch: "main",
  origin: "app",
  inApp: true,
  updatedAt: 1,
  createdAt: 1,
  status: "waiting",
  preview: "",
  archived: false,
  live: { where: "claude-app", pid: 1, tty: null },
};
const asking = { kind: "permission", text: "npm run build", command: true, id: "app-permission:tool-1" };
before(async () => {
  dom = await startDom();
  React = dom.React;
  ({ NeedsYouStrip, agentNeeds } = await dom.load("/src/NeedsYou.tsx"));
});
after(async () => dom?.close());
const button = (container, label) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const click = async (element) => {
  assert.ok(element);
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(40);
};
const strip = (opened = []) =>
  React.createElement(NeedsYouStrip, {
    items: agentNeeds({ peer, sessions: [session], logos: {}, open: (s) => opened.push(s.id), answered: () => opened.push("answered") }),
  });

test("a chat waiting in the Claude app is answered in Needs you: Review reads its card, its button is pressed there", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    calls.push([init.method || "GET", pathname + search, init.body ? JSON.parse(init.body) : undefined]);
    if (pathname.endsWith("/card"))
      return reply({ id: asking.id, texts: ["Allow Claude to run", "npm run build"], buttons: ["Deny", "Allow once", "Always allow"] });
    if (pathname.includes("/prompts/")) return reply({ answered: true });
    return reply({ session: { ...session, asking }, items: [], before: null });
  };
  const opened = [];
  const view = await dom.render(strip(opened));
  await dom.waitFor(() => view.container.querySelector(".need-command"));
  assert.match(view.container.textContent, /npm run build/);
  assert.ok(button(view.container, "Open chat"));
  // Nothing is read from the app until Review: the Mac's window stays put.
  assert.ok(calls.every(([, route]) => !route.endsWith("/card")));
  await click(button(view.container, "Review"));
  await dom.waitFor(() => button(view.container, "Allow once"));
  assert.match(view.container.textContent, /Allow Claude to run/);
  assert.equal(button(view.container, "Allow once").className, "primary");
  await click(button(view.container, "Allow once"));
  await dom.waitFor(() => /Answered in the Claude app/.test(view.container.textContent));
  const answer = calls.find(([m]) => m === "POST");
  assert.equal(answer[1], `/api/sessions/claude/chat-1/prompts/${encodeURIComponent(asking.id)}`);
  assert.deepEqual(answer[2], { label: "Allow once" });
  assert.deepEqual(opened, ["answered"]);
  await view.unmount();
});

test("a card that can't be read says why and offers to bring it up in the app", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    calls.push([init.method || "GET", pathname + search]);
    if (pathname.endsWith("/card"))
      return search.includes("bring=1")
        ? reply({ id: asking.id, texts: ["Allow Claude to run"], buttons: ["Deny", "Allow once"] })
        : reply({ error: "The Claude app on your Mac shows another chat, and you're using it." }, 409);
    return reply({ session: { ...session, asking }, items: [], before: null });
  };
  const view = await dom.render(strip());
  await dom.waitFor(() => button(view.container, "Review"));
  await click(button(view.container, "Review"));
  await dom.waitFor(() => view.container.querySelector(".need-elsewhere .problem"));
  assert.match(view.container.textContent, /you're using it/);
  await click(button(view.container, "Bring it up in the Claude app"));
  await dom.waitFor(() => button(view.container, "Allow once"));
  assert.ok(calls.some(([, route]) => route.endsWith("/card?bring=1")));
  assert.ok(calls.every(([m]) => m === "GET"));
  await view.unmount();
});

test("a waiting chat that isn't on a permission keeps only Open chat", async () => {
  globalThis.fetch = dom.window.fetch = async () =>
    reply({ session: { ...session, asking: { kind: "dialog", text: "Claude Code has something open for you to answer." } }, items: [], before: null });
  const opened = [];
  const view = await dom.render(strip(opened));
  await settle(80);
  assert.equal(button(view.container, "Review"), undefined);
  await click(button(view.container, "Open chat"));
  assert.deepEqual(opened, ["chat-1"]);
  await view.unmount();
});
