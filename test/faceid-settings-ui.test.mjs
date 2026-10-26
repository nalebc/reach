import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Settings → Face ID (for new browsers): what's set up, add this
// phone's, remove one (a lost phone). Only your own approved devices see it.
// Every tap shows something: the phone's own sheet, or one line saying why
// not (Oct 13: the owner's adds were refused for days, the button sometimes
// dead, with nothing said). Said in the device's own words.
let dom, React, FaceIdSettings, passkeys;
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const PIXEL =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const SAMSUNG =
  "Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const device = (ua, longSide = 844) => {
  Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: ua });
  Object.defineProperty(dom.window.screen, "width", { configurable: true, value: 390 });
  Object.defineProperty(dom.window.screen, "height", { configurable: true, value: longSide });
};
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  device(IPHONE);
  ({ FaceIdSettings } = await dom.load("/src/FaceIdSettings.tsx"));
  passkeys = await dom.load("/src/passkeys.ts");
});
after(async () => dom?.close());

const peer = { id: "a", name: "Mac A", url: "https://reach.test:8443", token: "T", platform: "darwin" };
const reply = (s, v) => new Response(JSON.stringify(v), { status: s, headers: { "Content-Type": "application/json" } });
// The computer, as Reach answers: one challenge per device at a time (a new
// one replaces the last), used once; `refuse` and `optionsRefused` say no.
function computer({ status = 200, keys = [], refuse = "", optionsRefused = null } = {}) {
  const log = [];
  let list = [...keys];
  let challenge = 0,
    current = null;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    log.push([method, u.pathname]);
    if (status !== 200) return reply(status, { error: "Only your own approved devices can manage Face ID." });
    if (u.pathname === "/api/auth/passkeys" && method === "GET") return reply(200, { passkeys: list });
    if (u.pathname === "/api/auth/passkeys/options") {
      if (optionsRefused) return reply(optionsRefused.status, { error: optionsRefused.error });
      current = Buffer.from(`c${++challenge}`).toString("base64url");
      return reply(200, { challenge: current, rp: { id: "reach.test", name: "Reach" }, user: { id: "dQ", name: "me", displayName: "me" }, pubKeyCredParams: [], excludeCredentials: list.map((k) => ({ type: "public-key", id: k.id })) });
    }
    if (u.pathname === "/api/auth/passkeys" && method === "POST") {
      const { credential } = JSON.parse(init.body);
      const answered = credential.response.clientDataJSON; // the challenge it was given
      const expected = current;
      current = null;
      if (refuse) return reply(401, { error: refuse });
      if (answered !== expected) return reply(401, { error: "That Face ID response is for an earlier attempt. Try again." });
      list.push({ id: "bmV3", label: "iPhone", createdAt: new Date().toISOString() });
      return reply(201, list.at(-1));
    }
    if (u.pathname.startsWith("/api/auth/passkeys/") && method === "DELETE") {
      list = list.filter((k) => `/api/auth/passkeys/${k.id}` !== u.pathname);
      return reply(200, { ok: true });
    }
    return reply(404, {});
  };
  const PKC = function () {};
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  globalThis.PublicKeyCredential = dom.window.PublicKeyCredential = PKC;
  const created = [];
  // The phone's sheet: answers for the challenge it was given (its bytes, as
  // clientDataJSON here), when the test says (`hold`), or as `fail` says.
  const sheet = { hold: false, fail: null, finish: null };
  Object.defineProperty(dom.window.navigator, "credentials", {
    configurable: true,
    value: {
      create: (o) => {
        created.push(o);
        const answer = () =>
          sheet.fail
            ? Promise.reject(sheet.fail)
            : Promise.resolve({ id: "bmV3", rawId: Uint8Array.of(1).buffer, type: "public-key", response: { clientDataJSON: o.publicKey.challenge.buffer, attestationObject: Uint8Array.of(2).buffer } });
        if (!sheet.hold) return answer();
        return new Promise((resolve) => (sheet.finish = () => resolve(answer())));
      },
    },
  });
  return { log, created, sheet };
}
const button = (c, text) => [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const tap = (el) => {
  assert.ok(el, "the button is there");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
};
const asked = (log) => log.filter(([, p]) => p === "/api/auth/passkeys/options").length;
const line = (c) => c.querySelector(".faceid-line")?.textContent || "";

test("lists Face ID set up here, checked; says what it does; removes one after you confirm", async () => {
  const { log } = computer({ keys: [{ id: "a2V5", label: "iPhone", createdAt: "2026-10-05T10:00:00Z", usedAt: "2026-10-05T11:00:00Z" }] });
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await settle(80);
  const c = view.container;
  assert.equal(c.querySelector("h2").textContent, "Face ID");
  assert.match(
    c.textContent,
    /Signs in your new browsers without a code at your Mac\./,
  );
  // One line only: approving agents with it is explained in Agents & people.
  assert.equal(c.querySelectorAll(".gs-foot:not(.faceid-line)").length, 1);
  assert.doesNotMatch(c.textContent, /approve agents/);
  assert.match(c.textContent, /iPhone\s*Last used Oct 5/);
  assert.ok(c.querySelector(".faceid-on"), "on: a green check");
  assert.ok(button(c, "Add Face ID on this iPhone"));
  dom.window.confirm = globalThis.confirm = () => false;
  tap(c.querySelector('[aria-label="Remove iPhone"]'));
  await settle(60);
  assert.ok(!log.some(([m]) => m === "DELETE"), "not without confirming");
  dom.window.confirm = globalThis.confirm = () => true;
  tap(c.querySelector('[aria-label="Remove iPhone"]'));
  await settle(80);
  assert.ok(log.some(([m, p]) => m === "DELETE" && p === "/api/auth/passkeys/a2V5"));
  assert.equal(c.querySelector('[aria-label="Remove iPhone"]'), null);
  await view.unmount();
});

test("add this phone's Face ID, straight from the tap: added today, checked, and the line says so", async () => {
  const { log, created } = computer();
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await dom.waitFor(() => asked(log) === 1);
  await settle(20);
  const c = view.container;
  tap(button(c, "Use Face ID"));
  assert.equal(created.length, 1, "called in the tap itself");
  await dom.waitFor(() => /Added\./.test(line(c)));
  assert.equal(line(c), "Added. New browsers of yours can sign in with Face ID now.");
  assert.match(c.textContent, /iPhone\s*Added today/);
  assert.ok(c.querySelector(".faceid-on"));
  assert.ok(log.some(([m, p]) => m === "POST" && p === "/api/auth/passkeys"));
  await view.unmount();
});

test("while Face ID is up, nothing asks for a new challenge: it would replace the one being answered (every add was refused this way)", async () => {
  const { log, created, sheet } = computer();
  sheet.hold = true;
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await dom.waitFor(() => asked(log) === 1);
  await settle(20);
  const c = view.container;
  tap(button(c, "Use Face ID"));
  assert.equal(created.length, 1);
  await settle(10);
  assert.equal(line(c), "Waiting for Face ID…");
  await settle(150);
  assert.equal(asked(log), 1, "no new challenge while Face ID is up");
  // A tap meanwhile says so; nothing else starts.
  tap(button(c, "Use Face ID"));
  assert.equal(created.length, 1);
  await settle(20);
  assert.equal(line(c), "Adding… one moment.");
  sheet.finish();
  await dom.waitFor(() => /Added\./.test(line(c)));
  // Then a fresh one, for a next tap: the computer used that one.
  await dom.waitFor(() => asked(log) === 2);
  await view.unmount();
});

test("a refused Face ID answer says the computer's reason (not \"pair again\"), and a fresh challenge follows", async () => {
  const { log } = computer({ refuse: "That Face ID response came from another page." });
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await dom.waitFor(() => asked(log) === 1);
  await settle(20);
  const c = view.container;
  tap(button(c, "Use Face ID"));
  await dom.waitFor(() => /another page/.test(line(c)));
  assert.equal(line(c), "That Face ID response came from another page.");
  assert.equal(c.querySelector(".faceid-line").getAttribute("role"), "alert");
  assert.doesNotMatch(c.textContent, /Pair this device again/);
  await dom.waitFor(() => asked(log) === 2);
  await view.unmount();
});

test("Face ID cancelled: said; already added: said", async () => {
  const { log, sheet } = computer();
  sheet.fail = Object.assign(new Error("x"), { name: "NotAllowedError" });
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await dom.waitFor(() => asked(log) === 1);
  await settle(20);
  const c = view.container;
  tap(button(c, "Use Face ID"));
  await dom.waitFor(() => /cancelled/.test(line(c)));
  assert.equal(line(c), "Face ID was cancelled or took too long.");
  await dom.waitFor(() => asked(log) === 2);
  await settle(20);
  sheet.fail = Object.assign(new Error("x"), { name: "InvalidStateError" });
  tap(button(c, "Use Face ID"));
  await dom.waitFor(() => /already added/.test(line(c)));
  assert.equal(line(c), "This iPhone's Face ID is already added.");
  await view.unmount();
});

test("a tap before the challenge arrives, or after it got old: says so, and the next tap works", async () => {
  const { log, created } = computer();
  // The challenge is slow to come.
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const served = dom.window.fetch;
  globalThis.fetch = dom.window.fetch = async (url, init) =>
    new URL(url).pathname === "/api/auth/passkeys/options" ? slow.then(() => served(url, init)) : served(url, init);
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await settle(60);
  const c = view.container;
  const add = button(c, "Use Face ID");
  assert.equal(add.disabled, false, "never a dead button");
  tap(add);
  await settle(10);
  assert.equal(line(c), "Getting Face ID ready. Tap again in a moment.");
  assert.equal(created.length, 0);
  release();
  await dom.waitFor(() => asked(log) === 1);
  await settle(20);
  // Two minutes on the page: the challenge is about to run out.
  const realNow = Date.now;
  Date.now = () => realNow() + 115000;
  try {
    tap(button(c, "Use Face ID"));
    assert.equal(created.length, 0, "not with the old challenge");
    await settle(10);
    assert.equal(line(c), "Renewed after a while on this page. Tap again.");
    await dom.waitFor(() => asked(log) === 2);
    await settle(20);
    tap(button(c, "Use Face ID"));
    assert.equal(created.length, 1);
    await dom.waitFor(() => /Added\./.test(line(c)));
  } finally {
    Date.now = realNow;
  }
  await view.unmount();
});

test("the computer won't give a challenge (too many tries, say): its reason is shown, and a tap asks again", async () => {
  const { log } = computer({ optionsRefused: { status: 429, error: "Too many tries to add Face ID. Wait 2 minutes, then try again." } });
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await dom.waitFor(() => asked(log) === 1);
  await settle(20);
  const c = view.container;
  assert.equal(line(c), "Face ID can't be added right now: Too many tries to add Face ID. Wait 2 minutes, then try again.");
  tap(button(c, "Use Face ID"));
  await settle(10);
  assert.match(line(c), /^Face ID can't be added right now: Too many tries.*Asking again; tap once more in a moment\.$/);
  await dom.waitFor(() => asked(log) === 2);
  await view.unmount();
});

test("in each device's own words: Android (Samsung too), Windows, a Mac", async () => {
  const cases = [
    [PIXEL, "Fingerprint or face unlock", "Use fingerprint or face unlock", "Add fingerprint or face unlock on this phone"],
    [SAMSUNG, "Fingerprint or face unlock", "Use fingerprint or face unlock", "Add fingerprint or face unlock on this phone"],
    [WINDOWS, "Windows Hello", "Use Windows Hello", "Add Windows Hello on this PC"],
    [MAC_SAFARI, "Touch ID", "Use Touch ID", `Add Touch ID on this ${"Mac"}`],
  ];
  try {
    for (const [ua, title, use, add] of cases) {
      device(ua, 0);
      for (const keys of [[], [{ id: "a2V5", label: "iPhone", createdAt: "2026-10-05T10:00:00Z" }]]) {
        computer({ keys });
        const view = await dom.render(React.createElement(FaceIdSettings, { peer: { ...peer, platform: "win32" } }));
        await settle(80);
        const c = view.container;
        assert.equal(c.querySelector("h2").textContent, title, ua);
        assert.ok(button(c, keys.length ? add : use), `${ua}: ${keys.length ? add : use}`);
        assert.match(c.textContent, /Signs in your new browsers without a code at your Windows PC\./, ua);
        await view.unmount();
      }
    }
  } finally {
    device(IPHONE);
  }
});

test("each platform's word, from its user agent, cautiously", () => {
  const word = (ua, more = {}) => passkeys.unlockWords({ ua, ...more }).word;
  assert.equal(word(IPHONE, { longSide: 844 }), "Face ID");
  assert.equal(word(IPHONE, { longSide: 667 }), "Touch ID", "an iPhone with a home button (SE)");
  assert.equal(word(IPHONE, { longSide: 0 }), "Face ID or Touch ID", "a screen that doesn't say");
  assert.equal(word("Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"), "Face ID or Touch ID");
  assert.equal(word(MAC_SAFARI, { touch: 5 }), "Face ID or Touch ID", "an iPad's Safari says it's a Mac");
  assert.equal(passkeys.unlockWords({ ua: MAC_SAFARI, touch: 5 }).device, "iPad");
  assert.equal(word(MAC_SAFARI, { touch: 0 }), "Touch ID");
  assert.equal(word(PIXEL), "fingerprint or face unlock");
  assert.equal(word(SAMSUNG), "fingerprint or face unlock");
  assert.equal(word(WINDOWS), "Windows Hello");
  assert.equal(word("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "your device's screen lock");
  assert.equal(word("Mozilla/5.0 (Mobile; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5"), "your phone's screen lock");
  assert.equal(passkeys.unlockWords({ ua: "Mozilla/5.0 (Mobile)" }).title, "Screen lock");
  assert.equal(passkeys.deviceLabel(WINDOWS, 0), "Windows PC");
  assert.equal(passkeys.deviceLabel(MAC_SAFARI, 5), "iPad");
  assert.equal(passkeys.deviceLabel(SAMSUNG, 5), "Android phone");
});

test("not your own approved device (a guest, another computer): nothing shown", async () => {
  computer({ status: 403 });
  const view = await dom.render(React.createElement(FaceIdSettings, { peer }));
  await settle(80);
  assert.equal(view.container.textContent, "");
  await view.unmount();
});

test("clean (no React warnings)", () => {
  assert.deepEqual(dom.errors, []);
});
