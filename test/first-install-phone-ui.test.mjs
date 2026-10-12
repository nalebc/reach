import test from "node:test";
import assert from "node:assert/strict";
import { firstInstall, finishFirstSetup } from "./helpers/first-install.mjs";
import { HOST } from "./helpers/fake-tailscale.mjs";
import { startDom, settle } from "./dom/harness.mjs";

const origin = `https://${HOST}`;
const agents = {
  iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1",
  Android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
};

// Actual first-install CLI and server, actual start.ts -> main.tsx ->
// ConnectForm -> device approval -> file bytes. Tailscale's external login,
// WASM node and network are the only connection stand-ins; the workspace
// after approval is omitted. This is DOM integration, not physical phones.
async function phone(t, reach, { platform, ip, browser = false, wrongAccount = false, adminApproval = false, wasmFails = false } = {}) {
  const dom = await startDom({ url: origin, fakes: { "src/App.tsx": "test/dom/fakes/onboarding-app.mjs" } });
  Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: agents[platform] });
  dom.document.body.innerHTML = '<main id="start"></main><div id="root"></div>';
  let peer;
  const calls = [], intervals = [];
  const waitFor = async check => {
    try { return await dom.waitFor(check); }
    catch (error) {
      error.message += `\nPhone: ${platform}, ${JSON.stringify({ browser, wrongAccount, adminApproval, wasmFails })}`;
      error.message += `\nPage: ${dom.document.body.textContent.slice(-3000)}`;
      error.message += `\nBrowser errors: ${JSON.stringify(dom.errors).slice(-6000)}`;
      error.message += `\nRecent requests: ${JSON.stringify(calls.slice(-10))}`;
      throw error;
    }
  };
  const interval = globalThis.setInterval;
  globalThis.setInterval = (...args) => { const id = interval(...args); intervals.push(id); return id; };
  globalThis.__onboardingPaired = value => { peer = value; };
  const request = async (url, init = {}, throughBrowser = false) => {
    const href = new URL(url instanceof Request ? url.url : url, origin);
    assert.equal(href.origin, origin, "no test traffic leaves the simulated computer");
    const headers = new Headers(init.headers);
    const result = await reach.request(href.pathname + href.search, {
      ip, public: browser && !throughBrowser, method: init.method,
      body: init.body ? JSON.parse(Buffer.from(init.body).toString()) : undefined,
      token: headers.get("Authorization")?.replace(/^Bearer /, ""),
    });
    calls.push({ path: href.pathname, status: result.status, throughBrowser });
    return result;
  };
  dom.window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, origin);
    // Loading/running Tailscale's compiled Go runtime is a separate native
    // integration; its public asset availability is covered by release tests.
    if (url.pathname.startsWith("/tailnet/")) return new Response("wasm");
    const result = await request(input, init);
    return new Response(result.data, { status: result.status, headers: result.headers });
  };
  globalThis.fetch = (...args) => dom.window.fetch(...args);
  const node = {
    current: { self: { state: "NoState" }, peers: [] },
    calls: [],
    start(cb) { this.cb = cb; },
    status() { return this.current; },
    login() { this.calls.push("login"); },
    logout() { this.calls.push("logout"); },
    wake() {},
    fetch({ url, method, headers, body }) {
      let sent = false;
      return {
        abort() {},
        response: request(url, { method, body, headers: Array.from({ length: headers.length / 2 }, (_, i) => headers.slice(i * 2, i * 2 + 2)) }, true).then(result => ({
          status: result.status, statusText: "", headers: Object.entries(result.headers).flat(),
          read: async () => { if (sent) return null; sent = true; return new Uint8Array(result.data); },
          cancel() { sent = true; },
        })),
      };
    },
  };
  const instantiate = WebAssembly.instantiateStreaming;
  if (browser) {
    const append = dom.document.head.append.bind(dom.document.head);
    dom.document.head.append = (...nodes) => {
      append(...nodes);
      for (const element of nodes) if (element.tagName === "SCRIPT") queueMicrotask(() => element.onload?.());
    };
    globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
    globalThis.reachTailnet = () => node;
    WebAssembly.instantiateStreaming = async response => {
      assert.equal((await response).status, 200);
      if (wasmFails) throw Error("WebAssembly blocked");
      return { instance: {} };
    };
  }
  t.after(async () => {
    await settle();
    // start.ts imports main itself. A failed rendering assertion must not
    // leave that root mounted just because we never reached dom.load(main).
    const mountedRoot = dom.loadedModule("/src/main.tsx")?.appRoot;
    if (mountedRoot) dom.update(() => mountedRoot.unmount());
    const rootEmpty = !dom.document.getElementById("root").hasChildNodes();
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = interval;
    WebAssembly.instantiateStreaming = instantiate;
    for (const key of ["Go", "reachTailnet", "__onboardingPaired", "__reachHomeOrigin"]) delete globalThis[key];
    await settle();
    await dom.close();
    assert.equal(rootEmpty, true, "the auto-imported root is unmounted before the next phone");
  });
  assert.equal(dom.loadedModule("/src/main.tsx"), undefined, "inspecting an unloaded entry must not evaluate it");
  assert.equal(dom.document.getElementById("root").hasChildNodes(), false);
  if (browser) {
    await dom.load("/src/start.ts");
    if (wasmFails) {
      await waitFor(() => /couldn’t start the secure connection/.test(dom.document.body.textContent));
      assert.match(dom.document.body.textContent, /Get the Tailscale app/);
      assert.equal(dom.loadedModule("/src/main.tsx"), undefined, "failed network setup never evaluates the workspace entry");
      return { dom, calls };
    }
    await waitFor(() => node.cb);
    node.cb.state("NeedsLogin");
    assert.match(dom.document.body.textContent, /Step 1 of 2/);
    assert.deepEqual(node.calls, ["login"]);
    node.cb.authURL("https://login.tailscale.com/a/phone-login");
    assert.equal(dom.document.querySelector(".start-action").href, "https://login.tailscale.com/a/phone-login");
    const appLink = dom.document.querySelector(".start-hint a").href;
    assert.match(appLink, platform === "iPhone" ? /apps.apple.com/ : /play.google.com/);
    if (wrongAccount) {
      node.current = { self: { state: "Running", login: "other@example.test" }, peers: [] };
      node.cb.state("Running");
      await waitFor(() => /This account can’t reach/.test(dom.document.body.textContent));
      assert.equal(calls.some(call => call.path === "/api/auth/requests"), false);
      dom.document.querySelector(".start-action").click();
      node.cb.state("NeedsLogin");
      assert.deepEqual(node.calls, ["login", "logout", "login"]);
    }
    if (adminApproval) {
      node.cb.state("NeedsMachineAuth");
      assert.match(dom.document.body.textContent, /Waiting for approval/);
      assert.equal(calls.some(call => call.path === "/api/auth/requests"), false);
    }
    node.current = { self: { state: "Running", login: "owner@example.test" }, peers: [{ dnsName: HOST + ".", online: true }] };
    node.cb.state("Running");
    await waitFor(() => dom.document.querySelector(".connect-flow"));
    await dom.load("/src/main.tsx");
    assert.match(dom.document.body.textContent, /Step 2 of 2/);
  } else await dom.load("/src/main.tsx");
  assert.equal(typeof dom.loadedModule("/src/main.tsx")?.appRoot?.unmount, "function", "cleanup can inspect the already evaluated workspace without importing it again");

  const code = await waitFor(() => dom.document.querySelector(".approval-code")?.textContent);
  assert.match(code, /^[a-f0-9]{8}$/);
  assert.equal(peer, undefined, "network sign-in alone cannot approve the phone");
  const locked = await fetch(origin + "/api/files/text?root=0&path=welcome.txt");
  assert.equal(locked.status, 401);
  reach.answer(code);
  await waitFor(() => peer?.token);
  const file = await fetch(origin + "/api/files/text?root=0&path=welcome.txt", { headers: { Authorization: `Bearer ${peer.token}` } });
  assert.equal(file.status, 200);
  assert.match(await file.text(), /First installation works/);
  assert.equal(calls.filter(call => call.path === "/api/auth/requests").length, 1, "StrictMode does not duplicate the approval request");
  assert.deepEqual(dom.errors, []);
  return { dom, calls, peer };
}

test("new user phone UI: iPhone and Android, app and browser setup through a real first installation", { skip: process.platform === "win32", timeout: 180000 }, async t => {
  const reach = await firstInstall(t);
  await finishFirstSetup(reach);
  let device = 50;
  for (const platform of Object.keys(agents)) {
    for (const scenario of [
      { name: "Tailscale app connected" },
      { name: "no Tailscale app", browser: true },
      { name: "Tailscale app off", browser: true },
      { name: "Tailscale app signed out", browser: true },
      { name: "Tailscale app on a different tailnet", browser: true },
      { name: "browser signed into a different account, then corrected", browser: true, wrongAccount: true },
      { name: "browser requires tailnet admin approval", browser: true, adminApproval: true },
      { name: "browser blocks WebAssembly, app fallback", browser: true, wasmFails: true },
    ]) await t.test(`${platform}: ${scenario.name}`, async t => {
      await reach.cli(["pair"]);
      await phone(t, reach, { platform, ip: `100.64.0.${device++}`, ...scenario });
    });
  }
});
