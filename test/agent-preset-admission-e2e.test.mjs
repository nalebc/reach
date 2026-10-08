import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import {
  presetFixture,
  privateIngressTest,
  apps,
} from "./helpers/preset-fixture.mjs";

// Real private-ingress HTTP, auth/admission state and rendered owner UI. Only
// native app/input adapters are inert; these tests never control the host.
let dom, AgentAdmissionReview;
before(async () => {
  dom = await startDom();
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ AgentAdmissionReview } = await dom.load("/src/agent-admissions.tsx"));
});
after(async () => dom?.close());
const claim = async (f, body) => {
  const created = await f.invite(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const result = await f.call("/api/invitations/redeem", {
    node: "nAgent",
    token: "",
    method: "POST",
    body: { invitation: created.body.invitation },
  });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.status, "pending");
  assert.equal(result.body.token, undefined);
  return { created: created.body, receipt: result.body };
};
const poll = (f, receipt, overrides = {}) =>
  f.call(`/api/invitations/claims/${receipt.requestId}/status`, {
    node: "nAgent",
    token: "",
    method: "POST",
    body: { secret: receipt.requestSecret },
    ...overrides,
  });
async function review(f, receipt) {
  const owner = f.reach.auth.issue("Fixture owner", ALL_SCOPES, "device", {
    tailscale: { nodeId: "nPhone", userId: "42" },
  });
  const peer = {
    id: "mac",
    name: "Fixture Mac",
    platform: "darwin",
    url: "https://reach.test",
    token: owner.token,
  };
  const listed = await f.call("/api/agents/admissions");
  assert.equal(listed.status, 200);
  const admission = listed.body.find(
    (item) => item.requestId === receipt.requestId,
  );
  assert.ok(admission);
  assert.equal(admission.verificationCode, receipt.verificationCode);
  assert.equal(admission.clientId, receipt.clientId);
  assert.equal(
    JSON.stringify(admission).includes(apps.chrome.identity),
    false,
    "signing hashes are not admission UI data",
  );
  const sent = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, peer.url);
    const authorization = new Headers(init.headers).get("Authorization");
    assert.equal(authorization, `Bearer ${owner.token}`);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    sent.push({ path: parsed.pathname, body });
    const result = await f.call(parsed.pathname + parsed.search, {
      token: owner.token,
      method: init.method || "GET",
      body,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  let resolved = 0;
  const view = await dom.render(
    dom.React.createElement(AgentAdmissionReview, {
      peer,
      admission,
      onClose() {},
      onResolved() {
        resolved++;
      },
    }),
  );
  const button = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Approve connection",
  );
  assert.ok(button?.disabled, "matching the code is still required");
  assert.equal(
    view.container.querySelector("output").textContent,
    receipt.verificationCode,
  );
  const approve = async () => {
    const checkbox = view.container.querySelector('input[type="checkbox"]');
    checkbox.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
    await settle();
    assert.equal(button.disabled, false);
    button.click();
    await dom.waitFor(() => resolved === 1);
    assert.deepEqual(sent, [
      {
        path: `/api/agents/admissions/${receipt.requestId}`,
        body: { decision: "approve" },
      },
    ]);
  };
  return {
    ...view,
    admission,
    approve,
    permissions: view.container.querySelector(
      '[aria-label="Invited permissions"]',
    ),
  };
}

const cases = [
  {
    preset: "full",
    title: "Full control",
    write: true,
    screen: true,
    control: true,
    shell: true,
    hidden: true,
  },
  {
    preset: "apps",
    title: "Apps",
    write: false,
    screen: true,
    control: true,
    shell: false,
  },
  {
    preset: "files",
    title: "Files",
    write: true,
    screen: false,
    control: false,
    shell: false,
  },
  {
    preset: "files",
    title: "Files",
    write: false,
    screen: false,
    control: false,
    shell: false,
  },
  {
    preset: "readonly",
    title: "Read only",
    write: false,
    screen: true,
    control: false,
    shell: false,
    hidden: true,
  },
];
for (const row of cases)
  test(
    `actual ${row.preset}${row.write ? " writable" : ""} claim displays exactly its effective permissions before approval`,
    privateIngressTest,
    async (t) => {
      const actions = [];
      const f = await presetFixture(t, {
        desktopExtras: {
          front: async (client, authorize) => {
            authorize();
            actions.push(["front", client.id]);
            return {
              app: "Google Chrome",
              bundle: "com.google.Chrome",
              title: "Fixture",
              secure: false,
            };
          },
          act: async (client, action, authorize) => {
            authorize();
            actions.push(["act", client.id, action]);
            return { ok: true, app: "Google Chrome" };
          },
        },
      });
      const invitation = {
        preset: row.preset,
        ...(row.preset === "apps"
          ? { apps: [{ id: apps.chrome.id }] }
          : { folders: [{ root: 0, path: "Desktop/Project" }] }),
        ...(row.preset === "files" ? { write: row.write } : {}),
        ...(row.hidden ? { hidden: [{ id: apps.messages.id }] } : {}),
      };
      const { receipt } = await claim(f, invitation);
      const pending = await poll(f, receipt);
      assert.equal(pending.body.status, "pending");
      assert.equal(pending.body.token, undefined);
      const view = await review(f, receipt);
      t.after(() => view.unmount());
      const text = view.permissions.textContent;
      assert.doesNotMatch(text, /Shared computer details only/);
      if (row.preset !== "apps") {
        assert.match(text, row.write ? /Read and edit files/ : /Read files/);
        assert.equal(text.includes("Read & write"), row.write);
      } else {
        assert.match(
          view.container.querySelector('[aria-label="Shared apps"]')
            .textContent,
          /Google Chrome/,
        );
        assert.match(text, /Only selected app windows/);
        assert.doesNotMatch(text, /Read files|Read and edit files/);
      }
      assert.equal(text.includes("Screen control"), row.control);
      assert.equal(text.includes("View only"), row.screen && !row.control);
      assert.equal(text.includes("Shell commands"), row.shell);
      assert.equal(text.includes("including sensitive files"), row.shell);
      assert.equal(text.includes("not a sandbox"), row.shell);
      if (row.hidden) {
        assert.match(
          view.container.querySelector('[aria-label="Hidden apps"]')
            .textContent,
          /Messages/,
        );
        assert.deepEqual(view.admission.hidden, [
          { id: apps.messages.id, name: "Messages" },
        ]);
      }
      assert.match(text, new RegExp(`Preset: ${row.title}`));
      await view.approve();
      const approved = await poll(f, receipt);
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.status, "approved");
      const as = (route, opts = {}) =>
        f.call(route, { node: "nAgent", token: approved.body.token, ...opts });
      const access = await as("/api/browser");
      assert.equal(access.status, 200);
      assert.deepEqual(
        [
          access.body.write,
          access.body.screen,
          access.body.control,
          access.body.shell,
        ],
        [row.write, row.screen, row.control, row.shell],
      );
      assert.equal(
        (await as("/api/browser/desktop/front")).status,
        row.screen ? 200 : 403,
      );
      assert.equal(
        (
          await as("/api/browser/desktop/input", {
            method: "POST",
            body: { action: { type: "click", x: 0.5, y: 0.5 } },
          })
        ).status,
        row.control ? 200 : 403,
      );
      assert.equal(
        (await as("/api/agents/admissions")).status,
        403,
        "an invited agent cannot approve another agent",
      );
      assert.equal(
        (
          await as("/api/agents/browser-invitations", {
            method: "POST",
            body: { name: "Child", preset: "full", ttlSeconds: 600 },
          })
        ).status,
        403,
      );
      f.reach.auth.revoke(receipt.clientId);
      assert.equal((await as("/api/browser")).status, 401);
      assert.equal((await poll(f, receipt)).body.token, undefined);
    },
  );

test(
  "same-name agent claims remain distinct through owner UI approval and revocation",
  privateIngressTest,
  async (t) => {
    const f = await presetFixture(t);
    const a = await claim(f, { name: "Muse", preset: "readonly" });
    const b = await claim(f, { name: "Muse", preset: "readonly" });
    assert.notEqual(a.receipt.clientId, b.receipt.clientId);
    assert.notEqual(a.receipt.requestId, b.receipt.requestId);
    assert.notEqual(a.receipt.requestSecret, b.receipt.requestSecret);
    const cross = await poll(f, a.receipt, {
      body: { secret: b.receipt.requestSecret },
    });
    assert.equal(cross.status, 401);
    const first = await review(f, a.receipt);
    await first.approve();
    await first.unmount();
    const joinedA = await poll(f, a.receipt);
    assert.equal(joinedA.body.status, "approved");
    assert.equal((await poll(f, b.receipt)).body.status, "pending");
    const second = await review(f, b.receipt);
    await second.approve();
    await second.unmount();
    const joinedB = await poll(f, b.receipt);
    assert.equal(joinedB.body.status, "approved");
    assert.notEqual(joinedA.body.token, joinedB.body.token);
    f.reach.auth.revoke(a.receipt.clientId);
    assert.equal(
      (
        await f.call("/api/browser", {
          node: "nAgent",
          token: joinedA.body.token,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.call("/api/browser", {
          node: "nAgent",
          token: joinedB.body.token,
        })
      ).status,
      200,
    );
    assert.deepEqual(dom.errors, []);
  },
);
