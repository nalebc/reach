import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// First-run matrix P7: what the Connect screen says at each turn, through the
// real src/ConnectForm.tsx: not on Tailscale yet, declined at the computer,
// the request expired or ended, the connection dropping while it waits.
let dom, React, ConnectForm;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ConnectForm = (await dom.load("/src/ConnectForm.tsx")).default;
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36",
  });
  const PKC = function () {};
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
  globalThis.PublicKeyCredential = dom.window.PublicKeyCredential = PKC;
});
after(async () => dom?.close());

const REQUEST = "11111111-2222-3333-4444-555555555555";
const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
// The computer: how it answers the method check and the request's polls.
function computer({ method = { method: "tailscale", eligible: true, login: "me@x.test" }, methodFails = false, polls = [], expiresIn = 300000 } = {}) {
  const asked = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    asked.push(u.pathname);
    if (u.pathname === "/api/auth/method") return methodFails ? Promise.reject(new TypeError("Load failed")) : reply(200, method);
    if (u.pathname === "/api/auth/requests") return reply(202, { id: REQUEST, secret: "s3cret", expiresAt: Date.now() + expiresIn, verification: "1A2B3C4D" });
    if (u.pathname === `/api/auth/requests/${REQUEST}`) {
      const next = polls.length > 1 ? polls.shift() : polls[0];
      if (next === "network") return Promise.reject(new TypeError("Load failed"));
      if (typeof next === "number") return reply(next, { error: next === 403 ? "This connection request expired or belongs to another device." : "Device access was revoked. Request approval again." });
      return reply(200, next || { status: "pending" });
    }
    return reply(404, { error: "no" });
  };
  return asked;
}
const render = async () => {
  dom.window.sessionStorage.clear();
  dom.window.localStorage.clear();
  const view = await dom.render(React.createElement(ConnectForm, { initialUrl: "https://reach.t.ts.net:8443", name: "Pixel", onPaired() {}, legacy: () => null }));
  return { view, c: view.container };
};
const button = (c, text) => [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const connect = async (c) => {
  const ready = await dom.waitFor(() => {
    const found = button(c, "Connect to this computer");
    return found && !found.disabled ? found : null;
  });
  ready.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(150);
};

test("not on Tailscale yet: the steps, with this phone's Tailscale app, and Check connection", async () => {
  computer({ methodFails: true });
  const { view, c } = await render();
  await settle(500);
  assert.match(c.textContent, /Connect your phone first/);
  assert.equal(
    [...c.querySelectorAll("a")].find((a) => /Install Tailscale/.test(a.textContent)).getAttribute("href"),
    "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
    "the app store for this phone",
  );
  assert.ok(button(c, "Check connection"));
  await view.unmount();
});

test("ready: who it's signed in as, and the code to type on the computer", async () => {
  computer();
  const { view, c } = await render();
  await settle(450);
  assert.match(c.textContent, /Signed in through Tailscale as me@x\.test/);
  await connect(c);
  assert.match(c.textContent, /Type this code in Reach on your computer/);
  assert.match(c.textContent, /1A2B3C4D/);
  // Said as that computer runs Reach (a checkout: ./reach; npm: reach).
  assert.match(c.textContent, /Run reach approve there/);
  await view.unmount();
});

test("a Windows PC's checkout: the approve hint says .\\reach.cmd, as its terminal does", async () => {
  computer({ method: { method: "tailscale", eligible: true, login: "me@x.test", command: ".\\reach.cmd" } });
  const { view, c } = await render();
  await settle(450);
  await connect(c);
  assert.match(c.textContent, /Run \.\\reach\.cmd approve there/);
  await view.unmount();
});

// Oct 14, the user journeys on GitHub's Windows runner: a PC that lets
// phones in with a pairing code told them to press Enter "in local mode",
// which it isn't, and named reach where its terminal says .\reach.cmd.
test("a Windows PC that takes pairing codes: its pairing form is told how that PC runs Reach", async () => {
  computer({ method: { method: "pairing", eligible: false, command: ".\\reach.cmd" } });
  dom.window.sessionStorage.clear();
  dom.window.localStorage.clear();
  const given = [];
  const view = await dom.render(
    React.createElement(ConnectForm, {
      initialUrl: "https://reach.t.ts.net:8443",
      name: "Pixel",
      onPaired() {},
      legacy: (url, command) => {
        given.push([url, command]);
        return React.createElement("p", null, `pair at ${url} with ${command}`);
      },
    }),
  );
  await dom.waitFor(() => given.length > 0, 3000);
  assert.deepEqual(given.at(-1), ["https://reach.t.ts.net:8443", ".\\reach.cmd"]);
  await view.unmount();
});

test("declined at the computer: says so plainly", async () => {
  computer({ polls: [{ status: "denied" }] });
  const { view, c } = await render();
  await connect(c);
  await dom.waitFor(() => /This computer declined the connection\./.test(c.textContent));
  await view.unmount();
});

test("the request ended (expired at the computer, or revoked): the computer's own words", async () => {
  computer({ polls: [403] });
  const { view, c } = await render();
  await connect(c);
  await dom.waitFor(() => /This connection request expired or belongs to another device\./.test(c.textContent));
  await view.unmount();
});

test("expired while waiting on the phone: Tap Connect to ask again", async () => {
  computer({ expiresIn: 200 });
  const { view, c } = await render();
  await connect(c);
  await dom.waitFor(() => /The request expired\. Tap Connect to request approval again\./.test(c.textContent), 4000);
  await view.unmount();
});

test("the connection drops while it waits: keeps the request and says it's reconnecting", async () => {
  // Keep the outage until its state has actually rendered. With an automatic
  // success on the next 1.5 s poll, a busy runner could observe only the
  // recovered state and miss the interruption entirely.
  const polls = ["network"];
  const asked = computer({ polls });
  const { view, c } = await render();
  await connect(c);
  await dom.waitFor(() => /Connection interrupted\. Reconnecting to your pending request…/.test(c.textContent));
  assert.match(c.textContent, /1A2B3C4D/, "the code is still there");
  const stored = () => JSON.parse(dom.window.sessionStorage.getItem("reach.pending:https://reach.t.ts.net:8443"));
  const original = stored();
  assert.equal(original.id, REQUEST);
  assert.equal(original.secret, "s3cret");

  const beforeRecovery = asked.filter((path) => path === `/api/auth/requests/${REQUEST}`).length;
  polls[0] = { status: "pending" };
  await dom.waitFor(() =>
    asked.filter((path) => path === `/api/auth/requests/${REQUEST}`).length > beforeRecovery &&
    !/Connection interrupted/.test(c.textContent),
  );
  assert.match(c.textContent, /1A2B3C4D/, "recovery keeps the same pending request");
  assert.deepEqual(stored(), original, "the request secret and expiry are not replaced");
  assert.equal(asked.filter((path) => path === "/api/auth/requests").length, 1, "recovery does not ask for another approval");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
