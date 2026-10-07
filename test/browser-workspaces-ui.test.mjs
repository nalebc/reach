import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, React, BrowserInvite, BrowserAgents;
const views = new Set();
const peer = {
  id: "mac",
  name: "My Mac",
  url: "https://mac.tail.ts.net:8443",
  token: "owner",
  platform: "darwin",
};
const device = {
  name: "My Mac",
  roots: [{ id: 0, name: "Project", path: "/Users/me/Project" }],
};
const workspace = {
  id: "workspace-one",
  status: "bound",
  sources: ["/Users/me/Project"],
  roots: ["/private/agent-copies/workspace-one/Project"],
};
const session = (overrides = {}) => ({
  id: "agent-one",
  name: "Muse",
  kind: "agent",
  status: "accepted",
  createdAt: Date.now() - 60000,
  expiresAt: Date.now() + 900000,
  folders: workspace.roots,
  workspace,
  pendingApprovals: 0,
  activity: { state: "idle" },
  scopes: ["device", "browser:read", "browser:request"],
  policy: {
    invite: true,
    browser: true,
    roots: workspace.roots,
    restrictedTerminal: true,
    terminalApproval: true,
    screen: "off",
  },
  ...overrides,
});
const review = (id = "review-exact-one") => ({
  id,
  workspaceId: workspace.id,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  changes: [
    {
      root: 0,
      path: "notes.txt",
      type: "changed",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      beforeText: "Old project note",
      afterText: "New <script>project note</script>",
      binary: false,
    },
  ],
  summary: {
    added: 0,
    changed: 1,
    deleted: 0,
    bytes: 32,
    skipped: 0,
    conflicts: 0,
  },
});
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const button = (root, text) =>
  [...root.querySelectorAll("button")].find(
    (item) =>
      item.textContent.trim() === text ||
      item.getAttribute("aria-label") === text,
  );
const click = async (element) => {
  assert.ok(element, "control exists");
  element.click();
  await settle(35);
};
const render = async (element) => {
  const view = await dom.render(element);
  views.add(view);
  return view;
};
before(async () => {
  dom = await startDom();
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ default: BrowserInvite } = await dom.load("/src/BrowserInvite.tsx"));
  ({ default: BrowserAgents } = await dom.load("/src/BrowserAgents.tsx"));
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
after(async () => dom?.close());

function mock({
  agents = [session()],
  mutate,
  workspaceAvailable = true,
  inviteWorkspace = workspace,
} = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname,
      method = init.method || "GET",
      body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({
      route,
      method,
      body,
      host: new URL(url).hostname,
      signal: init.signal,
    });
    if (method !== "GET") {
      const changed = mutate?.(route, body, init);
      if (changed) return changed;
      if (route === "/api/agents/browser-invitations")
        return reply({
          invitation: "a".repeat(43),
          clientId: "agent-created",
          expiresAt: Date.now() + 900000,
          joinBy: Date.now() + 300000,
          url: `https://mac.tail.ts.net/agent-browser#invite=${"a".repeat(43)}`,
          ...(inviteWorkspace ? { workspace: inviteWorkspace } : {}),
        });
      if (route.endsWith("/review")) return reply(review());
      if (route.endsWith("/apply"))
        return reply({
          workspaceId: workspace.id,
          reviewId: body.reviewId,
          applied: [{ root: 0, path: "notes.txt", type: "changed" }],
          partial: false,
        });
      return reply({ ok: true });
    }
    if (route === "/api/agents/browser-options")
      return reply({
        terminals: [],
        screenAvailable: false,
        workspaceAvailable,
      });
    if (route === "/api/browser/agents")
      return reply({
        agents: typeof agents === "function" ? agents() : agents,
        at: Date.now(),
      });
    if (
      [
        "/api/agents/browser-requests",
        "/api/agents/browser-terminal-history",
        "/api/agents/admissions",
      ].includes(route)
    )
      return reply([]);
    return reply({}, 404);
  };
  return calls;
}
const inviteElement = (extra = {}) =>
  React.createElement(BrowserInvite, {
    peer,
    device,
    keyPeer: peer,
    onSetup() {},
    onCreated() {},
    ...extra,
  });
const agentsElement = (extra = {}) =>
  React.createElement(BrowserAgents, {
    peer,
    device,
    invite() {},
    toast() {},
    ...extra,
  });
const openReview = async (view) => {
  await dom.waitFor(() => view.container.querySelector(".ba-session"));
  await click(button(view.container, "Stop & review changes"));
  await click(button(view.container, "Stop and review"));
  await dom.waitFor(() => view.container.querySelector(".ba-workspace-review"));
};

test("folder invitation defaults to a private copy and prompt names returned copy roots", async () => {
  const calls = mock();
  let created = 0;
  const view = await render(inviteElement({ onCreated: () => created++ }));
  await click(button(view.container, "Share Project"));
  await dom.waitFor(() =>
    view.container.querySelector('[aria-label="Private copy"]'),
  );
  assert.equal(
    view.container.querySelector('[aria-label="Private copy"]').checked,
    true,
  );
  await click(button(view.container, "Create invite link"));
  assert.equal(
    calls.find((call) => call.route === "/api/agents/browser-invitations").body
      .workspaceMode,
    "private",
  );
  const prompt = view.container.querySelector(
    '[aria-label="AI browser invitation message"]',
  ).value;
  assert.ok(prompt.includes(workspace.roots[0]));
  assert.ok(!prompt.includes(workspace.sources[0]));
  assert.match(
    prompt,
    /Original folders stay unchanged until the owner reviews and applies your changes/,
  );
  assert.match(prompt, /Never invite anyone, delegate access/);
  assert.equal(created, 1);
});

test("shared folder requires explicit choice when private copies are supported", async () => {
  const calls = mock({ inviteWorkspace: null });
  const view = await render(inviteElement());
  await click(button(view.container, "Share Project"));
  await dom.waitFor(() =>
    view.container.querySelector('[aria-label="Shared folder"]'),
  );
  await click(view.container.querySelector('[aria-label="Shared folder"]'));
  await click(button(view.container, "Create invite link"));
  assert.equal(
    calls.find((call) => call.route === "/api/agents/browser-invitations").body
      .workspaceMode,
    "shared",
  );
  assert.match(
    view.container.querySelector('[aria-label="AI browser invitation message"]')
      .value,
    /shared original folders; approved changes affect them directly/,
  );
});

test("a missing private-copy confirmation never produces a misleading invitation prompt", async () => {
  const calls = mock({ inviteWorkspace: null });
  let created = 0;
  const view = await render(inviteElement({ onCreated: () => created++ }));
  await click(button(view.container, "Share Project"));
  await click(button(view.container, "Create invite link"));
  await dom.waitFor(() =>
    view.container.textContent.includes("did not confirm the private copies"),
  );
  assert.equal(
    view.container.querySelector(
      '[aria-label="AI browser invitation message"]',
    ),
    null,
  );
  assert.equal(created, 0);
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" && call.route === "/api/clients/agent-created",
    ),
  );
});

test("review confirms session shutdown, shows before and after, and applies only its exact token on click", async () => {
  const calls = mock();
  const view = await render(agentsElement());
  await dom.waitFor(() => view.container.querySelector(".ba-session"));
  assert.equal(button(view.container, "Edit access"), undefined);
  await click(button(view.container, "Stop & review changes"));
  assert.match(
    view.container.querySelector('[aria-label="Confirm stop and review"]')
      .textContent,
    /ends this invitation/,
  );
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
  await click(button(view.container, "Stop and review"));
  await dom.waitFor(() => view.container.querySelector(".ba-workspace-review"));
  const panel = view.container.querySelector(".ba-workspace-review");
  assert.match(panel.textContent, /Old project note/);
  assert.match(panel.textContent, /New <script>project note<\/script>/);
  assert.equal(panel.querySelector("script"), null);
  assert.equal(calls.filter((call) => call.route.endsWith("/apply")).length, 0);
  await click(button(panel, "Apply reviewed changes"));
  assert.deepEqual(calls.find((call) => call.route.endsWith("/apply")).body, {
    reviewId: "review-exact-one",
  });
  assert.match(panel.textContent, /1 reviewed file change applied/);
  assert.equal(button(panel, "Apply reviewed changes"), undefined);
});

test("source conflict disables the old token and requires a fresh review", async () => {
  let reviews = 0;
  const calls = mock({
    mutate: (route) =>
      route.endsWith("/review")
        ? reply(review(`review-${++reviews}`))
        : route.endsWith("/apply")
          ? reply({ error: "The original file changed. Review again." }, 409)
          : null,
  });
  const view = await render(agentsElement());
  await openReview(view);
  await click(
    button(
      view.container.querySelector(".ba-workspace-review"),
      "Apply reviewed changes",
    ),
  );
  assert.match(
    view.container.querySelector(".ba-workspace-review").textContent,
    /original file changed/,
  );
  assert.equal(button(view.container, "Apply reviewed changes").disabled, true);
  await click(button(view.container, "Review again"));
  assert.equal(reviews, 2);
  assert.equal(
    button(view.container, "Apply reviewed changes").disabled,
    false,
  );
  assert.equal(
    calls.filter((call) => call.route.endsWith("/apply")).length,
    1,
    "review never retries apply",
  );
});

test("a reviewed conflict opens the affected file and blocks the entire apply without a write request", async () => {
  const result = review("conflicted-review");
  result.changes.push({
    ...result.changes[0],
    path: "conflicted.txt",
    conflict:
      "The original file has changed since this private copy was created.",
  });
  result.summary.changed = 2;
  result.summary.conflicts = 1;
  const calls = mock({
    mutate: (route) => (route.endsWith("/review") ? reply(result) : null),
  });
  const view = await render(agentsElement());
  await openReview(view);
  const panel = view.container.querySelector(".ba-workspace-review");
  const files = [...panel.querySelectorAll(".ba-review-files > details")];
  assert.equal(files[0].open, false);
  assert.equal(
    files[1].open,
    true,
    "first conflicted file is expanded instead of an unrelated clean file",
  );
  assert.match(files[1].querySelector("summary").textContent, /Conflict/);
  const descriptionId = files[1]
    .querySelector("summary")
    .getAttribute("aria-describedby");
  assert.ok(descriptionId);
  assert.match(
    dom.document.getElementById(descriptionId).textContent,
    /original file has changed/,
  );
  assert.match(
    panel.querySelector('[role="alert"]').textContent,
    /Nothing can be applied while a conflict remains/,
  );
  const apply = button(panel, "Apply reviewed changes");
  assert.equal(apply.disabled, true);
  assert.ok(apply.getAttribute("aria-describedby"));
  await click(apply);
  assert.equal(calls.filter((call) => call.route.endsWith("/apply")).length, 0);
  assert.equal(
    panel.querySelector('input[type="checkbox"]'),
    null,
    "there is no partial subset approval",
  );
  assert.ok(button(panel, "Review again"));
});

test("resolving a marked conflict requires a fresh review and explicit apply with the new exact token", async () => {
  let reviews = 0;
  const calls = mock({
    mutate: (route) => {
      if (!route.endsWith("/review")) return null;
      const result = review(`resolved-review-${++reviews}`);
      if (reviews === 1) {
        result.changes[0].conflict = "The original was edited.";
        result.summary.conflicts = 1;
      }
      return reply(result);
    },
  });
  const view = await render(agentsElement());
  await openReview(view);
  assert.equal(button(view.container, "Apply reviewed changes").disabled, true);
  await click(button(view.container, "Review again"));
  assert.equal(reviews, 2);
  assert.equal(view.container.querySelector(".ba-review-conflicts"), null);
  assert.equal(
    button(view.container, "Apply reviewed changes").disabled,
    false,
  );
  assert.equal(
    calls.filter((call) => call.route.endsWith("/apply")).length,
    0,
    "a refreshed clean review never applies automatically",
  );
  await click(button(view.container, "Apply reviewed changes"));
  assert.deepEqual(calls.find((call) => call.route.endsWith("/apply")).body, {
    reviewId: "resolved-review-2",
  });
});

test("a clean review can apply independent changes while other original files changed", async () => {
  const calls = mock({
    mutate: (route) => {
      if (!route.endsWith("/review")) return null;
      const result = review("independent-change-review");
      // Only the agent's touched file is in the immutable review. Unrelated
      // original edits are absent and must never trigger a whole-folder warning.
      result.changes[0].path = "agent-notes.txt";
      return reply(result);
    },
  });
  const view = await render(agentsElement());
  await openReview(view);
  const panel = view.container.querySelector(".ba-workspace-review");
  assert.match(panel.textContent, /Unrelated file edits do not block/);
  assert.equal(panel.querySelector(".ba-review-conflicts"), null);
  assert.equal(button(panel, "Apply reviewed changes").disabled, false);
  await click(button(panel, "Apply reviewed changes"));
  assert.deepEqual(calls.find((call) => call.route.endsWith("/apply")).body, {
    reviewId: "independent-change-review",
  });
});

test("malformed or inconsistent conflict metadata never enables an apply request", async () => {
  const cases = [
    (result) => {
      result.changes[0].conflict = null;
      result.summary.conflicts = 1;
    },
    (result) => {
      result.changes[0].conflict = false;
      result.summary.conflicts = 0;
    },
    (result) => {
      result.changes[0].conflict = 0;
    },
    (result) => {
      result.changes[0].conflict = {};
      result.summary.conflicts = 1;
    },
    (result) => {
      result.changes[0].conflict = "";
      result.summary.conflicts = 1;
    },
    (result) => {
      result.changes[0].conflict = "   ";
      result.summary.conflicts = 1;
    },
    (result) => {
      result.changes[0].conflict = "The original changed.";
    },
    (result) => {
      result.summary.conflicts = 1;
    },
    (result) => {
      result.summary.conflicts = -1;
    },
    (result) => {
      result.summary.conflicts = "0";
    },
    (result) => {
      delete result.summary.conflicts;
    },
    (result) => {
      result.summary = null;
    },
  ];
  for (const malformed of cases) {
    const result = review();
    malformed(result);
    const calls = mock({
      mutate: (route) => (route.endsWith("/review") ? reply(result) : null),
    });
    const view = await render(agentsElement());
    await openReview(view);
    const panel = view.container.querySelector(".ba-workspace-review");
    assert.match(
      panel.querySelector('[role="alert"]').textContent,
      /Review details are incomplete/,
    );
    assert.equal(button(panel, "Apply reviewed changes").disabled, true);
    await click(button(panel, "Apply reviewed changes"));
    assert.equal(
      calls.filter((call) => call.route.endsWith("/apply")).length,
      0,
    );
    assert.ok(button(panel, "Review again"));
    await view.unmount();
    views.delete(view);
  }
});

test("discarding a copy requires separate confirmation and closing review never discards", async () => {
  const calls = mock({ agents: [session({ status: "revoked" })] });
  const view = await render(agentsElement());
  await dom.waitFor(() => button(view.container, "Review changes"));
  await click(button(view.container, "Review changes"));
  await click(
    button(view.container.querySelector(".ba-workspace-review"), "Close"),
  );
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
  await click(button(view.container, "Discard copy"));
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
  assert.match(
    view.container.querySelector('[aria-label="Confirm discard private copy"]')
      .textContent,
    /permanently removes this private copy/,
  );
  await click(button(view.container, "Discard private copy"));
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(
    calls.find((call) => call.method === "DELETE").route,
    `/api/agents/workspaces/${workspace.id}`,
  );
  assert.equal(view.container.querySelector(".ba-session"), null);
});

test("changing computers aborts a pending review and cannot carry its token into the new peer", async () => {
  let changePeer, release, signal;
  const calls = mock({
    mutate: (route, _body, init) =>
      route.endsWith("/review")
        ? new Promise((resolve) => {
            signal = init.signal;
            release = () => resolve(reply(review()));
          })
        : null,
  });
  function Host() {
    const [current, setPeer] = React.useState(peer);
    changePeer = setPeer;
    return agentsElement({ peer: current });
  }
  const view = await render(React.createElement(Host));
  await dom.waitFor(() => button(view.container, "Stop & review changes"));
  await click(button(view.container, "Stop & review changes"));
  await click(button(view.container, "Stop and review"));
  assert.ok(release);
  dom.update(() =>
    changePeer({
      ...peer,
      id: "other",
      url: "https://other.tail.ts.net:8443",
      token: "new-owner",
    }),
  );
  await settle(50);
  assert.equal(signal.aborted, true);
  release();
  await settle(50);
  assert.equal(view.container.querySelector(".ba-workspace-review"), null);
  assert.equal(calls.filter((call) => call.route.endsWith("/apply")).length, 0);
});

test("partial apply result stays visible and cannot be blindly reapplied", async () => {
  const calls = mock({
    mutate: (route) =>
      route.endsWith("/apply")
        ? reply({
            workspaceId: workspace.id,
            reviewId: "review-exact-one",
            applied: [],
            partial: true,
            failed: {
              root: 0,
              path: "notes.txt",
              message: "The disk became unavailable.",
            },
          })
        : null,
  });
  const view = await render(agentsElement());
  await openReview(view);
  await click(button(view.container, "Apply reviewed changes"));
  assert.match(
    view.container.querySelector(".ba-workspace-review").textContent,
    /disk became unavailable/,
  );
  assert.match(
    view.container.querySelector(".ba-workspace-review").textContent,
    /backups are retained/,
  );
  assert.equal(button(view.container, "Apply reviewed changes"), undefined);
  assert.equal(button(view.container, "Review again"), undefined);
  assert.equal(calls.filter((call) => call.route.endsWith("/apply")).length, 1);
});

test("persisted partial outcomes keep exact applied paths visible after returning to Agents", async () => {
  const calls = mock({
    agents: [
      session({
        status: "revoked",
        workspace: {
          ...workspace,
          status: "partial",
          lastApply: {
            workspaceId: workspace.id,
            reviewId: "prior-review",
            applied: [{ root: 0, path: "completed.txt", type: "changed" }],
            partial: true,
            failed: {
              root: 0,
              path: "failed.txt",
              message: "Original changed during apply",
            },
          },
        },
      }),
    ],
  });
  const view = await render(agentsElement());
  await dom.waitFor(() => view.container.querySelector(".ba-apply-history"));
  assert.match(view.container.textContent, /completed.txt/);
  assert.match(
    view.container.textContent,
    /failed.txt: Original changed during apply/,
  );
  assert.equal(button(view.container, "Review changes"), undefined);
  assert.ok(button(view.container, "Discard copy"));
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
});

test("hidden controls in reviewed content are visible and incomplete previews are labeled", async () => {
  mock({
    agents: [session({ status: "revoked" })],
    mutate: (route) => {
      if (!route.endsWith("/review")) return null;
      const result = review();
      result.changes[0].path = "note\u202etxt";
      result.changes[0].afterText = "visible\u202econtent";
      result.changes.push({
        ...result.changes[0],
        path: "large.txt",
        beforeText: null,
        afterText: null,
        previewTruncated: true,
      });
      return reply(result);
    },
  });
  const view = await render(agentsElement());
  await dom.waitFor(() => button(view.container, "Review changes"));
  await click(button(view.container, "Review changes"));
  const panel = view.container.querySelector(".ba-workspace-review");
  assert.ok(panel.textContent.includes("note\\u202etxt"));
  assert.ok(panel.textContent.includes("visible\\u202econtent"));
  assert.ok(!panel.textContent.includes("\u202e"));
  assert.match(panel.textContent, /too large for a complete text preview/);
});

test("workspace UI renders without React warnings", () =>
  assert.deepEqual(dom.errors, []));
