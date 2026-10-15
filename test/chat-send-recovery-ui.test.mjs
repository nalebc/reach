import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto, replaceText } from "./dom/harness.mjs";

// Real chat components; delayed provider replies and uploads are fixtures.
let dom,
  AgentSession,
  mobile = true,
  current,
  readError = "",
  replies = [],
  sent = [];
const views = [];
const health = ["codex", "claude"].map((agent) => ({
  agent,
  installed: true,
  signedIn: true,
}));
const peer = {
  id: "recovery",
  name: "Fixture",
  url: "https://reach.test",
  token: "fixture",
  platform: "darwin",
};
before(async () => {
  const routes = {
    "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
    "/api/sessions/commands": () => ({ commands: [] }),
    "/api/sessions/health": () => ({ agents: health }),
    "/api/sessions/files": (init) => {
      const name = init.body.get("file").name;
      return { id: `fixture-files/${name}`, name };
    },
  };
  for (const agent of ["codex", "claude"]) {
    routes[`/api/sessions/${agent}/recovery`] = () => readError
      ? Response.json({ error: readError }, { status: 409 })
      : {
        session: current,
        items: [],
      };
    routes[`/api/sessions/${agent}/recovery/live`] = async () => {
      await settle(60);
      return {
        version: 1,
        status: "idle",
        error: null,
        prompts: [],
        streaming: "",
        activity: null,
        items: 0,
      };
    };
    routes[`/api/sessions/${agent}/recovery/messages`] = (init) => {
      sent.push(JSON.parse(init.body));
      return new Promise((resolve) => replies.push(resolve));
    };
  }
  dom = await startDom({ routes });
  const media = dom.window.matchMedia;
  globalThis.matchMedia = dom.window.matchMedia = (query) => ({
    ...media(query),
    matches: mobile,
  });
  ({ default: AgentSession } = await dom.load("/src/AgentSession.tsx"));
});
after(() => dom?.close());
afterEach(async () => {
  for (const reply of replies.splice(0)) reply({ turnId: "cleanup" });
  for (const view of views.splice(0)) await view.unmount();
  sent = [];
  readError = "";
  dom.window.sessionStorage.clear();
  assert.deepEqual(dom.errors, []);
});
async function open(agent, platform = "darwin", narrow = true) {
  mobile = narrow;
  current = {
    agent,
    id: "recovery",
    title: "Recovery",
    cwd: "/work",
    origin: "reach",
    inApp: false,
    status: "idle",
    archived: false,
    updatedAt: 1,
    createdAt: 1,
    preview: "",
    branch: "",
    held: null,
  };
  const view = await dom.render(
    dom.React.createElement(AgentSession, {
      peer: { ...peer, platform },
      session: current,
      siblings: [],
      health,
      onSelect() {},
      onBack() {},
    }),
  );
  views.push(view);
  await dom.waitFor(() =>
    view.container.querySelector(".as-composer textarea"),
  );
  return view;
}
const field = (view) => view.container.querySelector(".as-composer textarea");
const button = (view, label) =>
  view.container.querySelector(`[aria-label="${label}"]`);
const click = async (element) => {
  assert.ok(element);
  dom.update(() => element.click());
  await settle();
};
const refuse = () =>
  replies.shift()(Response.json({ error: "Send refused" }, { status: 409 }));

for (const platform of ["darwin", "win32"])
  test(`${platform}: a history error replaces Opening and clears when history recovers (mocked host)`, async () => {
    readError = "Codex's thread/items/list interface is incompatible with Reach. Update Reach or use the screen or terminal.";
    const view = await open("codex", platform);
    await dom.waitFor(() => view.container.textContent.includes(readError), 5000);
    assert.ok(!view.container.textContent.includes("Opening…"), "a failed read must not look like it is still opening");
    readError = "";
    await dom.waitFor(() => !view.container.textContent.includes("incompatible with Reach"), 5000);
    assert.ok(!view.container.textContent.includes("Opening…"), "the recovered empty transcript is loaded");
  });

async function attach(view, name) {
  const input = view.container.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["fixture"], name, { type: "text/plain" })],
  });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await dom.waitFor(() => !view.container.querySelector(".as-thumb .spin"));
}

for (const platform of ["darwin", "win32"])
  for (const agent of ["codex", "claude"])
    for (const narrow of [true, false])
      test(`${agent} on ${platform}, ${narrow ? "touch" : "desktop"}: a failed send keeps both drafts and their attachments`, async () => {
        const view = await open(agent, platform, narrow);
        await attach(view, "first.txt");
        await typeInto(field(view), "First message");
        await click(button(view, "Send"));
        await dom.waitFor(() => replies.length === 1);
        assert.equal(field(view).value, "");
        await attach(view, "second.txt");
        await typeInto(field(view), "Second message");
        refuse();
        await dom.waitFor(() => view.container.querySelector(".as-unsent"));
        assert.equal(field(view).value, "Second message");
        assert.match(
          view.container.querySelector(".as-thumb").textContent,
          /second\.txt/,
        );
        assert.match(
          view.container.querySelector(".as-unsent").textContent,
          /First message/,
        );
        assert.equal(button(view, "Restore unsent message").disabled, true);
        assert.equal(
          dom.window.sessionStorage.getItem(
            `reach-chat-draft:${peer.id}:${agent}:recovery`,
          ),
          "Second message",
        );
        await replaceText(field(view), "");
        await click(button(view, "Remove file"));
        await click(button(view, "Restore unsent message"));
        assert.equal(field(view).value, "First message");
        assert.match(
          view.container.querySelector(".as-thumb").textContent,
          /first\.txt/,
        );
        assert.equal(view.container.querySelector(".as-unsent"), null);
        await click(button(view, "Send"));
        await dom.waitFor(() => replies.length === 1);
        assert.deepEqual(
          sent.map((body) => [body.text, body.files]),
          [
            ["First message", ["fixture-files/first.txt"]],
            ["First message", ["fixture-files/first.txt"]],
          ],
        );
        replies.shift()({ turnId: "accepted" });
        await settle();
        assert.equal(field(view).value, "");
      });

for (const agent of ["codex", "claude"]) {
  test(`${agent}: a late refusal appears in a chat reopened while sending`, async () => {
    let view = await open(agent);
    await typeInto(field(view), "Message still sending");
    await click(button(view, "Send"));
    await dom.waitFor(() => replies.length === 1);
    await typeInto(field(view), "Draft before leaving");
    await view.unmount();
    views.splice(views.indexOf(view), 1);
    view = await open(agent);
    refuse();
    await dom.waitFor(() => view.container.querySelector(".as-unsent"));
    assert.equal(field(view).value, "Draft before leaving");
    assert.match(
      view.container.querySelector(".as-unsent").textContent,
      /Message still sending/,
    );
    await click(button(view, "Send"));
    await dom.waitFor(() => replies.length === 1);
    await typeInto(field(view), "Third draft");
    refuse();
    await dom.waitFor(
      () => view.container.querySelectorAll(".as-unsent").length === 2,
    );
    assert.equal(field(view).value, "Third draft");
  });

  test(`${agent}: a refusal after leaving the chat preserves both messages on return`, async () => {
    let view = await open(agent);
    await typeInto(field(view), "Message still sending");
    await click(button(view, "Send"));
    await dom.waitFor(() => replies.length === 1);
    await typeInto(field(view), "Draft before leaving");
    await view.unmount();
    views.splice(views.indexOf(view), 1);
    refuse();
    await dom.waitFor(() =>
      dom.window.sessionStorage.getItem(
        `reach-chat-draft:${peer.id}:${agent}:recovery:unsent`,
      ),
    );
    view = await open(agent);
    assert.equal(field(view).value, "Draft before leaving");
    assert.match(
      view.container.querySelector(".as-unsent").textContent,
      /Message still sending/,
    );
  });

  test(`${agent}: unsent messages and the new draft survive reopening the chat`, async () => {
    let view = await open(agent);
    await attach(view, "original.txt");
    await typeInto(field(view), "Original message");
    await click(button(view, "Send"));
    await dom.waitFor(() => replies.length === 1);
    await typeInto(field(view), "Next draft");
    refuse();
    await dom.waitFor(() => view.container.querySelector(".as-unsent"));
    await view.unmount();
    views.splice(views.indexOf(view), 1);
    view = await open(agent);
    assert.equal(field(view).value, "Next draft");
    assert.match(
      view.container.querySelector(".as-unsent").textContent,
      /Original message/,
    );
    await replaceText(field(view), "");
    await click(button(view, "Restore unsent message"));
    assert.equal(field(view).value, "Original message");
    assert.match(
      view.container.querySelector(".as-thumb").textContent,
      /original\.txt/,
    );
    assert.equal(
      dom.window.sessionStorage.getItem(
        `reach-chat-draft:${peer.id}:${agent}:recovery:unsent`,
      ),
      null,
    );
  });

  test(`${agent}: a failed send with no newer draft restores the original immediately`, async () => {
    const view = await open(agent);
    await typeInto(field(view), "Retry this message");
    await click(button(view, "Send"));
    await dom.waitFor(() => replies.length === 1);
    refuse();
    await dom.waitFor(() => view.container.querySelector(".as-hint.bad"));
    assert.equal(field(view).value, "Retry this message");
    assert.equal(view.container.querySelector(".as-unsent"), null);
  });
}

test("a second failed send never replaces an earlier unsent message", async () => {
  const view = await open("codex");
  await typeInto(field(view), "First");
  await click(button(view, "Send"));
  await dom.waitFor(() => replies.length === 1);
  await typeInto(field(view), "Second");
  refuse();
  await dom.waitFor(() => view.container.querySelector(".as-unsent"));
  await click(button(view, "Send"));
  await dom.waitFor(() => replies.length === 1);
  await typeInto(field(view), "Third");
  refuse();
  await dom.waitFor(
    () => view.container.querySelectorAll(".as-unsent").length === 2,
  );
  assert.equal(field(view).value, "Third");
  assert.deepEqual(
    [...view.container.querySelectorAll(".as-unsent small")].map(
      (el) => el.textContent,
    ),
    ["First", "Second"],
  );
});
