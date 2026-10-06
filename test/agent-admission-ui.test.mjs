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
const saveReceipt = (value = receipt()) => {
  dom.window.sessionStorage.clear();
  dom.window.sessionStorage.setItem(claimStorageKey, JSON.stringify([value]));
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
  assert.equal(
    JSON.parse(dom.window.sessionStorage.getItem(claimStorageKey))[0]
      .requestSecret,
    pending.requestSecret,
  );
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
  await view.unmount();
});

test("a saved waiting receipt resumes without redeeming the consumed link and stops polling on unmount", async () => {
  saveReceipt();
  let polls = 0,
    state = "pending",
    ready;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    assert.equal(
      new URL(url).pathname,
      "/api/invitations/claims/claim-1/status",
    );
    assert.deepEqual(JSON.parse(init.body), { secret: "s".repeat(43) });
    polls++;
    return reply(
      state === "pending"
        ? { status: "pending" }
        : {
            status: "approved",
            token: "resumed-token",
            device,
            expiresAt: Date.now() + 3600000,
          },
    );
  };
  let view = await dom.render(
    React.createElement(GuestAccess, {
      onReady(value) {
        ready = value;
      },
    }),
  );
  await dom.waitFor(() => polls === 1);
  await view.unmount();
  await settle(2100);
  assert.equal(polls, 1, "unmount cancels the scheduled poll");
  assert.equal(ready, undefined);
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
  assert.equal(polls, 2);
  await view.unmount();
});

for (const status of ["denied", "expired"])
  test(`${status} agent connections never open a workspace or retry the consumed invitation`, async () => {
    saveReceipt();
    let ready = false,
      calls = 0;
    globalThis.fetch = dom.window.fetch = async () => {
      calls++;
      return reply({ status });
    };
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
    assert.equal(calls, 1);
    assert.equal(button(view.container, "Try again"), undefined);
    assert.equal(dom.window.sessionStorage.getItem(claimStorageKey), null);
    assert.equal(dom.window.sessionStorage.getItem(storageKey), null);
    await view.unmount();
  });

for (const status of [401, 403, 404, 409])
  test(`claim status ${status} ends polling without obtaining access`, async () => {
    saveReceipt();
    let calls = 0;
    globalThis.fetch = dom.window.fetch = async () => {
      calls++;
      return reply({ error: "Invalid claim" }, status);
    };
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
    assert.equal(calls, 1);
    assert.equal(dom.window.sessionStorage.getItem(claimStorageKey), null);
    assert.equal(dom.window.sessionStorage.getItem(storageKey), null);
    await view.unmount();
  });

test("an expired saved receipt is ended without polling or redemption", async () => {
  saveReceipt({ ...receipt(), expiresAt: Date.now() - 1 });
  globalThis.fetch = dom.window.fetch = async () =>
    assert.fail("Expired receipt should not make a request");
  const view = await dom.render(
    React.createElement(GuestAccess, {
      onReady() {
        assert.fail("No access expected");
      },
    }),
  );
  assert.match(view.container.textContent, /expired/);
  assert.equal(dom.window.sessionStorage.getItem(claimStorageKey), null);
  await view.unmount();
});

test("an approved token delivered during unmount is saved once for reload", async () => {
  saveReceipt();
  let finish,
    ready = 0;
  globalThis.fetch = dom.window.fetch = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
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
  assert.equal(dom.window.sessionStorage.getItem(claimStorageKey), null);
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

for (const oldState of ["pending", "expired", "revoked"])
  test(`a fresh replacement invite supersedes a saved ${oldState} receipt`, async () => {
    saveReceipt({
      ...receipt(),
      requestId: "old-claim",
      expiresAt: oldState === "expired" ? Date.now() - 1 : Date.now() + 300000,
    });
    const replacementSecret = "r".repeat(43);
    dom.window.history.replaceState(
      null,
      "",
      `/guest#${new URLSearchParams({ i: `${origin}~${replacementSecret}` })}`,
    );
    const { default: ReplacementAccess } = await dom.load(
      `/src/GuestAccess.tsx?fresh-replacement=${oldState}`,
    );
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
        "the previous receipt must never be polled",
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

test("a reload without a fresh invitation keeps and resumes the saved receipt", async () => {
  saveReceipt();
  dom.window.history.replaceState(null, "", "/guest");
  const { default: ReloadedAccess } = await dom.load(
    "/src/GuestAccess.tsx?reload-without-link=1",
  );
  assert.ok(dom.window.sessionStorage.getItem(claimStorageKey));
  const calls = [];
  let ready;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push([route, JSON.parse(init.body)]);
    assert.equal(route, "/api/invitations/claims/claim-1/status");
    return reply({
      status: "approved",
      token: "reload-token",
      device,
      expiresAt: Date.now() + 3600000,
    });
  };
  const view = await dom.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(ReloadedAccess, {
        onReady(value) {
          ready = value;
        },
      }),
    ),
  );
  await dom.waitFor(() => ready);
  assert.deepEqual(calls, [
    ["/api/invitations/claims/claim-1/status", { secret: "s".repeat(43) }],
  ]);
  assert.equal(ready.peers[0].token, "reload-token");
  await view.unmount();
});

test("reopening the same invitation resumes its receipt without redeeming it again", async () => {
  saveReceipt({ ...receipt(), sourceInvitation: invitation });
  dom.window.history.replaceState(null, "", `/guest#${new URLSearchParams({ i: `${origin}~${invitation}` })}`);
  const { default: ReopenedAccess } = await dom.load("/src/GuestAccess.tsx?reopened-same-link=1");
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url) => {
    calls.push(new URL(url).pathname);
    assert.equal(new URL(url).pathname, "/api/invitations/claims/claim-1/status");
    return reply({ status: "pending" });
  };
  const view = await dom.render(React.createElement(React.StrictMode, null, React.createElement(ReopenedAccess, { onReady() { assert.fail("Still waiting for owner"); } })));
  await dom.waitFor(() => calls.length === 1);
  assert.match(view.container.textContent, /Waiting for the owner/);
  assert.equal(dom.window.sessionStorage.getItem(storageKey), null);
  await view.unmount();
});

test("admission surfaces render without React warnings", () =>
  assert.deepEqual(dom.errors, []));
