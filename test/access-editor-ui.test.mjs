import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom, React, AccessEditor, GuestBar;
before(async () => {
  dom = await startDom();
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ default: AccessEditor } = await dom.load("/src/AccessEditor.tsx"));
  ({ GuestBar } = await dom.load("/src/guest-session.tsx"));
});
after(async () => dom?.close());
const peer = {
  id: "mac",
  url: "https://reach.test",
  token: "owner",
  name: "Studio Mac",
  platform: "darwin",
};
const device = {
  name: "Studio Mac",
  roots: [
    { id: 0, name: "Home", path: "/Users/me" },
    { id: 1, name: "Root", path: "/" },
  ],
};
const agent = () => ({
  id: "assistant",
  name: "Agent",
  kind: "agent",
  browserTransport: "funnel",
  scopes: ["device", "files:read", "browser:read", "browser:request"],
  expiresAt: Date.now() + 600000,
  policy: {
    invite: true,
    browser: true,
    roots: ["/Users/me/Project"],
    screen: "view",
    terminalIds: [],
    restrictedTerminal: true,
  },
});
const button = (root, text) =>
  [...root.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === text,
  );
const click = async (element) => {
  assert.ok(element);
  element.click();
  await settle();
};
const change = async (element, value) => {
  Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype,
    "value",
  ).set.call(element, value);
  element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
};
function mock(status = 200) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (init.method === "POST" || init.method === "DELETE")
      calls.push({
        route,
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
    return new Response(
      JSON.stringify(
        init.method === "POST" && status !== 200
          ? { error: "That invitation has ended." }
          : { terminals: [], ok: true },
      ),
      {
        status: init.method === "POST" ? status : 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  return calls;
}
test("edit existing browser access, extend its end time, and preserve actual root selection", async () => {
  const calls = mock();
  let saved = false;
  const view = await dom.render(
    React.createElement(AccessEditor, {
      peer,
      device,
      client: agent(),
      onClose() {},
      onSaved() {
        saved = true;
      },
    }),
  );
  const root = view.container;
  await click(button(root, "30 min"));
  await change(
    root.querySelector('[aria-label="Screen permission"]'),
    "scroll",
  );
  await click(button(root, "Save changes"));
  await dom.waitFor(() => saved);
  assert.equal(calls[0].route, "/api/guests/assistant/access");
  assert.deepEqual(calls[0].body.folders, [{ root: 0, path: "Project" }]);
  assert.equal(calls[0].body.screen, "scroll");
  assert.equal(calls[0].body.restrictedTerminal, true);
  assert.ok(calls[0].body.expiresAt > Date.now() + 28 * 60000);
  assert.equal(calls[0].body.exec, undefined);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});
test("screen actions preserve scoped terminal access; failed updates leave the editor open with an error", async () => {
  const calls = mock(404);
  let saved = false;
  const view = await dom.render(
    React.createElement(AccessEditor, {
      peer,
      device,
      client: agent(),
      onClose() {},
      onSaved() {
        saved = true;
      },
    }),
  );
  await change(view.container.querySelector("select"), "ask");
  await click(button(view.container, "Save changes"));
  await dom.waitFor(() =>
    view.container.textContent.includes("That invitation has ended."),
  );
  assert.equal(saved, false);
  assert.equal(calls[0].body.restrictedTerminal, true);
  assert.equal(calls[0].body.terminalApproval, false);
  assert.equal(
    calls[0].body.expiresAt,
    undefined,
    "unchanged expiry is not rounded or extended",
  );
  await view.unmount();
});
test("remove access revokes the existing credential instead of creating a replacement", async () => {
  const calls = mock();
  let removed = false;
  globalThis.confirm = () => true;
  const view = await dom.render(
    React.createElement(AccessEditor, {
      peer,
      device,
      client: agent(),
      onClose() {},
      onSaved(value) {
        removed = value;
      },
    }),
  );
  await click(button(view.container, "Remove access"));
  await dom.waitFor(() => removed);
  assert.deepEqual(calls, [
    { route: "/api/clients/assistant", method: "DELETE", body: undefined },
  ]);
  await view.unmount();
});
test("guest expiry comes from the server after an extension, even past the old local deadline", async () => {
  let ended = false;
  const expiresAt = Date.now() + 3600000;
  globalThis.fetch = dom.window.fetch = async () =>
    new Response(JSON.stringify({ access: { expiresAt } }));
  const view = await dom.render(
    React.createElement(GuestBar, {
      session: { peers: [peer], expiresAt: Date.now() - 1 },
      onEnd() {
        ended = true;
      },
    }),
  );
  await dom.waitFor(() => view.container.textContent.includes("h"));
  assert.equal(ended, false);
  assert.equal(
    JSON.parse(sessionStorage.getItem("reach.guest-session")).expiresAt,
    expiresAt,
  );
  await view.unmount();
});
