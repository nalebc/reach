import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";
const peer = {
  id: "claw-test",
  name: "Home Mac",
  url: "https://reach.test",
  token: "token",
  platform: "darwin",
};
const sessions = [
  {
    key: "agent:main:whatsapp:a",
    title: "Weekend plans",
    agentId: "main",
    channel: "whatsapp",
    canDeliver: true,
    updatedAt: Date.now(),
    model: "test",
    status: "idle",
  },
  {
    key: "agent:work:discord:b",
    title: "Launch notes",
    agentId: "work",
    channel: "discord",
    canDeliver: true,
    updatedAt: Date.now(),
    model: "test",
    status: "idle",
  },
  // A chat Reach made itself: the only kind Reach writes in.
  {
    key: "agent:main:reach-1a2b3c4d",
    title: "Login page",
    agentId: "main",
    channel: "webchat",
    writable: true,
    updatedAt: Date.now() - 1000,
    model: "test",
    status: "idle",
  },
];
let dom,
  Component,
  started = [],
  sent = [],
  reads = [],
  fail = false,
  approvals = [],
  // A Mac that says when OpenClaw changes (a waiting read per view).
  watched = null,
  overviewReads = 0,
  decisions = [],
  screenOpens = 0,
  // What an open chat's history adds (a model being retried…).
  historyExtra = {},
  removed = [],
  // OpenClaw's Gateway stopped; gatewayStarts: Start was tapped.
  down = false,
  gatewayStarts = 0,
  settingsSent = [],
  scheduleChanges = [],
  scheduleEnabled = true,
  setupCalls = [],
  whatsappStatus = "connected",
  settingsFail = false,
  settingsWait = null,
  catalogWait = null,
  catalogFail = false,
  newFail = false,
  newWait = null,
  view;
const base = "/api/sessions/openclaw";
before(async () => {
  dom = await startDom({
    routes: {
      [base + "/catalog"]: async () => {
        if (catalogWait) await catalogWait;
        if (catalogFail) return Response.json({ error: "Catalog unavailable" }, { status: 503 });
        return ({
        defaultAgentId: "main",
        agents: [
          { id: "main", name: "Personal assistant" },
          { id: "work", name: "Work assistant" },
        ],
        models: [{ id: "provider/model", name: "Test model", reasoning: true }, { id: "provider/fast", name: "Fast model", reasoning: false }],
        canEdit: true,
        errors: [],
      }); },
      [base + "/settings"]: async (init) => {
        const body = JSON.parse(init.body);
        settingsSent.push(body);
        if (settingsWait) await settingsWait;
        if (settingsFail)
          return Response.json(
            { error: "Gateway rejected settings" },
            { status: 409 },
          );
        historyExtra.session = {
          ...sessions.find((s) => s.key === body.key),
          ...historyExtra.session,
          ...(body.label !== undefined ? { title: body.label } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.thinkingLevel !== undefined ? { thinkingLevel: body.thinkingLevel } : {}),
        };
        return { saved: true };
      },
      [base + "/channels"]: () => ({
        canLinkWhatsApp: true,
        channels: [
          {
            channel: "whatsapp",
            accountId: "personal",
            name: "Personal account",
            status: whatsappStatus,
            error: "",
          },
          {
            channel: "discord",
            accountId: "work",
            name: "Work server",
            status: "disconnected",
            error: "Reconnect in OpenClaw",
          },
        ],
      }),
      [base + "/automations"]: (init) => {
        if (init.method === "POST") {
          const body = JSON.parse(init.body);
          scheduleChanges.push(body);
          scheduleEnabled = body.enabled;
          return { enabled: scheduleEnabled };
        }
        return {
          jobs: [
            {
              id: "daily",
              name: "Morning briefing",
              agentId: "main",
              enabled: scheduleEnabled,
              schedule: "0 8 * * *",
              nextRunAt: Date.now() + 3600000,
              lastRunAt: Date.now() - 86400000,
              status: "ok",
              error: "",
              delivery: "whatsapp",
            },
          ],
          canEdit: true,
          canAdd: true,
          canRun: true,
          canRemove: true,
          hasMore: false,
        };
      },
      [base + "/automations/new"]: (init) => (setupCalls.push(["new", JSON.parse(init.body)]), { id: "job-2" }),
      [base + "/automations/run"]: (init) => (setupCalls.push(["run", JSON.parse(init.body)]), { ran: true }),
      [base + "/automations/remove"]: (init) => (setupCalls.push(["remove", JSON.parse(init.body)]), { removed: true }),
      [base + "/channels/add"]: (init) => (setupCalls.push(["add", JSON.parse(init.body)]), { added: true }),
      [base + "/wizard"]: () => ({ supported: true, status: "idle", busy: false, problem: "", step: null }),
      [base + "/setup"]: (init) => (setupCalls.push(["setup", JSON.parse(init.body)]), { terminal: { id: "term-1" } }),
      [base + "/channels/whatsapp/link"]: (init) => (setupCalls.push(["link", JSON.parse(init.body)]), { qr: "data:image/png;base64,iVBORw0KGgo=", message: "" }),
      [base + "/channels/whatsapp/wait"]: () => (whatsappStatus = "connected", { connected: true, message: "Linked" }),
      [base + "/overview"]: () => (overviewReads++, down ? {
        connected: false,
        sessions: [],
        approvals: [],
        canStart: true,
        error: "OpenClaw Gateway is unavailable. Start OpenClaw on this computer, then retry.",
      } : {
        connected: true,
        sessions,
        approvals: [],
        ...(watched ? { version: watched.version } : {}),
      }),
      [base + "/changes"]: (_, url) => watched?.wait(url) ?? {},
      [base + "/history"]: (_, url) => {
        const key = url.searchParams.get("key");
        reads.push(key);
        return {
          session: sessions.find((s) => s.key === key),
          items: [
            {
              id: "hello",
              role: "assistant",
              text: "Ready to continue.",
              tool: false,
            },
            {
              id: "posted",
              role: "assistant",
              text: "Posted earlier.",
              tool: false,
              sentTo: "whatsapp",
            },
          ],
          approvals,
          streaming: "",
          error: "",
          ...historyExtra,
          ...(watched ? { version: watched.version } : {}),
        };
      },
      [base + "/remove"]: (init) => {
        removed.push(JSON.parse(init.body));
        return { removed: true };
      },
      [base + "/gateway/start"]: () => {
        gatewayStarts++;
        down = false;
        return { connected: true, sessions, approvals: [] };
      },
      [base + "/approval"]: (init) => {
        decisions.push(JSON.parse(init.body));
        if (fail) return Response.json({ error: "Gateway disconnected" }, { status: 503 });
        approvals = [];
        return { ok: true };
      },
      [base + "/new"]: async (init) => {
        started.push(JSON.parse(init.body));
        if (newWait) await newWait;
        if (newFail) return Response.json({ error: "Response lost" }, { status: 503 });
        const made = { key: "agent:main:reach-newchat", title: "Plan the trip", agentId: "main", channel: "webchat", writable: true, updatedAt: Date.now(), model: "test", status: "running" };
        if (!sessions.some((s) => s.key === made.key)) sessions.push(made);
        return { key: made.key };
      },
      [base + "/send"]: (init) => {
        sent.push(JSON.parse(init.body));
        return fail
          ? Response.json(
              { error: "Connection interrupted. Retry." },
              { status: 503 },
            )
          : { runId: "run" };
      },
      "/api/sessions/logos": () => ({ version: "test", logos: {} }),
    },
  });
  Component = (await dom.load("/src/EverythingChat.tsx")).default;
});
after(() => dom?.close());
afterEach(async () => {
  await view?.unmount();
  assert.deepEqual(dom.errors, []);
});
const button = (name) =>
  [...dom.document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === name || b.textContent.includes(name),
  );
const click = async (name) => {
  const b = button(name);
  assert.ok(b, name);
  b.click();
  await settle();
};
async function mount(waitFor = "Weekend plans", accountHealth = []) {
  sent = [];
  reads = [];
  fail = false;
  approvals = [];
  decisions = [];
  screenOpens = 0;
  historyExtra = {};
  removed = [];
  settingsSent = [];
  scheduleChanges = [];
  scheduleEnabled = true;
  settingsFail = false;
  settingsWait = null;
  catalogWait = null;
  catalogFail = false;
  newFail = false;
  newWait = null;
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
  view = await dom.render(
    dom.React.createElement(Component, {
      peer,
      onScreen: () => screenOpens++,
      feed: {
        sessions: [
          {
            agent: "codex",
            id: "c",
            title: "Only Codex",
            cwd: "/work",
            updatedAt: Date.now(),
            status: "idle",
          },
        ],
        health: [{ agent: "openclaw", name: "OpenClaw", installed: true, signedIn: false, supported: true },
          ...accountHealth],
        errors: {},
        failure: "",
        macPrompts: [],
        reload() {},
        recheck() {},
      },
    }),
  );
  await settle(80);
  if (!button("OpenClaw")) await click("Choose an app, All selected");
  await click("OpenClaw");
  await dom.waitFor(() =>
    dom.document.body.textContent.includes(waitFor),
  );
}
test("auto discovery is app-separated, searchable, and reads no messages until selection", async () => {
  await mount();
  assert.equal(dom.document.body.textContent.includes("Only Codex"), false);
  assert.equal(reads.length, 0);
  // A messaging app's name finds its chats (no filter chips: ChatGPT has none).
  await typeInto(dom.document.querySelector("input[type=search]"), "Discord");
  await settle();
  assert.equal(dom.document.body.textContent.includes("Weekend plans"), false);
  assert.ok(dom.document.body.textContent.includes("Launch notes"));
  await click("Clear search");
  await typeInto(dom.document.querySelector("input[type=search]"), "Weekend");
  await settle();
  assert.equal(dom.document.body.textContent.includes("Launch notes"), false);
  await click("Weekend plans");
  assert.equal(reads[0], sessions[0].key);
});
test("failed send retains draft and reuses id; nothing offers to post to WhatsApp or other apps", async () => {
  await mount();
  await click("Weekend plans");
  // Even when a server reports the session could deliver (canDeliver above):
  // Oct 5, a "reply via WhatsApp" reached a WhatsApp group of friends.
  await dom.waitFor(() => dom.document.body.textContent.includes("Posted earlier."));
  assert.equal(dom.document.querySelectorAll("select").length, 0);
  assert.match(dom.document.body.textContent, /Sent to WhatsApp/);
  // A WhatsApp group's chat: shown, never written to from Reach (a message
  // there runs the agent inside that group's context).
  assert.equal(dom.document.querySelector("textarea"), null);
  assert.equal(button("Send to OpenClaw"), undefined);
  assert.match(dom.document.querySelector(".claw-readonly").textContent, /Read only\. Reach doesn’t write in this WhatsApp chat\./);
  await view.unmount();
  await mount();
  // A chat Reach made: written to, replies stay in Reach.
  await click("Login page");
  await dom.waitFor(() => dom.document.querySelector("textarea"));
  await typeInto(dom.document.querySelector("textarea"), "Please continue");
  fail = true;
  await click("Send to OpenClaw");
  assert.equal(dom.document.querySelector("textarea").value, "Please continue");
  assert.deepEqual(Object.keys(sent[0]).sort(), ["key", "requestId", "text"]);
  assert.equal(sent[0].key, sessions[2].key);
  fail = false;
  await click("Send to OpenClaw");
  assert.equal(sent[0].requestId, sent[1].requestId);
  assert.equal(dom.document.querySelector("textarea").value, "");
  await typeInto(dom.document.querySelector("textarea"), "Next one");
  await click("Send to OpenClaw");
  assert.deepEqual(Object.keys(sent.at(-1)).sort(), ["key", "requestId", "text"]);
  assert.notEqual(sent.at(-1).requestId, sent[0].requestId);
});

test("real OpenClaw approval failures remain actionable, successful replies carry the exact pending id", async () => {
  await mount();
  approvals = [{ id: "real-approval", command: "npm test", canRespond: true }];
  await click("Weekend plans");
  await dom.waitFor(() => button("Allow once"));
  fail = true;
  await click("Allow once");
  assert.deepEqual(decisions[0], { id: "real-approval", decision: "allow-once" });
  assert.match(dom.document.body.textContent, /Gateway disconnected/);
  assert.equal(button("Allow once").disabled, false);
  fail = false;
  await click("Deny");
  assert.deepEqual(decisions[1], { id: "real-approval", decision: "deny" });
  await dom.waitFor(() => !button("Allow once"));
});

test("OpenClaw offers its native Always allow choice and sends it only when tapped", async () => {
  await mount();
  approvals = [{ id: "persistent-approval", command: "npm test", canRespond: true }];
  await click("Weekend plans");
  await dom.waitFor(() => button("Always allow"));
  assert.deepEqual(decisions, []);
  await click("Always allow");
  assert.deepEqual(decisions, [{ id: "persistent-approval", decision: "allow-always" }]);
});

test("OpenClaw without a response channel offers live screen and no pretend approval buttons", async () => {
  await mount();
  approvals = [{ id: "screen-only", command: "npm test", canRespond: false }];
  await click("Weekend plans");
  await dom.waitFor(() => dom.document.body.textContent.includes("Answer this request in OpenClaw"));
  assert.equal(button("Allow once"), undefined);
  assert.equal(button("Deny"), undefined);
  const screen = dom.document.querySelector(".need-screen button");
  assert.ok(screen);
  screen.click();
  assert.equal(screenOpens, 1);
  assert.equal(decisions.length, 0);
});

test("a new OpenClaw chat starts from New chat, as a chat of Reach's own, and opens", async () => {
  // Before: "Your OpenClaw sessions are discovered automatically", and no way to start one.
  await mount();
  started = [];
  await click("New chat");
  const sheet = () => dom.document.querySelector('[role="dialog"]');
  sheet().querySelector(".chat-app-switch-current").click();
  await settle();
  [...sheet().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "OpenClaw").click();
  await settle();
  assert.doesNotMatch(sheet().textContent, /discovered automatically/);
  await typeInto(sheet().querySelector('textarea[aria-label="New OpenClaw chat"]'), "Plan the trip");
  [...sheet().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Start").click();
  await dom.waitFor(() => reads.includes("agent:main:reach-newchat"));
  // With its own request id: asked again, the Mac starts the same chat.
  assert.deepEqual(started.map((s) => s.text), ["Plan the trip"]);
  assert.match(started[0].requestId, /^[\w-]{8,}$/);
  assert.equal(dom.document.querySelector('[role="dialog"]'), null);
});

// "Make everything evented" (2026-10-06): the page asked for the list every
// 5 s and an open chat every 1.8 s; now it waits for the Mac to say so.
test("with a Mac that says when OpenClaw changes, the list and an open chat are read again then, not on a beat", async () => {
  watched = {
    version: "1",
    waits: [],
    wait(url) {
      return new Promise((resolve) => this.waits.push({ key: url.searchParams.get("key"), after: url.searchParams.get("after"), resolve }));
    },
  };
  try {
    await mount();
    await dom.waitFor(() => watched.waits.length === 1);
    assert.deepEqual([watched.waits[0].key, watched.waits[0].after], [null, "1"]);
    const before = overviewReads;
    watched.waits[0].resolve({ version: "2" });
    await dom.waitFor(() => overviewReads === before + 1, 1000);
    // An open chat waits on its own changes, and is read again when told.
    await click("Weekend plans");
    await dom.waitFor(() => watched.waits.some((w) => w.key === sessions[0].key));
    const asked = reads.length;
    watched.waits.find((w) => w.key === sessions[0].key).resolve({ version: "2" });
    await dom.waitFor(() => reads.length === asked + 1, 1000);
  } finally {
    for (const w of watched.waits) w.resolve({});
    watched = null;
  }
});

test("a chat Reach made is deleted, in OpenClaw too, only after a second tap; others offer no delete", async () => {
  await mount();
  await click("Weekend plans");
  await dom.waitFor(() => dom.document.body.textContent.includes("Ready to continue."));
  assert.equal(button("Delete chat"), undefined);
  await click("Back to OpenClaw sessions");
  await click("Login page");
  await dom.waitFor(() => !!button("Delete chat"));
  await click("Delete chat");
  assert.deepEqual(removed, []);
  await click("Tap again to delete this chat");
  await dom.waitFor(() => removed.length === 1);
  assert.deepEqual(removed, [{ key: "agent:main:reach-1a2b3c4d" }]);
  await dom.waitFor(() => !!button("Refresh apps and chats"));
});

test("while OpenClaw tries another model, the chat says why and keeps working", async () => {
  // Oct 6, live: Anthropic had no credit; OpenClaw answered on gpt-4o.
  await mount();
  historyExtra = { session: { ...sessions[2], status: "running" }, phase: "retrying", retrying: "Your credit balance is too low" };
  await click("Login page");
  await dom.waitFor(() => /trying another/.test(dom.document.body.textContent));
  assert.match(dom.document.body.textContent, /That model didn’t answer \(Your credit balance is too low\)\. OpenClaw is trying another…/);
  assert.equal(dom.document.querySelector(".claw-error"), null);
});

test("a stopped OpenClaw Gateway is started from Reach with one tap", async () => {
  down = true;
  gatewayStarts = 0;
  try {
    await mount("Start OpenClaw on Home Mac");
    await click("Start OpenClaw on Home Mac");
    await dom.waitFor(() => dom.document.body.textContent.includes("Weekend plans"));
    assert.equal(gatewayStarts, 1);
    assert.equal(button("Start OpenClaw on Home Mac"), undefined);
  } finally {
    down = false;
  }
});

test("the shared mobile header switches away from OpenClaw and exposes search and new chat", async () => {
  await mount();
  await click("Choose an app, OpenClaw selected");
  assert.equal(
    dom.document
      .querySelector("[role=menuitemradio][aria-label=OpenClaw]")
      .getAttribute("aria-checked"),
    "true",
  );
  dom.document.querySelector("[role=menuitemradio][aria-label=Codex]").click();
  await dom.waitFor(() => dom.document.body.textContent.includes("Only Codex"));
  await click("Choose an app, Codex selected");
  dom.document
    .querySelector("[role=menuitemradio][aria-label=OpenClaw]")
    .click();
  await dom.waitFor(() =>
    dom.document.body.textContent.includes("Weekend plans"),
  );
  await click("Search chats");
  assert.ok(dom.document.querySelector(".claw-library.search-open"));
  assert.equal(
    dom.document.activeElement.getAttribute("aria-label"),
    "Search OpenClaw sessions",
  );
  await click("Chat list menu");
  assert.ok(
    dom.document.querySelector('[role=menu][aria-label="Chat actions"]'),
  );
});

test("a conversation can switch apps directly; channel conversations offer no settings", async () => {
  await mount();
  await click("Weekend plans");
  assert.equal(button("OpenClaw chat settings"), undefined);
  await click("Choose an app, OpenClaw selected");
  assert.ok(dom.document.querySelector(".claw-app-switch"));
  await click("Codex");
  await dom.waitFor(() => dom.document.body.textContent.includes("Only Codex"));
});

test("chat name, model and thinking settings preserve failed edits and save the selected values", async () => {
  await mount();
  await click("Login page");
  await click("OpenClaw chat settings");
  await dom.waitFor(
    () => dom.document.querySelector('[aria-label="OpenClaw model"]'),
  );
  await typeInto(
    dom.document.querySelector('[aria-label="OpenClaw chat name"]'),
    " improved",
  );
  const select = (label, value) => {
    const el = dom.document.querySelector(`[aria-label="${label}"]`);
    el.value = value;
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  select("OpenClaw model", "provider/fast");
  await settle();
  assert.equal(dom.document.querySelector('[aria-label="OpenClaw thinking level"]').disabled, true);
  assert.equal(dom.document.querySelector('[aria-label="OpenClaw thinking level"]').value, "off");
  select("OpenClaw model", "provider/model");
  select("OpenClaw thinking level", "high");
  await settle();
  settingsFail = true;
  await click("Save changes");
  assert.match(dom.document.body.textContent, /Gateway rejected settings/);
  assert.equal(
    dom.document.querySelector('[aria-label="OpenClaw chat name"]').value,
    "Login page improved",
  );
  settingsFail = false;
  await click("Save changes");
  assert.deepEqual(settingsSent.at(-1), {
    key: sessions[2].key,
    label: "Login page improved",
    model: "provider/model",
    thinkingLevel: "high",
  });
  assert.equal(dom.document.querySelector(".claw-settings"), null);
  await dom.waitFor(
    () =>
      dom.document.querySelector("h1").textContent === "Login page improved",
  );
});

test("new chats expose configured agents and carry model and thinking choices with the first message", async () => {
  await mount();
  started = [];
  await click("New chat");
  await dom.waitFor(() =>
    dom.document.querySelector('[aria-label="OpenClaw agent"]'),
  );
  const choose = (label, value) => {
    const el = dom.document.querySelector(`[aria-label="${label}"]`);
    el.value = value;
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  choose("OpenClaw agent", "work");
  assert.ok(!dom.document.querySelector(".as-box .claw-new-agent"), "the agent belongs above the composer");
  assert.equal(button("Model & thinking").textContent, "", "settings use an accessible icon button");
  await click("Model & thinking");
  choose("OpenClaw model", "provider/model");
  choose("OpenClaw thinking level", "high");
  await settle();
  assert.match(button("Model & thinking").getAttribute("aria-description"), /Test model.*high/);
  assert.equal(button("Model & thinking").getAttribute("data-custom"), "true");
  await click("Close model and thinking");
  assert.equal(dom.document.querySelector('[aria-label="OpenClaw model"]'), null);
  await click("Model & thinking");
  assert.equal(dom.document.querySelector('[aria-label="OpenClaw model"]').value, "provider/model", "closing settings preserves the selection");
  await typeInto(
    dom.document.querySelector('textarea[aria-label="New OpenClaw chat"]'),
    "Research the trip",
  );
  assert.equal(
    button("Start").disabled,
    false,
    dom.document.querySelector('[role="dialog"]').textContent,
  );
  await click("Start");
  await dom.waitFor(() => started.length > 0);
  assert.equal(started[0].agentId, "work");
  assert.equal(started[0].model, "provider/model");
  assert.equal(started[0].thinkingLevel, "high");
  assert.equal(started[0].text, "Research the trip");
});

test("schedules show delivery and run timing, pause and resume; channels show connection errors", async () => {
  await mount();
  await click("Scheduled");
  await dom.waitFor(() => button("Morning briefing"));
  // A task opens in a sheet: its facts, then its actions.
  await click("Morning briefing");
  await dom.waitFor(() => button("Pause Morning briefing"));
  assert.match(
    dom.document.querySelector('[role="dialog"]').textContent,
    /Repeats.*Daily at.*Next run.*Last run.*Sends to.*WhatsApp/,
  );
  await click("Pause Morning briefing");
  await dom.waitFor(() => button("Resume Morning briefing"));
  assert.deepEqual(scheduleChanges, [{ id: "daily", enabled: false }]);
  await click("Resume Morning briefing");
  await dom.waitFor(() => button("Pause Morning briefing"));
  assert.deepEqual(scheduleChanges.at(-1), { id: "daily", enabled: true });
  await click("Close morning briefing");
  await click("Back to OpenClaw");
  await click("Customize");
  await dom.waitFor(() =>
    dom.document.body.textContent.includes("Personal account"),
  );
  assert.match(
    dom.document.querySelector('[aria-label="Messaging apps"]').textContent,
    /WhatsApp.*Personal account.*Connected.*Discord.*Work server.*Disconnected/,
  );
  await click("Discord");
  assert.match(dom.document.querySelector('[role="dialog"]').textContent, /Reconnect in OpenClaw/);
  await click("Close discord");
  assert.equal(sent.length, 0);
  assert.equal(reads.length, 0);
  await click("Back to OpenClaw");
  await click("Choose an app, OpenClaw selected");
  dom.document.querySelector("[role=menuitemradio][aria-label=Codex]").click();
  await dom.waitFor(() => dom.document.body.textContent.includes("Only Codex"));
});

test("missing things are asked for: a schedule is added, run and deleted; advanced setup stays in Reach; WhatsApp links by QR", async () => {
  setupCalls = [];
  await mount();
  await click("Scheduled");
  await dom.waitFor(() => button("New task"));
  // Suggestions start from their words; one already scheduled isn't offered.
  assert.ok(button("Inbox check") && button("Weekly plan"));
  assert.equal(dom.document.querySelectorAll(".claw-task.suggested").length, 2);
  await click("New task");
  await typeInto(dom.document.querySelector('[aria-label="Schedule name"]'), "Evening recap");
  await typeInto(dom.document.querySelector('[aria-label="What OpenClaw does each time"]'), "Recap my day");
  await click("Add schedule");
  await dom.waitFor(() => setupCalls.some(([k]) => k === "new"));
  const made = setupCalls.find(([k]) => k === "new")[1];
  assert.equal(made.expr, "0 9 * * *");
  assert.equal(made.name, "Evening recap");
  assert.equal(made.announce, false);
  await dom.waitFor(() => !dom.document.querySelector('[role="dialog"]'));
  await click("Morning briefing");
  await dom.waitFor(() => button("Run Morning briefing now"));
  await click("Run Morning briefing now");
  await dom.waitFor(() => setupCalls.some(([k]) => k === "run"));
  await click("Delete Morning briefing");
  assert.ok(!setupCalls.some(([k]) => k === "remove"), "one tap only asks");
  await click("Tap again to delete Morning briefing");
  await dom.waitFor(() => setupCalls.some(([k]) => k === "remove"));
  const opened = [];
  dom.window.addEventListener("reach:open-terminal", (e) => opened.push(e.detail));
  whatsappStatus = "unconfigured";
  await dom.waitFor(() => !dom.document.querySelector('[role="dialog"]'));
  await click("Back to OpenClaw");
  await click("Customize");
  await dom.waitFor(() => button("Connect WhatsApp"));
  await click("Add a messaging app");
  await click("Other apps");
  await dom.waitFor(() => button("Start guided setup"));
  assert.deepEqual(opened, []);
  assert.equal(setupCalls.some(([k]) => k === "setup"), false);
  await click("Close guided openclaw setup");
  await click("Close add a messaging app");
  await click("Connect WhatsApp");
  await dom.waitFor(() => dom.document.querySelector('img[alt="WhatsApp link QR code"]') || dom.document.body.textContent.includes("is linked"));
  assert.deepEqual(setupCalls.find(([k]) => k === "link")[1], {});
  await dom.waitFor(() => dom.document.body.textContent.includes("WhatsApp is linked"));
});

test("a pending save cannot close a reopened OpenClaw settings draft", async () => {
  await mount();
  await click("Login page");
  await click("OpenClaw chat settings");
  await dom.waitFor(() => dom.document.querySelector('[aria-label="OpenClaw model"]'));
  let finish;
  settingsWait = new Promise((resolve) => { finish = resolve; });
  try {
    await typeInto(dom.document.querySelector('[aria-label="OpenClaw chat name"]'), " pending");
    await click("Save changes");
    await dom.waitFor(() => settingsSent.length === 1);
    await click("Cancel");
    await click("OpenClaw chat settings");
    await dom.waitFor(() => dom.document.querySelector('[aria-label="OpenClaw model"]'));
    await typeInto(dom.document.querySelector('[aria-label="OpenClaw chat name"]'), " newer draft");
    finish();
    await settle(80);
    assert.ok(dom.document.querySelector(".claw-settings"), "old completion must not close the newer form");
    assert.equal(dom.document.querySelector('[aria-label="OpenClaw chat name"]').value, "Login page newer draft");
    assert.equal(settingsSent.length, 1, "closing and reopening does not retry a dispatched save");
    assert.equal(dom.document.querySelector('[role="alert"]'), null);
  } finally {
    finish();
    settingsWait = null;
  }
});


test("late catalog arrival preserves the exact uncertain new-chat attempt until user intent changes", async () => {
  await mount(); started = []; newFail = true;
  let release;
  catalogWait = new Promise(resolve => { release = resolve; });
  try {
    await click("New chat");
    await typeInto(dom.document.querySelector('textarea[aria-label="New OpenClaw chat"]'), "One task only");
    await click("Start");
    assert.equal(started.length, 1);
    assert.match(dom.document.body.textContent, /Response lost/);
    assert.equal(Object.hasOwn(started[0], "agentId"), false);
    release();
    await dom.waitFor(() => dom.document.querySelector('[aria-label="OpenClaw agent"]'));
    await click("Start");
    assert.equal(started.length, 2);
    assert.deepEqual(started[1], started[0], "catalog discovery must not create a duplicate task identity or change its body");
    const agent = dom.document.querySelector('[aria-label="OpenClaw agent"]');
    agent.value = "work";
    agent.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle(); await click("Start");
    assert.equal(started.length, 3);
    assert.equal(started[2].agentId, "work");
    assert.notEqual(started[2].requestId, started[0].requestId, "an explicit changed choice starts a distinct attempt");
  } finally { release(); catalogWait = null; newFail = false; }
});

test("a failed model catalog does not prevent starting with Gateway defaults", async () => {
  await mount(); started = []; catalogFail = true;
  try {
    await click("New chat"); await click("Model & thinking");
    await dom.waitFor(() => dom.document.body.textContent.includes("Catalog unavailable"));
    await typeInto(dom.document.querySelector('textarea[aria-label="New OpenClaw chat"]'), "Use the default agent");
    await click("Start"); await dom.waitFor(() => started.length === 1);
    assert.equal(started[0].text, "Use the default agent");
    assert.equal(Object.hasOwn(started[0], "agentId"), false);
    assert.equal(Object.hasOwn(started[0], "model"), false);
  } finally { catalogFail = false; }
});


test("closing a pending OpenClaw start and switching apps cannot be undone by its late response", async () => {
  await mount(); started = [];
  let finish;
  newWait = new Promise(resolve => { finish = resolve; });
  try {
    await click("New chat");
    await typeInto(dom.document.querySelector('textarea[aria-label="New OpenClaw chat"]'), "Pending task");
    await click("Start"); await dom.waitFor(() => started.length === 1);
    await click("Close new conversation");
    await click("Choose an app, OpenClaw selected");
    dom.document.querySelector('[role="menuitemradio"][aria-label="Codex"]').click();
    await dom.waitFor(() => dom.document.body.textContent.includes("Only Codex"));
    finish(); await settle(100);
    assert.ok(dom.document.body.textContent.includes("Only Codex"), "late OpenClaw success must not change the selected provider");
    assert.equal(dom.document.querySelector('[aria-label="OpenClaw conversation"]'), null);
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(started.length, 1, "the already dispatched task is not retried or claimed cancelled");
  } finally { finish(); newWait = null; }
});

test("a messaging app is added in Reach by its bot token, not in a terminal", async () => {
  setupCalls = [];
  await mount();
  await click("Customize");
  await dom.waitFor(() => button("Add a messaging app"));
  await click("Add a messaging app");
  await dom.waitFor(() => dom.document.querySelector('[aria-label="Telegram bot token"]'));
  assert.equal(button("Add Telegram").disabled, true);
  dom.document.querySelector('[role=radio][aria-checked=false]').click();
  await dom.waitFor(() => dom.document.querySelector('[aria-label="Discord bot token"]'));
  const field = dom.document.querySelector('[aria-label="Discord bot token"]');
  assert.equal(field.type, "password");
  await typeInto(field, "  MTA-secret-token  ");
  await click("Add Discord");
  await dom.waitFor(() => setupCalls.some(([k]) => k === "add"));
  assert.deepEqual(setupCalls.find(([k]) => k === "add")[1], { channel: "discord", token: "MTA-secret-token" });
  await dom.waitFor(() => dom.document.body.textContent.includes("Discord is added"));
  assert.ok(!dom.document.body.textContent.includes("MTA-secret-token"));
});


test("OpenClaw keeps account limits visible in the provider dropdown and conversation rail", async () => {
  await mount("Weekend plans", [
    { agent: "claude", name: "Claude Code", installed: true, signedIn: true, supported: true, usable: false },
    { agent: "codex", name: "Codex", installed: true, signedIn: true, supported: true, usage: { available: true, windows: [{ label: "Weekly", usedPercent: 42 }] } },
  ]);
  await click("Choose an app, OpenClaw selected");
  const claude = dom.document.querySelector('.chat-mobile-app-menu [aria-label="Claude Code"]');
  assert.ok(claude.querySelector(".usage-ring.out"));
  assert.equal(claude.querySelector(".chat-menu-usage").textContent, "Out");
  assert.match(claude.getAttribute("aria-description"), /out of usage/);
  const codex = dom.document.querySelector('.chat-mobile-app-menu [aria-label="Codex"]');
  assert.equal(codex.querySelector(".chat-menu-usage").textContent, "42%");
  await click("Choose an app, OpenClaw selected");
  await click("Login page");
  await click("Choose an app, OpenClaw selected");
  await dom.waitFor(() => dom.document.querySelector(".chat-app-rail"));
  assert.ok(dom.document.querySelector('.chat-app-rail [aria-label="Claude Code"] .usage-ring.out'));
  assert.deepEqual(dom.errors, []);
});

test("a connection failure keeps retry and Customize available", async () => {
  down = true;
  try {
    await mount("Start OpenClaw on Home Mac");
    const before = overviewReads;
    assert.ok(button("Retry connection"));
    assert.equal(button("Scheduled").disabled, true);
    await click("Retry connection");
    await dom.waitFor(() => overviewReads > before);
    await click("Customize");
    assert.ok(button("Agents"));
    assert.ok(button("Back to OpenClaw"));
  } finally { down = false; }
});
