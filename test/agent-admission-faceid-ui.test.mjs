import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Face ID confirms approvals (Settings → Agents): the review says so, Approve
// becomes Approve with Face ID, called straight from the tap (as Safari
// requires) with options fetched beforehand, and its answer goes with the
// decision. Cancelled or refused: said, and tried again with fresh options.
// Off, no Face ID on this phone, or another computer's page: the review as
// it was. The switch on the Agents page, for your own devices only: on is a
// tap, off takes Face ID the same way.
let dom, React, AgentAdmissionReview, AgentFaceIdSetting;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ({ AgentAdmissionReview } = await dom.load("/src/agent-admissions.tsx"));
  ({ default: AgentFaceIdSetting } = await dom.load("/src/AgentFaceId.tsx"));
});
after(async () => dom?.close());

// The computer's own page (a passkey belongs to its name): the test page is reach.test.
const peer = {
  id: "mac",
  name: "My Mac",
  url: "https://reach.test:8443",
  token: "owner-token",
  platform: "darwin",
};
const admission = () => ({
  requestId: "claim-1",
  clientId: "muse",
  name: "Builder",
  scopes: ["device", "files:read"],
  roots: ["/Users/me/Project"],
  browser: false,
  requestedAt: Date.now(),
  expiresAt: Date.now() + 300000,
  accessExpiresAt: Date.now() + 3600000,
  verificationCode: "123456",
});
const bytes = (...b) => Uint8Array.from(b).buffer;
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const challengeOptions = (n) => ({
  challenge: Buffer.from(`challenge${n}`).toString("base64url"),
  rpId: "reach.test",
  allowCredentials: [{ type: "public-key", id: "AQID" }],
  userVerification: "required",
  timeout: 120000,
});
// The Mac and the phone's Face ID. `state.decide` answers the decision.
function phone({ faceId = true, on = true, keys = 1 } = {}) {
  const log = [];
  const state = {
    decide: () => reply({ status: "approved" }),
    optionsServed: 0,
    settingOptionsServed: 0,
  };
  let settings = { screen: true, ...(on ? { faceIdForAgents: true } : {}) };
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push([method, path, body]);
    if (path === "/api/settings" && method === "GET") return reply(settings);
    if (path === "/api/settings" && method === "POST") {
      // As the Mac does: off takes a Face ID answer while it's on.
      if (
        body.faceIdForAgents === false &&
        settings.faceIdForAgents &&
        !body.credential
      )
        return reply(
          { error: "Face ID turns this off. Use the phone that has it." },
          403,
        );
      settings = { ...settings, faceIdForAgents: body.faceIdForAgents };
      return reply(settings);
    }
    if (path === "/api/settings/passkey/options")
      return reply(challengeOptions(`s${++state.settingOptionsServed}`));
    if (path === "/api/auth/passkeys")
      return keys === 403
        ? reply(
            { error: "Only your own approved devices can manage Face ID." },
            403,
          )
        : reply({
            passkeys: Array.from({ length: keys }, (_, i) => ({
              id: `k${i}`,
              label: "iPhone",
              createdAt: "2026-10-05T10:00:00Z",
            })),
          });
    if (path === "/api/agents/admissions/claim-1/passkey/options")
      return reply(challengeOptions(++state.optionsServed));
    if (path === "/api/agents/admissions/claim-1") return state.decide(body);
    return reply({ error: "no" }, 404);
  };
  const PKC = function () {};
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => faceId;
  globalThis.PublicKeyCredential = dom.window.PublicKeyCredential = PKC;
  const calls = { get: [] };
  Object.defineProperty(dom.window.navigator, "credentials", {
    configurable: true,
    value: {
      get: (options) => {
        calls.get.push(options);
        return calls.getResult
          ? calls.getResult()
          : Promise.resolve({
              id: "AQID",
              rawId: bytes(1, 2, 3),
              type: "public-key",
              response: {
                clientDataJSON: bytes(123, 125),
                authenticatorData: bytes(9, 9),
                signature: bytes(7),
                userHandle: null,
              },
            });
      },
    },
  });
  return { log, calls, state };
}
const button = (c, label) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const click = async (element) => {
  assert.ok(element, "the control exists");
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(30);
};
const options = (log) =>
  log.filter(
    ([, path]) => path === "/api/agents/admissions/claim-1/passkey/options",
  ).length;
const settingOptions = (log) =>
  log.filter(([, path]) => path === "/api/settings/passkey/options").length;
const decisions = (log) =>
  log.filter(
    ([method, path]) =>
      method === "POST" && path === "/api/agents/admissions/claim-1",
  );
const settingPosts = (log) =>
  log
    .filter(([method, path]) => method === "POST" && path === "/api/settings")
    .map(([, , body]) => body);
const review = (props = {}) =>
  dom.render(
    React.createElement(AgentAdmissionReview, {
      peer,
      admission: admission(),
      onClose() {},
      onResolved() {},
      ...props,
    }),
  );

test("on: the review says so, and Approve with Face ID calls it in the tap and sends its answer with the decision", async () => {
  const { log, calls } = phone();
  let resolved = 0;
  const view = await review({ onResolved: () => resolved++ });
  const c = view.container;
  await dom.waitFor(() => c.textContent.includes("Face ID confirms approvals"));
  await dom.waitFor(() => options(log) === 1);
  await settle(40);
  assert.equal(
    button(c, "Approve with Face ID").disabled,
    true,
    "the code first",
  );
  await click(c.querySelector('input[type="checkbox"]'));
  const approve = button(c, "Approve with Face ID");
  assert.equal(approve.disabled, false, "options ready before the tap");
  approve.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(calls.get.length, 1, "Face ID called in the tap itself");
  assert.equal(calls.get[0].publicKey.rpId, "reach.test");
  assert.deepEqual(
    [...new Uint8Array(calls.get[0].publicKey.allowCredentials[0].id)],
    [1, 2, 3],
  );
  await dom.waitFor(() => resolved === 1);
  const [sent] = decisions(log);
  assert.equal(sent[2].decision, "approve");
  assert.equal(sent[2].credential.rawId, "AQID");
  assert.equal(sent[2].credential.response.clientDataJSON, "e30");
  assert.equal(sent[2].credential.response.authenticatorData, "CQk");
  assert.equal(sent[2].credential.response.signature, "Bw");
  assert.equal(decisions(log).length, 1);
  await view.unmount();
});

test("Face ID cancelled, or its answer refused: said in the Mac's own words, nothing approved, fresh options for another try", async () => {
  const { log, calls, state } = phone();
  calls.getResult = () =>
    Promise.reject(
      Object.assign(
        new Error("The operation either timed out or was not allowed."),
        { name: "NotAllowedError" },
      ),
    );
  const view = await review();
  const c = view.container;
  await dom.waitFor(() => options(log) === 1);
  await settle(40);
  await click(c.querySelector('input[type="checkbox"]'));
  await click(button(c, "Approve with Face ID"));
  await dom.waitFor(() =>
    c.textContent.includes("Face ID was cancelled or took too long"),
  );
  assert.equal(decisions(log).length, 0, "no decision without its answer");
  await dom.waitFor(() => options(log) === 2);
  await settle(40);
  assert.equal(button(c, "Approve with Face ID").disabled, false, "try again");
  // The Mac refuses the answer: its words, not the usual "pair again"; the
  // request still waits, and new options are fetched.
  calls.getResult = null;
  state.decide = () =>
    reply({ error: "That Face ID response didn't check out." }, 401);
  await click(button(c, "Approve with Face ID"));
  await dom.waitFor(() =>
    c.textContent.includes("That Face ID response didn't check out"),
  );
  assert.ok(!c.textContent.includes("Pair this device again"));
  assert.ok(
    !c.textContent.includes("Request expired"),
    "the request still waits",
  );
  await dom.waitFor(() => options(log) === 3);
  await settle(40);
  assert.equal(button(c, "Approve with Face ID").disabled, false);
  assert.equal(decisions(log).length, 1);
  await view.unmount();
});

test("off: the review as it was, nothing asked for Face ID, the code alone approves", async () => {
  const { log, calls } = phone({ on: false });
  let resolved = 0;
  const view = await review({ onResolved: () => resolved++ });
  const c = view.container;
  await settle(80);
  assert.ok(!c.textContent.includes("Face ID confirms approvals"));
  await click(c.querySelector('input[type="checkbox"]'));
  await click(button(c, "Approve connection"));
  await dom.waitFor(() => resolved === 1);
  assert.equal(calls.get.length, 0);
  assert.equal(options(log), 0);
  assert.deepEqual(
    decisions(log).map(([, , body]) => body),
    [{ decision: "approve" }],
  );
  await view.unmount();
});

test("no Face ID on this phone, or another computer's page: nothing asked, Approve as before", async () => {
  for (const [label, opts, p] of [
    ["no Face ID on this phone", { faceId: false }, peer],
    [
      "another computer's page",
      {},
      { ...peer, id: "b", url: "https://mac-b.t.ts.net:8443" },
    ],
  ]) {
    const { log } = phone(opts);
    const view = await review({ peer: p });
    await settle(80);
    assert.ok(button(view.container, "Approve connection"), label);
    assert.equal(
      log.filter(([, path]) => path === "/api/settings").length,
      0,
      label,
    );
    assert.equal(options(log), 0, label);
    await view.unmount();
  }
});

test("Settings → Agents: the switch, for your own devices once Face ID is set up here; on is a tap, off takes Face ID in the tap", async () => {
  const { log, calls } = phone({ on: false });
  let view = await dom.render(
    React.createElement(AgentFaceIdSetting, { peer }),
  );
  let c = view.container;
  const state = () =>
    c.querySelector('[role="switch"]').getAttribute("aria-checked");
  await dom.waitFor(() => c.querySelector('[role="switch"]'));
  assert.match(c.textContent, /Face ID confirms approvals/);
  assert.match(c.textContent, /Each agent connection you allow/);
  assert.ok(c.querySelector(".gs-group .gs-row"), "a grouped-list row");
  assert.equal(state(), "false");
  await settle(60);
  assert.equal(settingOptions(log), 0, "nothing to answer while it's off");
  await click(c.querySelector('[role="switch"]'));
  await dom.waitFor(() => state() === "true");
  assert.equal(calls.get.length, 0, "on is a tap");
  // On: the options come before the tap; off calls Face ID in the tap and
  // sends its answer with the switch.
  await dom.waitFor(() => settingOptions(log) === 1);
  await settle(40);
  c.querySelector('[role="switch"]').dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true }),
  );
  assert.equal(calls.get.length, 1, "Face ID called in the tap itself");
  assert.equal(calls.get[0].publicKey.rpId, "reach.test");
  await dom.waitFor(() => state() === "false");
  const posts = settingPosts(log);
  assert.deepEqual(posts[0], { faceIdForAgents: true });
  assert.equal(posts[1].faceIdForAgents, false);
  assert.equal(posts[1].credential.rawId, "AQID");
  assert.equal(posts[1].credential.response.signature, "Bw");
  assert.equal(posts.length, 2);
  await view.unmount();
  // Cancelled: said, still on, fresh options for another try.
  const cancelled = phone({ on: true });
  cancelled.calls.getResult = () =>
    Promise.reject(
      Object.assign(new Error("not allowed"), { name: "NotAllowedError" }),
    );
  view = await dom.render(React.createElement(AgentFaceIdSetting, { peer }));
  c = view.container;
  await dom.waitFor(() => settingOptions(cancelled.log) === 1);
  await settle(40);
  await click(c.querySelector('[role="switch"]'));
  await dom.waitFor(() =>
    c.textContent.includes("Face ID was cancelled or took too long"),
  );
  assert.equal(state(), "true");
  assert.equal(
    settingPosts(cancelled.log).length,
    0,
    "nothing sent without its answer",
  );
  await dom.waitFor(() => settingOptions(cancelled.log) === 2);
  await view.unmount();
  // Another computer's page: no Face ID for this computer's passkey here,
  // so the Mac's refusal is shown and it stays on.
  const elsewhere = phone({ on: true });
  view = await dom.render(
    React.createElement(AgentFaceIdSetting, {
      peer: { ...peer, id: "b", url: "https://mac-b.t.ts.net:8443" },
    }),
  );
  c = view.container;
  await dom.waitFor(() => c.querySelector('[role="switch"]'));
  await settle(60);
  assert.equal(settingOptions(elsewhere.log), 0);
  await click(c.querySelector('[role="switch"]'));
  await dom.waitFor(() =>
    c.textContent.includes(
      "Face ID turns this off. Use the phone that has it.",
    ),
  );
  assert.equal(state(), "true");
  assert.equal(elsewhere.calls.get.length, 0);
  await view.unmount();
  // Without Face ID set up here, or not your own device: no row at all.
  for (const opts of [{ keys: 0 }, { keys: 403 }]) {
    phone(opts);
    view = await dom.render(React.createElement(AgentFaceIdSetting, { peer }));
    await settle(80);
    assert.equal(view.container.textContent, "", JSON.stringify(opts));
    await view.unmount();
  }
});

test("clean (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});
