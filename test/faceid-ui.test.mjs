import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Face ID on the phone's connect screen: a new browser of yours is approved
// with it (called straight from the tap, as Safari requires), the first
// browser is offered it for next time, and the code at the computer always
// stays as the fallback.
let dom, React, ConnectForm;
before(async () => {
  // A page on your tailnet, as Reach is always reached.
  dom = await startDom({ mobile: true, url: "https://reach.t.ts.net/" });
  React = dom.React;
  ConnectForm = (await dom.load("/src/ConnectForm.tsx")).default;
});
after(async () => dom?.close());

const REQUEST = "11111111-2222-3333-4444-555555555555";
const bytes = (...b) => Uint8Array.from(b).buffer;
function phone({ faceId = true, passkey = true, approveAfterFaceId = true } = {}) {
  const log = [];
  let faceDone = false;
  const reply = (status, value) =>
    new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push([init.method || "GET", u.host, u.pathname, body, init.headers?.Authorization]);
    if (u.pathname === "/api/auth/method") return reply(200, { method: "tailscale", eligible: true, login: "me@x.test" });
    if (u.pathname === "/api/auth/requests") return reply(202, { id: REQUEST, secret: "s3cret", expiresAt: Date.now() + 300000, verification: "11111111", ...(passkey ? { passkey: true } : {}) });
    if (u.pathname === `/api/auth/requests/${REQUEST}/passkey/options`)
      return reply(200, { challenge: "Y2hhbGxlbmdl", rpId: "reach.t.ts.net", allowCredentials: [{ type: "public-key", id: "AQID" }], userVerification: "required" });
    if (u.pathname === `/api/auth/requests/${REQUEST}/passkey`) return (faceDone = approveAfterFaceId), reply(200, { approved: true });
    if (u.pathname === `/api/auth/requests/${REQUEST}`)
      return reply(200, passkey && !faceDone ? { status: "pending" } : { status: "approved", token: "T0KEN", device: { id: "mac-a", name: "Mac A", platform: "darwin" } });
    if (u.pathname === "/api/auth/passkeys/options")
      return reply(200, { challenge: "cmVnaXN0ZXI", rp: { id: "reach.t.ts.net", name: "Reach" }, user: { id: "dXNlcg", name: "me@x.test", displayName: "me@x.test" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [] });
    if (u.pathname === "/api/auth/passkeys") return reply(201, { id: "AQID", label: "iPhone", createdAt: "now" });
    return reply(404, { error: "no" });
  };
  const calls = { get: [], create: [] };
  const PKC = function () {};
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => faceId;
  globalThis.PublicKeyCredential = dom.window.PublicKeyCredential = PKC;
  const credentials = {
    get: (options) => {
      calls.get.push(options);
      return calls.getResult ? calls.getResult() : Promise.resolve({ id: "AQID", rawId: bytes(1, 2, 3), type: "public-key", response: { clientDataJSON: bytes(123, 125), authenticatorData: bytes(9, 9), signature: bytes(7), userHandle: null } });
    },
    create: (options) => {
      calls.create.push(options);
      return Promise.resolve({ id: "AQID", rawId: bytes(1, 2, 3), type: "public-key", response: { clientDataJSON: bytes(123, 125), attestationObject: bytes(160), getTransports: () => ["internal"] } });
    },
  };
  Object.defineProperty(dom.window.navigator, "credentials", { value: credentials, configurable: true });
  return { log, calls };
}
const render = (props = {}, { saved = [] } = {}) => {
  const paired = [];
  dom.window.sessionStorage.clear();
  dom.window.localStorage.removeItem("reach.devices");
  if (saved.length) dom.window.localStorage.setItem("reach.devices", JSON.stringify(saved));
  return dom
    .render(React.createElement(ConnectForm, { initialUrl: "https://reach.t.ts.net:8443", name: "iPhone", onPaired: (p) => paired.push(p), legacy: () => null, ...props }))
    .then((view) => ({ view, c: view.container, paired }));
};
const button = (c, text) => [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(40);
};
// A fresh browser asks by itself; otherwise (another computer) it's a tap.
const connect = async (c) => {
  await settle(450); // the screen checks the connection first
  const tap = button(c, "Connect to this computer");
  if (tap) await click(tap);
  await settle(120);
};

test("a new browser of yours: Use Face ID approves it, called straight from the tap", async () => {
  delete dom.window.document.documentElement.dataset.connection;
  const { log, calls } = phone();
  const { view, c, paired } = await render();
  await connect(c);
  const face = button(c, "Continue with Face ID");
  assert.ok(face, "one button while the request waits");
  assert.match(c.textContent, /No Face ID\? Type 11111111 in\s*Reach on your computer/, "the code stays as the fallback");
  // Safari only shows Face ID from the tap itself: WebAuthn is called during
  // the click, before anything is awaited.
  face.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(calls.get.length, 1, "called synchronously in the tap");
  assert.equal(calls.get[0].publicKey.rpId, "reach.t.ts.net");
  assert.deepEqual([...new Uint8Array(calls.get[0].publicKey.allowCredentials[0].id)], [1, 2, 3]);
  await settle(1800); // the usual poll picks up the approval
  const sent = log.find(([, , p]) => p === `/api/auth/requests/${REQUEST}/passkey`)[3];
  assert.equal(sent.secret, "s3cret");
  assert.equal(sent.credential.rawId, "AQID");
  assert.equal(sent.credential.response.clientDataJSON, "e30");
  assert.equal(sent.credential.response.authenticatorData, "CQk");
  assert.equal(paired.length, 1);
  assert.equal(paired[0].token, "T0KEN");
  await view.unmount();
});

test("Face ID cancelled: says so, keeps the code, and can be tried again", async () => {
  const { calls } = phone();
  calls.getResult = () => Promise.reject(Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }));
  const { view, c, paired } = await render();
  await connect(c);
  await click(button(c, "Continue with Face ID"));
  await settle(80);
  assert.match(c.textContent, /Face ID was cancelled or took too long/);
  assert.match(c.textContent, /11111111/, "the code to approve at the computer is still there");
  assert.equal(button(c, "Continue with Face ID").disabled, false, "fresh options: try again");
  assert.equal(paired.length, 0);
  await view.unmount();
});

test("no Face ID here, or another computer's address: just the code, nothing fetched", async () => {
  for (const [label, opts, props] of [
    ["no Face ID on this phone", { faceId: false }, {}],
    ["another computer (its passkey isn't this page's)", {}, { initialUrl: "https://mac-b.t.ts.net:8443" }],
  ]) {
    const { log } = phone(opts);
    const { view, c } = await render(props);
    await connect(c);
    assert.equal(button(c, "Continue with Face ID"), undefined, label);
    assert.equal(log.filter(([, , p]) => p.endsWith("/passkey/options")).length, 0, label);
    await view.unmount();
  }
});

test("the first browser, signed in from the browser: offered Face ID for next time", async () => {
  dom.window.document.documentElement.dataset.connection = "browser";
  dom.window.localStorage.clear();
  const { log, calls } = phone({ passkey: false });
  const { view, c, paired } = await render();
  await connect(c);
  await settle(1800);
  assert.match(c.textContent, /Next time, this phone’s other browsers can use Face ID/);
  assert.equal(paired.length, 0, "connected once the offer is answered");
  const add = button(c, "Use Face ID next time");
  await settle(60);
  assert.equal(add.disabled, false, "options ready before the tap");
  const optionsCall = log.find(([, , p]) => p === "/api/auth/passkeys/options");
  assert.equal(optionsCall[4], "Bearer T0KEN", "asked with the new credential");
  add.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(calls.create.length, 1, "created straight from the tap");
  assert.deepEqual([...new Uint8Array(calls.create[0].publicKey.user.id)], [117, 115, 101, 114], "the user id as bytes");
  await settle(80);
  const saved = log.find(([m, , p]) => m === "POST" && p === "/api/auth/passkeys");
  assert.equal(saved[4], "Bearer T0KEN");
  assert.equal(saved[3].credential.response.attestationObject, "oA");
  assert.deepEqual(saved[3].credential.response.transports, ["internal"]);
  assert.equal(paired.length, 1);
  await view.unmount();
});

test("Not now: connected at once, and not offered again on this computer", async () => {
  dom.window.document.documentElement.dataset.connection = "browser";
  dom.window.localStorage.clear();
  phone({ passkey: false });
  let { view, c, paired } = await render();
  await connect(c);
  await settle(1800);
  await click(button(c, "Not now"));
  assert.equal(paired.length, 1);
  await view.unmount();
  ({ view, c, paired } = await render());
  await connect(c);
  await settle(1800);
  assert.equal(button(c, "Not now"), undefined, "not asked twice");
  assert.equal(paired.length, 1);
  await view.unmount();
  // With the Tailscale app (not a browser sign-in), never offered.
  delete dom.window.document.documentElement.dataset.connection;
  dom.window.localStorage.clear();
  phone({ passkey: false });
  ({ view, c, paired } = await render());
  await connect(c);
  await settle(1800);
  assert.equal(paired.length, 1, "the app already makes every browser one device");
  await view.unmount();
});

test("a fresh browser asks its computer by itself; adding another computer still waits for the tap", async () => {
  delete dom.window.document.documentElement.dataset.connection;
  let { log } = phone();
  // Opened at its own computer's address, as a fresh browser is.
  let { view, c } = await render({ initialUrl: undefined });
  await settle(600);
  assert.equal(!!button(c, "Connect to this computer"), false, "no second Connect step");
  assert.equal(log.filter(([m, , p]) => m === "POST" && p === "/api/auth/requests").length, 1, "asked once, by itself");
  assert.equal(!!button(c, "Continue with Face ID"), true);
  await view.unmount();
  // With a computer already saved (the Add computer dialog): ask on a tap only.
  ({ log } = phone());
  ({ view, c } = await render({ initialUrl: undefined }, { saved: [{ id: "x", name: "Mac X", url: "https://x.t.ts.net:8443", token: "t", platform: "darwin" }] }));
  await settle(600);
  assert.equal(log.filter(([, , p]) => p === "/api/auth/requests").length, 0, "nothing asked unprompted");
  assert.equal(!!button(c, "Connect to this computer"), true);
  await view.unmount();
  dom.window.localStorage.removeItem("reach.devices");
});

test("leaving during the offer (phone locked, reload) keeps the approval: saved before asking", async () => {
  dom.window.document.documentElement.dataset.connection = "browser";
  dom.window.localStorage.clear();
  phone({ passkey: false });
  const { view, c, paired } = await render();
  await connect(c);
  await settle(1800);
  assert.match(c.textContent, /Use Face ID next time/, "the offer is up");
  assert.equal(paired.length, 0);
  // Already saved, with its new credential, as the computer to open (signed
  // in from the browser: that way's own list, src/api.ts).
  const saved = JSON.parse(dom.window.localStorage.getItem("reach.browser.devices") || "[]");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].token, "T0KEN");
  assert.equal(saved[0].url, "https://reach.t.ts.net:8443");
  assert.equal(dom.window.localStorage.getItem("reach.browser.active"), saved[0].id);
  assert.equal(dom.window.localStorage.getItem("reach.devices"), null, "not the app way's");
  await view.unmount(); // the phone goes away mid-offer
  dom.window.localStorage.clear();
});

test("clean (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});
