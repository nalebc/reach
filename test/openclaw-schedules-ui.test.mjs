import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, replaceText } from "./dom/harness.mjs";

const peer = { id: "claw-test", name: "Home Mac", url: "https://reach.test", token: "token", platform: "darwin" };
const base = "/api/sessions/openclaw";
let dom, More, view, edits = [], raw;
const job = (over = {}) => ({
  id: "daily",
  name: "Morning briefing",
  agentId: "main",
  enabled: true,
  schedule: "Daily at 08:00",
  nextRunAt: Date.now() + 3600000,
  lastRunAt: Date.now() - 3600000,
  status: "ok",
  error: "",
  delivery: "whatsapp",
  ...over,
});
const rawJob = () => ({
  id: "daily",
  name: "Morning briefing",
  agentId: "main",
  target: "isolated",
  schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Paris" },
  kind: "agentTurn",
  message: "Summarize my mail",
  editable: true,
  delivery: { mode: "announce", channel: "last", accountId: "" },
});

before(async () => {
  dom = await startDom({
    routes: {
      [base + "/catalog"]: () => ({
        defaultAgentId: "main",
        agents: [{ id: "main", name: "Personal" }, { id: "work", name: "Work" }],
        models: [],
        canEdit: true,
        errors: [],
      }),
      [base + "/channels"]: () => ({
        channels: [
          { channel: "whatsapp", accountId: "personal", name: "Personal", status: "connected", error: "" },
          { channel: "discord", accountId: "work", name: "Work", status: "disconnected", error: "" },
        ],
      }),
      [base + "/automations/history"]: () => ({
        supported: true,
        hasMore: false,
        nextOffset: null,
        runs: [
          { at: Date.now() - 1000, status: "error", durationMs: 102000, tokens: 28763, model: "", error: "OpenClaw reported an error.", deliveryError: "", chat: { key: "k", title: "Run abcdef12" } },
          { at: Date.now() - 86400000, status: "ok", durationMs: 8000, tokens: 0, model: "", error: "", deliveryError: "", chat: null },
        ],
      }),
      [base + "/automations/job"]: () => ({ supported: true, job: raw }),
      [base + "/automations/edit"]: (init) => (edits.push(JSON.parse(init.body)), { saved: true }),
    },
  });
  More = (await dom.load("/src/OpenClawScheduleMore.tsx")).ClawScheduleMore;
});
after(() => dom?.close());
afterEach(async () => {
  await view?.unmount();
  assert.deepEqual(dom.errors, []);
});
const button = (label) =>
  [...dom.document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent === label);
const field = (label) => dom.document.querySelector(`[aria-label="${label}"]`);
const choose = async (label, value) => {
  const el = field(label);
  dom.update(() => {
    el.value = value;
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await settle();
};

test("history pill lists past runs", async () => {
  view = await dom.render(dom.React.createElement(More, { peer, job: job(), canEdit: false, onChanged() {} }));
  assert.equal(button("Edit Morning briefing"), undefined);
  button("History Morning briefing").click();
  await dom.waitFor(() => view.container.textContent.includes("Run abcdef12"));
  const text = view.container.textContent;
  assert.match(text, /Failed/);
  assert.match(text, /1m 42s/);
  assert.match(text, /29k tokens/);
  assert.match(text, /Done/);
  assert.doesNotMatch(text, /Failed last run/);
});

test("a recent failure shows its reason", async () => {
  view = await dom.render(
    dom.React.createElement(More, { peer, job: job({ status: "error", error: "OpenClaw reports a timeout." }), canEdit: true, onChanged() {} }),
  );
  assert.match(view.container.textContent, /Failed last run.*timeout/);
});

test("edit pill saves only what changed", async () => {
  raw = rawJob();
  edits = [];
  let changed = 0;
  view = await dom.render(dom.React.createElement(More, { peer, job: job(), canEdit: true, onChanged: () => changed++ }));
  button("Edit Morning briefing").click();
  await dom.waitFor(() => field("Schedule name"));
  assert.equal(field("Schedule name").value, "Morning briefing");
  assert.equal(field("How often").value, "weekdays");
  assert.equal(field("Time").value, "08:00");
  assert.equal(field("Time zone").value, "Europe/Paris");
  assert.equal(field("Where results go").value, "last");
  assert.ok([...field("Where results go").options].some((o) => o.value === "ch:whatsapp:personal"));
  assert.ok(![...field("Where results go").options].some((o) => o.value.startsWith("ch:discord")));
  await replaceText(field("Schedule name"), "Briefing");
  button("Save").click();
  await dom.waitFor(() => changed === 1);
  assert.deepEqual(edits[0], { id: "daily", name: "Briefing", message: "Summarize my mail" });

  button("Edit Morning briefing").click();
  await dom.waitFor(() => field("Schedule name"));
  await choose("How often", "daily");
  await choose("Where results go", "ch:whatsapp:personal");
  await replaceText(field("Recipient"), "+1555");
  button("Save").click();
  await dom.waitFor(() => changed === 2);
  assert.deepEqual(edits[1], {
    id: "daily",
    name: "Morning briefing",
    message: "Summarize my mail",
    expr: "0 8 * * *",
    tz: "Europe/Paris",
    delivery: "channel",
    channel: "whatsapp",
    accountId: "personal",
    to: "+1555",
  });
});

test("an expression the form can't show keeps its schedule unless one is chosen", async () => {
  raw = { ...rawJob(), schedule: { kind: "cron", expr: "0 0 8 * * *", tz: "" }, delivery: { mode: "webhook", channel: "", accountId: "" } };
  edits = [];
  let changed = 0;
  view = await dom.render(dom.React.createElement(More, { peer, job: job(), canEdit: true, onChanged: () => changed++ }));
  button("Edit Morning briefing").click();
  await dom.waitFor(() => field("Schedule name"));
  assert.equal(field("How often").value, "keep");
  assert.equal(field("Where results go").value, "keep");
  button("Save").click();
  await dom.waitFor(() => changed === 1);
  assert.deepEqual(edits[0], { id: "daily", name: "Morning briefing", message: "Summarize my mail" });
});
