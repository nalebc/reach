import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
import { tskey } from "./helpers/fake-keys.mjs";

// Face ID sign-in in the browser: a new browser of yours, no Tailscale app,
// opens the link and sees one button. Face ID (straight from the tap), and
// the computer's one-time key and ticket follow; Connect then uses the
// ticket once. A browser whose Face ID access ended is offered Face ID again.
const CONFIG = {
  product: "Reach",
  origin: "https://mac.t.ts.net:8443",
  home: "https://mac.t.ts.net",
  faceId: true,
  name: "Mac A",
  instance: "i1",
  tailnet: { wasm: "client.wasm", exec: "exec.js" },
};
const log = [];
const answers = {};
let dom, React, ConnectForm, flow, face;
const bytes = (...b) => Uint8Array.from(b).buffer;
const credentials = { get: [] };
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: Object.fromEntries(
      ["/reach-start.json", "/faceid/options", "/faceid/join", "/tailnet/client.wasm", "/api/auth/method", "/api/auth/face-join"].map((p) => [
        p,
        (init, href) => {
          log.push([init.method || "GET", href.host, p, init.body ? JSON.parse(init.body) : undefined]);
          return answers[p]?.(init) ?? new Response("{}", { status: 404 });
        },
      ]),
    ),
  });
  React = dom.React;
  const PKC = function () {};
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  globalThis.PublicKeyCredential = dom.window.PublicKeyCredential = PKC;
  Object.defineProperty(dom.window.navigator, "credentials", {
    configurable: true,
    value: {
      get: (options) => {
        credentials.get.push(options);
        return Promise.resolve({ id: "AQID", rawId: bytes(1, 2, 3), type: "public-key", response: { clientDataJSON: bytes(123, 125), authenticatorData: bytes(9), signature: bytes(7), userHandle: bytes(5) } });
      },
    },
  });
  ConnectForm = (await dom.load("/src/ConnectForm.tsx")).default;
  flow = await dom.load("/src/start-flow.ts");
  face = await dom.load("/src/face-start.ts");
});
after(async () => dom?.close());

const json = (value, status = 200) => () => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text);

test("the start page: a new browser opens with one Face ID button, and the tap goes straight to Face ID", async () => {
  answers["/reach-start.json"] = json(CONFIG);
  answers["/faceid/options"] = json({ id: "ask-1", options: { challenge: "Y2hhbGxlbmdl", rpId: "mac.t.ts.net", allowCredentials: [], userVerification: "required", timeout: 120000 } });
  answers["/faceid/join"] = json({ key: tskey("auth-kX-abc"), hostname: "rf-ab12-aaaaaaaaaa", ticket: "T".repeat(43) });
  answers["/tailnet/client.wasm"] = () => new Response("wasm");
  dom.document.body.insertAdjacentHTML("beforeend", '<main id="start"></main>');
  dom.window.fetch = globalThis.fetch; // a browser's window.fetch is its fetch
  await dom.load("/src/start.ts");
  const view = await dom.waitFor(() => dom.document.getElementById("start"));
  const tap = await dom.waitFor(() => button(view, "Continue with Face ID"));
  assert.match(view.textContent, /Open Mac A/);
  assert.match(view.textContent, /With Face ID on this phone\. Nothing to install\./);
  assert.ok(button(view, "Sign in with Tailscale instead"), "Tailscale sign-in stays as the other way");
  assert.ok(!/Step 1 of 2/.test(view.textContent), "one step, not two");
  assert.ok(log.some(([m, , p]) => m === "POST" && p === "/faceid/options"), "asked ahead of the tap");
  assert.ok(log.some(([, , p]) => p === "/tailnet/client.wasm"), "the browser's Tailscale client loads meanwhile");
  tap.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(credentials.get.length, 1, "Face ID called in the tap itself");
  assert.deepEqual(credentials.get[0].publicKey.allowCredentials, []);
  await dom.waitFor(() => log.some(([, , p]) => p === "/faceid/join"));
  const [, , , sent] = log.find(([, , p]) => p === "/faceid/join");
  assert.equal(sent.id, "ask-1");
  assert.equal(sent.credential.rawId, "AQID");
  assert.equal(sent.credential.response.userHandle, "BQ");
  await dom.waitFor(() => /Connecting to Mac A/.test(view.textContent));
  // The ticket waits for Connect; this browser's device is a Face ID one.
  assert.equal(dom.window.localStorage.getItem(face.FACE_DEVICE), "1");
  assert.equal(face.hasTicket(), true);
  const ticket = face.takeTicket();
  assert.equal(ticket.ticket, "T".repeat(43));
  assert.equal(ticket.origin, CONFIG.origin, "Reach's private port: the one a Face ID device may use");
  assert.equal(face.takeTicket(), null, "taken once");
});

test("Connect uses the ticket once, at once: yours, with no request to approve", async () => {
  dom.document.documentElement.dataset.connection = "browser";
  dom.window.localStorage.clear();
  log.length = 0;
  answers["/api/auth/method"] = json({ method: "tailscale", eligible: false, faceJoin: true });
  let release;
  answers["/api/auth/face-join"] = () => new Promise((r) => (release = () => r(json({ status: "approved", token: "TOKEN", device: { id: "mac-a", name: "Mac A", platform: "darwin" } })())));
  face.saveTicket("T".repeat(43), CONFIG.origin);
  const paired = [];
  const view = await dom.render(React.createElement(ConnectForm, { name: "iPhone", onPaired: (p) => paired.push(p), legacy: () => null }));
  await settle(50);
  assert.match(view.container.textContent, /Signing you in…/);
  assert.equal(button(view.container, "Continue with Face ID"), undefined, "not asked to start over meanwhile");
  release();
  await settle(50);
  const redeemed = log.filter(([, , p]) => p === "/api/auth/face-join");
  assert.equal(redeemed.length, 1, "once");
  assert.equal(redeemed[0][1], "mac.t.ts.net:8443");
  assert.deepEqual(redeemed[0][3], { ticket: "T".repeat(43), name: "iPhone" });
  assert.equal(paired.length, 1);
  assert.equal(paired[0].token, "TOKEN");
  assert.equal(paired[0].url, CONFIG.origin);
  assert.equal(face.hasTicket(), false);
  await view.unmount();
});

test("an expired ticket, or access that ended: Continue with Face ID signs this browser in again", async () => {
  dom.document.documentElement.dataset.connection = "browser";
  log.length = 0;
  answers["/api/auth/method"] = json({ method: "tailscale", eligible: false, faceJoin: true });
  answers["/api/auth/face-join"] = json({ error: "This Face ID sign-in expired. Try again." }, 401);
  face.saveTicket("T".repeat(43), CONFIG.origin);
  const paired = [];
  const view = await dom.render(React.createElement(ConnectForm, { initialUrl: CONFIG.origin, name: "iPhone", onPaired: (p) => paired.push(p), legacy: () => null }));
  await settle(500);
  assert.equal(paired.length, 0);
  assert.match(view.container.textContent, /This Face ID sign-in expired/);
  assert.ok(button(view.container, "Continue with Face ID"));
  assert.ok(!/Install Tailscale/.test(view.container.textContent), "no app or Tailscale login to set up");
  assert.ok(!log.some(([m, , p]) => m === "POST" && p === "/api/auth/requests"), "never a request to approve");
  await view.unmount();
});

test("starting over forgets this browser's old device and what it saved, and only when asked", () => {
  const ls = dom.window.localStorage;
  ls.clear();
  ls.setItem("reach.tailnet:_current-profile", "p1");
  ls.setItem("reach.tailnet:p1", "state");
  ls.setItem(face.FACE_DEVICE, "1");
  ls.setItem("reach.browser.devices", "[kept]");
  assert.equal(face.forgetIfFresh(), false, "not asked: nothing forgotten");
  assert.equal(ls.getItem("reach.tailnet:p1"), "state");
  dom.window.sessionStorage.setItem("reach.face.fresh", "1");
  assert.equal(face.forgetIfFresh(), true);
  assert.equal(ls.getItem("reach.tailnet:p1"), null);
  assert.equal(ls.getItem("reach.tailnet:_current-profile"), null);
  assert.equal(ls.getItem(face.FACE_DEVICE), null);
  assert.equal(ls.getItem("reach.browser.devices"), null, "its saved computers were bound to the old device");
  assert.equal(face.forgetIfFresh(), false, "once");
});

test("the start page's Face ID flag is read strictly", () => {
  assert.equal(flow.parseStartConfig(CONFIG).faceId, true);
  for (const faceId of [false, "true", 1, null]) assert.equal(flow.parseStartConfig({ ...CONFIG, faceId }).faceId, undefined, String(faceId));
});

test("clean", () => assert.deepEqual(dom.errors, []));
