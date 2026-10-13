import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const origin = "https://mac.tail.ts.net:8443";
const invitation = "a".repeat(43);
const peer = {
  id: "mac",
  name: "My Mac",
  url: origin,
  token: "owner-token",
  platform: "darwin",
};
const device = { id: "mac", name: "My Mac", platform: "darwin" };
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const receipt = () => ({
  origin,
  requestId: "claim-1",
  requestSecret: "s".repeat(43),
  verificationCode: "123456",
  expiresAt: Date.now() + 300000,
  clientId: "muse",
  device,
});
const admission = () => ({
  requestId: "claim-1",
  clientId: "muse",
  name: "Muse",
  scopes: ["device", "files:read", "browser:read", "browser:request"],
  roots: ["/Users/me/Project"],
  browser: true,
  screen: "ask",
  terminalIds: ["reach:build"],
  commandRequests: true,
  requestedAt: Date.now(),
  expiresAt: Date.now() + 300000,
  accessExpiresAt: Date.now() + 3600000,
  verificationCode: "123456",
  nodeName: "muse-vm",
  nodeId: "node-123",
});
let dom,
  React,
  GuestAccess,
  AgentAdmissionReview,
  useAgentAdmissions,
  NeedsYouStrip,
  claimStorageKey,
  storageKey;
before(async () => {
  dom = await startDom();
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.history.replaceState(
    null,
    "",
    `/guest#${new URLSearchParams({ i: `${origin}~${invitation}` })}`,
  );
  ({ default: GuestAccess, claimStorageKey } = await dom.load(
    "/src/GuestAccess.tsx",
  ));
  ({ storageKey } = await dom.load("/src/guest-session.tsx"));
  ({ AgentAdmissionReview, useAgentAdmissions } = await dom.load(
    "/src/agent-admissions.tsx",
  ));
  ({ NeedsYouStrip } = await dom.load("/src/NeedsYou.tsx"));
});
after(async () => dom?.close());
const button = (c, label) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const click = async (element) => {
  assert.ok(element);
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(30);
};
// Everything this tab keeps, both storages, keys and values.
const stored = () =>
  [dom.window.sessionStorage, dom.window.localStorage]
    .flatMap((storage) => Object.keys(storage).flatMap((key) => [key, storage.getItem(key)]))
    .join("\n");
const assertNothingSecretStored = () => {
  assert.doesNotMatch(stored(), /s{43}/, "the request secret stays in memory");
  assert.ok(!stored().includes(invitation), "the invitation stays in memory");
};
// A waiting agent: the link redeemed into a receipt, then each poll answered
// by `status()`. Receipts are in the page's memory only, so a wait begins here.
const waiting = (status, value = receipt()) => {
  const calls = { redeem: 0, status: 0 };
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/guest/redeem") {
      calls.redeem++;
      return reply({ ...value, status: "pending", kind: "agent" }, 202);
    }
    assert.equal(route, "/api/invitations/claims/claim-1/status");
    assert.deepEqual(JSON.parse(init.body), { secret: "s".repeat(43) });
    calls.status++;
    return status();
  };
  return calls;
};

test("an agent's first join waits with no credential, survives StrictMode, then opens only after approval", async () => {
  dom.window.sessionStorage.clear();
  const calls = [];
  const pending = receipt();
  let state = "pending",
    ready = null,
    readyCount = 0;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push([
      path,
      JSON.parse(init.body),
      new Headers(init.headers).get("Authorization"),
    ]);
    if (path === "/api/guest/redeem")
      return reply({ ...pending, status: "pending", kind: "agent" }, 202);
    assert.equal(path, "/api/invitations/claims/claim-1/status");
    return reply(
      state === "pending"
        ? { status: "pending", expiresAt: pending.expiresAt }
        : {
            status: "approved",
            token: "agent-credential",
            device,
            expiresAt: Date.now() + 3600000,
          },
    );
  };
  const view = await dom.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(GuestAccess, {
        onReady(value) {
          ready = value;
          readyCount++;
        },
      }),
    ),
  );
  await dom.waitFor(() => view.container.textContent.includes("123456"));
  assert.equal(
    calls.filter(([path]) => path === "/api/guest/redeem").length,
    1,
  );
  assert.equal(ready, null);
  assert.equal(dom.window.sessionStorage.getItem(storageKey), null);
  assert.match(
    view.container.textContent,
    /No files, terminal output, or screen access is available yet/,
  );
  assert.doesNotMatch(view.container.textContent, /ssssssssss/);
  // Waiting: nothing secret in either storage (CodeQL #138-#140).
  assertNothingSecretStored();
  assert.equal(dom.window.sessionStorage.getItem(claimStorageKey), null);
  assert.ok(
    calls.every(([, , authorization]) => authorization === null),
    "pending claims do not use owner credentials",
  );
  state = "approved";
  await dom.waitFor(() => ready, 4000);
  assert.equal(readyCount, 1);
  assert.equal(ready.peers[0].token, "agent-credential");
  assert.equal(dom.window.sessionStorage.getItem(claimStorageKey), null);
  assert.equal(
    JSON.parse(dom.window.sessionStorage.getItem(storageKey)).peers[0].token,
    "agent-credential",
  );
  // Approved: the credential is kept as before, still nothing of the wait.
  assertNothingSecretStored();
  await view.unmount();
});

test("a waiting receipt resumes when the view mounts again, without redeeming the consumed link, and stops polling on unmount", async () => {
  dom.window.sessionStorage.clear();
  let state = "pending",
    ready;
  const calls = waiting(() =>
    reply(
      state === "pending"
        ? { status: "pending" }
        : {
            status: "approved",
            token: "resumed-token",
            device,
            expiresAt: Date.now() + 3600000,
          },
    ),
  );
  let view = await dom.render(
    React.createElement(GuestAccess, {
      onReady(value) {
        ready = value;
      },
    }),
  );
  await dom.waitFor(() => calls.status === 1);
  await view.unmount();
  await settle(2100);
  assert.equal(calls.status, 1, "unmount cancels the scheduled poll");
  assert.equal(ready, undefined);
  assertNothingSecretStored();
  state = "approved";
  view = await dom.render(
    React.createElement(GuestAccess, {
      onReady(value) {
        ready = value;
      },
    }),
  );
  await dom.waitFor(() => ready);
  assert.equal(ready.peers[0].token, "resumed-token");
  assert.deepEqual(calls, { redeem: 1, status: 2 });
  await view.unmount();
});

for (const status of ["denied", "expired"])
  test(`${status} agent connections never open a workspace or retry the consumed invitation`, async () => {
    dom.window.sessionStorage.clear();
    let ready = false;
    const calls = waiting(() => reply({ status }));
    const view = await dom.render(
      React.createElement(GuestAccess, {
        onReady() {
          ready = true;
        },
      }),
    );
    await dom.waitFor(() =>
      view.container.textContent.includes("Connection not approved"),
    );
    assert.equal(ready, false);
    assert.deepEqual(calls, { redeem: 1, status: 1 });
    assert.equal(button(view.container, "Try again"), undefined);
    assert.equal(dom.window.sessionStorage.getItem(storageKey), null);
    assertNothingSecretStored();
    await view.unmount();
  });

for (const status of [401, 403, 404, 409])
  test(`claim status ${status} ends polling without obtaining access`, async () => {
    dom.window.sessionStorage.clear();
    const calls = waiting(() => reply({ error: "Invalid claim" }, status));
    const view = await dom.render(
      React.createElement(GuestAccess, {
        onReady() {
          assert.fail("No access expected");
        },
      }),
    );
    await dom.waitFor(() =>
      view.container.textContent.includes("no longer available"),
    );
    assert.deepEqual(calls, { redeem: 1, status: 1 });
    assert.equal(dom.window.sessionStorage.getItem(storageKey), null);
    assertNothingSecretStored();
    await view.unmount();
  });

test("a receipt that has already expired is ended without polling", async () => {
  dom.window.sessionStorage.clear();
  const calls = waiting(
    () => assert.fail("Expired receipt should not be polled"),
    { ...receipt(), expiresAt: Date.now() - 1 },
  );
  const view = await dom.render(
    React.createElement(GuestAccess, {
      onReady() {
        assert.fail("No access expected");
      },
    }),
  );
  await dom.waitFor(() => /expired/.test(view.container.textContent));
  assert.deepEqual(calls, { redeem: 1, status: 0 });
  await view.unmount();
});

test("an approved token delivered during unmount is saved once for reload", async () => {
  dom.window.sessionStorage.clear();
  let finish,
    ready = 0;
  waiting(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await dom.render(
    React.createElement(GuestAccess, {
      onReady() {
        ready++;
      },
    }),
  );
  await dom.waitFor(() => finish);
  await view.unmount();
  finish(
    reply({
      status: "approved",
      token: "delivered-once",
      device,
      expiresAt: Date.now() + 3600000,
    }),
  );
  await settle(40);
  assert.equal(ready, 0);
  assert.equal(
    JSON.parse(dom.window.sessionStorage.getItem(storageKey)).peers[0].token,
    "delivered-once",
  );
  assertNothingSecretStored();
});

test("owner reviews the full grant and must compare the code before approval", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([new URL(url).pathname, JSON.parse(init.body)]);
    return reply({ status: "approved" });
  };
  let resolved = 0;
  const view = await dom.render(
    React.createElement(AgentAdmissionReview, {
      peer,
      admission: admission(),
      onClose() {},
      onResolved() {
        resolved++;
      },
    }),
  );
  const c = view.container;
  assert.equal(button(c, "Approve connection").disabled, true);
  assert.equal(button(c, "Deny").disabled, false);
  assert.equal(
    c.querySelector('[aria-label="Connection verification code"]').textContent,
    "123456",
  );
  assert.match(c.textContent, /does not prove which app or person/);
  for (const text of [
    "muse-vm",
    "node-123",
    "/Users/me/Project",
    "reach:build",
    "Every screen input needs your approval",
    "Reach never executes these requests",
    "browser:request",
  ])
    assert.ok(c.textContent.includes(text), text);
  await click(button(c, "Approve connection"));
  assert.deepEqual(calls, []);
  await click(c.querySelector('input[type="checkbox"]'));
  assert.equal(button(c, "Approve connection").disabled, false);
  await click(button(c, "Approve connection"));
  assert.deepEqual(calls, [
    ["/api/agents/admissions/claim-1", { decision: "approve" }],
  ]);
  assert.equal(resolved, 1);
  await view.unmount();
});

test("owner can deny without code confirmation and CLI execution permission is explicit", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push(JSON.parse(init.body));
    return reply({ status: "denied" });
  };
  const request = {
    ...admission(),
    browser: false,
    scopes: ["device", "files:read", "files:write", "exec"],
    roots: ["/Project/<img src=x onerror=bad()>"],
  };
  const view = await dom.render(
    React.createElement(AgentAdmissionReview, {
      peer,
      admission: request,
      onClose() {},
      onResolved() {},
    }),
  );
  assert.match(
    view.container.textContent,
    /does not require separate approval for each command/,
  );
  assert.equal(
    view.container.querySelectorAll(".agent-admission-resources img").length,
    0,
  );
  await click(button(view.container, "Deny"));
  assert.deepEqual(calls, [{ decision: "deny" }]);
  await view.unmount();
});

test("expired owner admissions cannot be approved even with a matching code", async () => {
  globalThis.fetch = dom.window.fetch = async () =>
    assert.fail("No expired decision expected");
  const view = await dom.render(
    React.createElement(AgentAdmissionReview, {
      peer,
      admission: { ...admission(), expiresAt: Date.now() - 1 },
      onClose() {},
      onResolved() {},
    }),
  );
  assert.equal(button(view.container, "Approve connection").disabled, true);
  assert.equal(button(view.container, "Deny").disabled, true);
  await view.unmount();
});

test("Needs you lists pending admission requests only to the owner, then opens review", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([init.method || "GET", new URL(url).pathname]);
    return reply([
      admission(),
      { ...admission(), requestId: "old", expiresAt: Date.now() - 1 },
    ]);
  };
  function Inbox({ enabled }) {
    const admissions = useAgentAdmissions(
      peer,
      enabled,
      JSON.stringify({ agentAdmissions: "one" }),
    );
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(NeedsYouStrip, { items: admissions.items }),
      admissions.review,
    );
  }
  let view = await dom.render(React.createElement(Inbox, { enabled: false }));
  assert.equal(calls.length, 0);
  await view.unmount();
  view = await dom.render(React.createElement(Inbox, { enabled: true }));
  assert.equal(view.container.querySelectorAll(".need-card").length, 1);
  await click(button(view.container, "Review connection"));
  assert.ok(
    view.container.querySelector('[aria-label="Connection verification code"]'),
  );
  assert.equal(button(view.container, "Approve connection").disabled, true);
  assert.deepEqual(calls, [["GET", "/api/agents/admissions"]]);
  await view.unmount();
});

test("a receipt an older Reach saved in this tab is deleted on load and never polled", async () => {
  dom.window.sessionStorage.clear();
  dom.window.sessionStorage.setItem(
    claimStorageKey,
    JSON.stringify([{ ...receipt(), requestId: "old-claim", sourceInvitation: invitation }]),
  );
  const replacementSecret = "r".repeat(43);
  dom.window.history.replaceState(
    null,
    "",
    `/guest#${new URLSearchParams({ i: `${origin}~${replacementSecret}` })}`,
  );
  const { default: ReplacementAccess } = await dom.load(
    "/src/GuestAccess.tsx?older-receipt=1",
  );
  assert.equal(dom.window.sessionStorage.getItem(claimStorageKey), null);
  const calls = [];
  let ready;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push([route, JSON.parse(init.body)]);
    if (route === "/api/guest/redeem")
      return reply(
        {
          ...receipt(),
          requestId: "replacement-claim",
          verificationCode: "654321",
          status: "pending",
          kind: "agent",
        },
        202,
      );
    assert.equal(
      route,
      "/api/invitations/claims/replacement-claim/status",
      "the older receipt must never be polled",
    );
    return reply({
      status: "approved",
      token: "replacement-token",
      device,
      expiresAt: Date.now() + 3600000,
    });
  };
  const view = await dom.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(ReplacementAccess, {
        onReady(value) {
          ready = value;
        },
      }),
    ),
  );
  await dom.waitFor(() => ready);
  assert.deepEqual(
    calls.filter(([route]) => route === "/api/guest/redeem"),
    [["/api/guest/redeem", { invitation: replacementSecret }]],
    "the fresh one-use link is redeemed once under StrictMode",
  );
  assert.equal(
    calls.filter(([route]) => route.includes("replacement-claim")).length,
    1,
  );
  assert.equal(ready.peers[0].token, "replacement-token");
  assert.equal(dom.window.sessionStorage.getItem(claimStorageKey), null);
  assert.equal(dom.window.location.hash, "");
  await view.unmount();
});

// What a reload costs a waiting agent: nothing secret was kept, so the wait
// can't resume, and the link it came with was spent when it was opened.
test("a reload while waiting can't resume: the agent is sent back to its link, which was spent", async () => {
  dom.window.sessionStorage.clear();
  dom.window.history.replaceState(null, "", `/guest#${new URLSearchParams({ i: `${origin}~${invitation}` })}`);
  const { default: Waiting } = await dom.load("/src/GuestAccess.tsx?before-reload=1");
  const calls = waiting(() => reply({ status: "pending" }));
  let view = await dom.render(React.createElement(Waiting, { onReady() { assert.fail("Still waiting for owner"); } }));
  await dom.waitFor(() => calls.status === 1);
  assertNothingSecretStored();
  await view.unmount();
  // Reloaded: the address bar no longer holds the link.
  dom.window.history.replaceState(null, "", "/guest");
  const { default: Reloaded } = await dom.load("/src/GuestAccess.tsx?reloaded=1");
  globalThis.fetch = dom.window.fetch = async () => assert.fail("Nothing to resume after a reload");
  view = await dom.render(React.createElement(Reloaded, { onReady() { assert.fail("No access expected"); } }));
  await settle(30);
  assert.match(view.container.textContent, /Open the link the computer’s owner sent you/);
  await view.unmount();
  // Reopening the same link: it was spent when it was first opened.
  dom.window.history.replaceState(null, "", `/guest#${new URLSearchParams({ i: `${origin}~${invitation}` })}`);
  const { default: Reopened } = await dom.load("/src/GuestAccess.tsx?reopened-same-link=1");
  const routes = [];
  globalThis.fetch = dom.window.fetch = async (url) => {
    routes.push(new URL(url).pathname);
    return reply({ error: "This guest link expired, was revoked, or has already been used." }, 401);
  };
  view = await dom.render(React.createElement(Reopened, { onReady() { assert.fail("No access expected"); } }));
  await dom.waitFor(() => view.container.textContent.includes("already been used"));
  assert.deepEqual(routes, ["/api/guest/redeem"]);
  await view.unmount();
});

test("admission surfaces render without React warnings", () =>
  assert.deepEqual(dom.errors, []));

test("app admission names the app modes without misrepresenting them as full screen access", async () => {
  const entry = { ...admission(), screen: "apps", appAccess: [{ id: "/Applications/Safari.app", name: "Safari", mode: "control" }, { id: "/System/Applications/Notes.app", name: "Notes", mode: "view" }], restrictedTerminal: true };
  const view = await dom.render(React.createElement(AgentAdmissionReview, { peer, admission: entry, onClose() {}, onResolved() {} }));
  assert.match(view.container.textContent, /App access/);
  assert.match(view.container.textContent, /Safari · View & control/);
  assert.match(view.container.textContent, /Notes · View only/);
  assert.match(view.container.textContent, /Other apps stay hidden/);
  assert.match(view.container.textContent, /Reach on this Mac is locked/);
  assert.match(view.container.textContent, /Read-only commands run directly inside shared folders/);
  assert.doesNotMatch(view.container.textContent, /Every screen input needs your approval/);
  await view.unmount();
});
